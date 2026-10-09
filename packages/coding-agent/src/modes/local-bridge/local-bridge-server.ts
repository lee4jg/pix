/**
 * Local bridge server — HTTP endpoint for external prompt injection (Feishu bridge).
 *
 * Runs alongside interactive (TUI) mode so the same pi session serves both
 * the local terminal and the external bridge.
 *
 * Endpoints:
 *   GET  /health      — health check (200, body not parsed by the bridge)
 *   POST /prompt      — inject a prompt via JSON { message: "..." }, returns SSE
 *   POST /abort       — abort the current agent operation
 *   GET  /events      — persistent SSE of ALL session events, tagged by source
 *                       ("bridge" = from /prompt, "cli" = from terminal)
 *   POST /ui-response — submit a response to a bridge UI request (select/input)
 *
 * The TUI renders responses for both sources automatically through its own
 * session subscription.
 *
 * Security: binds to 127.0.0.1 only, no authentication. Any local process can
 * inject prompts into the session. Same trust model as the ompX bridge.
 *
 * Wire-format contract with the compiled omp-feishu-bridge client:
 * - /prompt SSE `message_update` must carry the full cumulative `message`
 *   (do NOT route events through toJsonEvent, which strips it).
 * - /events entries are serialized as `{ source, ...event }`.
 */

import * as crypto from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";

/** Minimum session surface the bridge server needs. */
export type BridgeSession = Pick<AgentSession, "prompt" | "abort" | "subscribe"> & {
	readonly isStreaming: boolean;
};

export interface LocalBridgeServerOptions {
	port: number; // 0 = ephemeral port (tests)
	getSession: () => BridgeSession;
	log?: (msg: string) => void;
}

export interface BridgeUIRequest {
	id: string;
	/** Resolves with the user's answer, or undefined on timeout/cancel. */
	result: Promise<string | undefined>;
}

export interface LocalBridgeServer {
	/** The actually bound port (differs from options.port when 0 was requested). */
	readonly port: number;
	/** Re-point the /events broadcast at a new session (after new_session/fork/switch). */
	attachSession(session: BridgeSession): void;
	requestSelect(title: string, options: string[], timeoutMs?: number): BridgeUIRequest;
	requestInput(title: string, placeholder?: string, timeoutMs?: number): BridgeUIRequest;
	/** Drop a pending UI request whose local (TUI) counterpart already answered. */
	cancelUIRequest(id: string): void;
	/** Idempotent. Closes the listener and all open SSE connections. */
	stop(): void;
}

const SSE_HEADERS: Record<string, string> = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
};

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_UI_TIMEOUT_MS = 60_000;

type PendingUIRequest = {
	resolve: (value: string | undefined) => void;
	timer: ReturnType<typeof setTimeout>;
};

/** Start the bridge server on 127.0.0.1:port. Rejects if the port cannot be bound. */
export async function startLocalBridgeServer(options: LocalBridgeServerOptions): Promise<LocalBridgeServer> {
	const log = options.log ?? ((msg: string) => console.error(msg));

	// Events from the session subscriber are tagged "bridge" while a /prompt
	// injection is in flight, "cli" otherwise, so the bridge can mirror only
	// terminal-side turns on /events.
	let bridgePromptInFlight = false;

	const eventClients = new Set<http.ServerResponse>();
	const pendingUIRequests = new Map<string, PendingUIRequest>();

	let session = options.getSession();
	let broadcastUnsubscribe: (() => void) | undefined;

	function broadcast(data: object): void {
		const payload = `data: ${JSON.stringify(data)}\n\n`;
		for (const res of eventClients) {
			try {
				res.write(payload);
			} catch {
				eventClients.delete(res);
			}
		}
	}

	function attachSession(next: BridgeSession): void {
		broadcastUnsubscribe?.();
		session = next;
		broadcastUnsubscribe = next.subscribe((event: AgentSessionEvent) => {
			broadcast({ source: bridgePromptInFlight ? "bridge" : "cli", ...event });
		});
	}
	attachSession(session);

	function registerUIRequest(
		method: "select" | "input",
		request: object,
		timeoutMs: number | undefined,
	): BridgeUIRequest {
		const id = crypto.randomUUID();
		let resolve!: (value: string | undefined) => void;
		const result = new Promise<string | undefined>((res) => {
			resolve = res;
		});
		const timer = setTimeout(() => {
			pendingUIRequests.delete(id);
			log(`[bridge-server] UI request ${id} timed out (${method})`);
			resolve(undefined);
		}, timeoutMs ?? DEFAULT_UI_TIMEOUT_MS);
		pendingUIRequests.set(id, { resolve, timer });

		broadcast({ type: "extension_ui_request", id, method, ...request, timeout: timeoutMs });
		return { id, result };
	}

	function resolveUIRequest(id: string, value: string | undefined): void {
		const pending = pendingUIRequests.get(id);
		if (!pending) return;
		pendingUIRequests.delete(id);
		clearTimeout(pending.timer);
		pending.resolve(value);
	}

	// ── HTTP server ──────────────────────────────────────────────────

	const server = http.createServer((req, res) => {
		void routeRequest(req, res);
	});
	// Long-lived SSE connections must not be killed by Node's default
	// 300s requestTimeout / 64s headersTimeout (same trap as Bun's
	// idleTimeout in the ompX original).
	server.requestTimeout = 0;
	server.headersTimeout = 0;

	async function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = req.method ?? "GET";

		if (method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
			return;
		}

		if (method === "GET" && url.pathname === "/events") {
			handleEvents(res);
			return;
		}

		if (method === "POST" && url.pathname === "/prompt") {
			await handlePrompt(req, res);
			return;
		}

		if (method === "POST" && url.pathname === "/abort") {
			log("[bridge-server] abort request received from bridge");
			await session.abort();
			writeJson(res, 200, { aborted: true });
			return;
		}

		if (method === "POST" && url.pathname === "/ui-response") {
			handleUIResponse(req, res);
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not Found");
	}

	function writeJson(res: http.ServerResponse, status: number, body: object): void {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(body));
	}

	async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of req) {
			total += (chunk as Buffer).length;
			if (total > MAX_BODY_BYTES) return undefined;
			chunks.push(chunk as Buffer);
		}
		try {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			return undefined;
		} catch {
			return undefined;
		}
	}

	// ── Handlers ─────────────────────────────────────────────────────

	function handleEvents(res: http.ServerResponse): void {
		res.writeHead(200, SSE_HEADERS);
		res.write(`data: ${JSON.stringify({ source: "system", type: "connected" })}\n\n`);
		log(`[bridge-server] /events client connected (total: ${eventClients.size + 1})`);
		eventClients.add(res);
		res.on("close", () => {
			if (eventClients.delete(res)) {
				log(`[bridge-server] /events client disconnected (remaining: ${eventClients.size})`);
			}
		});
	}

	function handleUIResponse(req: http.IncomingMessage, res: http.ServerResponse): void {
		void (async () => {
			const body = await readJsonBody(req);
			if (!body) {
				writeJson(res, 400, { error: "invalid JSON" });
				return;
			}
			const id = body.id;
			if (typeof id !== "string" || !pendingUIRequests.has(id)) {
				writeJson(res, 400, { error: "unknown or missing id" });
				return;
			}
			if (body.cancelled === true) {
				log(`[bridge-server] UI request ${id} cancelled by bridge`);
				resolveUIRequest(id, undefined);
			} else if (typeof body.value === "string") {
				log(`[bridge-server] UI request ${id} resolved: value="${body.value}"`);
				resolveUIRequest(id, body.value);
			} else {
				resolveUIRequest(id, undefined);
			}
			writeJson(res, 200, { status: "ok" });
		})();
	}

	async function handlePrompt(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await readJsonBody(req);
		if (!body) {
			writeJson(res, 400, { error: "invalid JSON" });
			return;
		}
		const text = body.message;
		if (typeof text !== "string" || text.trim().length === 0) {
			writeJson(res, 400, { error: "message must be a non-empty string" });
			return;
		}

		// Same busy semantics as ompX: reject while the agent is running or a
		// bridge prompt is in flight. pi's own queueing (streamingBehavior) is
		// not exercised by the bridge protocol.
		if (bridgePromptInFlight || session.isStreaming) {
			writeJson(res, 409, { error: "busy" });
			return;
		}

		res.writeHead(200, SSE_HEADERS);
		// Flush headers immediately so the client's fetch() resolves before the
		// first event (Bun's Response streaming flushed eagerly; Node does not).
		res.flushHeaders();
		let active = true;
		let unsubscribe: (() => void) | undefined;

		const write = (data: object): void => {
			if (!active) return;
			try {
				res.write(`data: ${JSON.stringify(data)}\n\n`);
			} catch {
				active = false;
			}
		};

		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			switch (event.type) {
				case "agent_start":
				case "agent_end":
				case "turn_start":
				case "turn_end":
					write({ type: event.type });
					return;
				case "message_start":
				case "message_end":
					write({ type: event.type, message: event.message });
					return;
				case "message_update":
					// Full cumulative message required by the bridge streaming cards.
					write({
						type: "message_update",
						message: event.message,
						assistantMessageEvent: event.assistantMessageEvent,
					});
					return;
			}
		});

		const finish = (): void => {
			bridgePromptInFlight = false;
			unsubscribe?.();
			unsubscribe = undefined;
			if (active) {
				active = false;
				res.end();
			}
		};

		// Client disconnect stops forwarding only; the prompt runs to
		// completion and renders in the TUI (ompX cancel semantics).
		res.on("close", () => {
			if (bridgePromptInFlight) {
				unsubscribe?.();
				unsubscribe = undefined;
				active = false;
			}
		});

		bridgePromptInFlight = true;
		try {
			await session.prompt(text, { source: "bridge" });
			finish();
		} catch (err) {
			const message = err instanceof Error ? (err.message ?? String(err)) : String(err);
			write({ type: "error", error: message });
			finish();
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const boundPort = (server.address() as AddressInfo).port;
	log(`[bridge-server] listening on 127.0.0.1:${boundPort}`);

	let stopped = false;

	return {
		port: boundPort,
		attachSession,
		requestSelect(title, options, timeoutMs) {
			return registerUIRequest("select", { title, options: options.map((label) => ({ label })) }, timeoutMs);
		},
		requestInput(title, placeholder, timeoutMs) {
			return registerUIRequest("input", { title, placeholder }, timeoutMs);
		},
		cancelUIRequest(id) {
			const pending = pendingUIRequests.get(id);
			if (!pending) return;
			pendingUIRequests.delete(id);
			clearTimeout(pending.timer);
		},
		stop() {
			if (stopped) return;
			stopped = true;
			broadcastUnsubscribe?.();
			broadcastUnsubscribe = undefined;
			for (const [, pending] of pendingUIRequests) clearTimeout(pending.timer);
			pendingUIRequests.clear();
			for (const res of eventClients) {
				try {
					res.end();
				} catch {
					// ignore
				}
			}
			eventClients.clear();
			server.closeAllConnections();
			server.close();
		},
	};
}
