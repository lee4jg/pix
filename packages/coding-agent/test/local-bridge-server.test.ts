import { describe, expect, test } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	type BridgeSession,
	type LocalBridgeServer,
	startLocalBridgeServer,
} from "../src/modes/local-bridge/local-bridge-server.ts";

type SseEvent = Record<string, unknown>;

type FakeSession = BridgeSession & {
	emit(event: AgentSessionEvent): void;
	promptCalls: Array<{ text: string; source?: string }>;
	settle(err?: string): void;
	listenerCount(): number;
	abortCount(): number;
	isStreaming: boolean;
};

function createFakeSession() {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const promptCalls: Array<{ text: string; source?: string }> = [];
	let abortCount = 0;
	let settlePrompt: (err?: Error) => void = () => {};

	const session = {
		isStreaming: false,
		promptCalls,
		abortCount: () => abortCount,
		subscribe(listener: (event: AgentSessionEvent) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		emit(event: AgentSessionEvent): void {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
		listenerCount(): number {
			return listeners.size;
		},
		async prompt(text: string, options?: { source?: string }): Promise<void> {
			promptCalls.push({ text, source: options?.source });
			session.isStreaming = true;
			await new Promise<void>((resolve, reject) => {
				settlePrompt = (err?: Error) => (err ? reject(err) : resolve());
			});
			session.isStreaming = false;
		},
		async abort(): Promise<void> {
			abortCount++;
			settlePrompt(new Error("aborted"));
		},
		settle(text?: string): void {
			if (text) settlePrompt(new Error(text));
			else settlePrompt();
		},
	} as unknown as FakeSession;
	return session;
}

async function startWith(sessionRef: { current: FakeSession }): Promise<{ server: LocalBridgeServer; url: string }> {
	const server = await startLocalBridgeServer({
		port: 0,
		getSession: () => sessionRef.current,
		log: () => {},
	});
	return { server, url: `http://127.0.0.1:${server.port}` };
}

/** Parse a fully-consumed SSE body into events. */
function parseSse(body: string): SseEvent[] {
	return body
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data: "))
		.map((chunk) => JSON.parse(chunk.slice(6).trim()) as SseEvent);
}

/** Incremental SSE reader for never-closing streams like /events. */
function createSseReader(res: Response) {
	const reader = res.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	return async (timeoutMs = 2000): Promise<SseEvent> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const idx = buffer.indexOf("\n\n");
			if (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);
				if (chunk.startsWith("data: ")) {
					return JSON.parse(chunk.slice(6).trim()) as SseEvent;
				}
				continue;
			}
			if (Date.now() > deadline) throw new Error("SSE read timed out");
			const remaining = deadline - Date.now();
			const { done, value } = await Promise.race([
				reader.read(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("SSE read timed out")), Math.max(remaining, 1)),
				),
			]);
			if (done) throw new Error("SSE stream closed");
			buffer += decoder.decode(value, { stream: true });
		}
	};
}

const textMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 };
const assistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "partial" }],
	usage: {},
	stopReason: "stop",
};

describe("local bridge server", () => {
	test("GET /health returns 200", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const res = await fetch(`${url}/health`);
			expect(res.status).toBe(200);
		} finally {
			server.stop();
		}
	});

	test("POST /prompt streams events with full cumulative message_update", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const responsePromise = fetch(`${url}/prompt`, {
				method: "POST",
				body: JSON.stringify({ message: "hello" }),
			});

			// Wait until the fake session sees the prompt call, then emit events.
			while (ref.current.promptCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
			expect(ref.current.promptCalls[0]).toEqual({ text: "hello", source: "bridge" });
			ref.current.emit({ type: "agent_start" } as AgentSessionEvent);
			ref.current.emit({ type: "message_start", message: textMessage } as unknown as AgentSessionEvent);
			ref.current.emit({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta" },
			} as unknown as AgentSessionEvent);
			ref.current.emit({ type: "message_end", message: assistantMessage } as unknown as AgentSessionEvent);
			ref.current.emit({ type: "agent_end", messages: [], willRetry: false } as AgentSessionEvent);
			ref.current.settle();

			const res = await responsePromise;
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/event-stream");
			const events = parseSse(await res.text());
			expect(events.map((e) => e.type)).toEqual([
				"agent_start",
				"message_start",
				"message_update",
				"message_end",
				"agent_end",
			]);
			// Core wire contract: message_update keeps the full cumulative message.
			expect((events[2].message as { content: unknown[] }).content).toHaveLength(1);
		} finally {
			server.stop();
		}
	});

	test("POST /prompt reports preflight failures as error event", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const res = await fetch(`${url}/prompt`, { method: "POST", body: JSON.stringify({ message: "hello" }) });
			while (ref.current.promptCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
			ref.current.settle("no model selected");
			const events = parseSse(await res.text());
			expect(events).toEqual([{ type: "error", error: "no model selected" }]);
		} finally {
			server.stop();
		}
	});

	test("POST /prompt returns 409 while a prompt is in flight", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const first = fetch(`${url}/prompt`, { method: "POST", body: JSON.stringify({ message: "hello" }) });
			while (ref.current.promptCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
			const second = await fetch(`${url}/prompt`, { method: "POST", body: JSON.stringify({ message: "again" }) });
			expect(second.status).toBe(409);
			ref.current.settle();
			await first;
		} finally {
			server.stop();
		}
	});

	test("POST /prompt validates body", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const badJson = await fetch(`${url}/prompt`, { method: "POST", body: "{" });
			expect(badJson.status).toBe(400);
			const empty = await fetch(`${url}/prompt`, { method: "POST", body: JSON.stringify({ message: "  " }) });
			expect(empty.status).toBe(400);
		} finally {
			server.stop();
		}
	});

	test("/events tags sources and survives attachSession rebind", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const res = await fetch(`${url}/events`);
			const next = createSseReader(res);
			expect(await next()).toEqual({ source: "system", type: "connected" });

			// Idle event -> tagged cli
			ref.current.emit({ type: "turn_start" } as AgentSessionEvent);
			expect(await next()).toMatchObject({ source: "cli", type: "turn_start" });

			// During a bridge prompt -> tagged bridge
			const promptPromise = fetch(`${url}/prompt`, { method: "POST", body: JSON.stringify({ message: "hi" }) });
			while (ref.current.promptCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
			ref.current.emit({ type: "turn_start" } as AgentSessionEvent);
			expect(await next()).toMatchObject({ source: "bridge", type: "turn_start" });
			ref.current.settle();
			// Draining the body guarantees the server ran finish() (flag reset
			// happens before res.end()), so later events are tagged "cli".
			await (await promptPromise).text();

			// Rebind to a new session: old events stop, new events flow on the same connection
			const old = ref.current;
			ref.current = createFakeSession();
			server.attachSession(ref.current);
			old.emit({ type: "turn_end" } as AgentSessionEvent);
			ref.current.emit({ type: "turn_start" } as AgentSessionEvent);
			const event = await next();
			expect(event).toMatchObject({ source: "cli", type: "turn_start" });
		} finally {
			server.stop();
		}
	});

	test("POST /abort calls session abort", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const res = await fetch(`${url}/abort`, { method: "POST" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ aborted: true });
			expect(ref.current.abortCount()).toBe(1);
		} finally {
			server.stop();
		}
	});

	test("UI request round-trip via /events and /ui-response", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const res = await fetch(`${url}/events`);
			const next = createSseReader(res);
			await next(); // connected

			const request = server.requestSelect("Pick", ["a", "b"]);
			const uiEvent = await next();
			expect(uiEvent).toMatchObject({ type: "extension_ui_request", method: "select", title: "Pick" });
			expect(uiEvent.options).toEqual([{ label: "a" }, { label: "b" }]);
			const id = uiEvent.id as string;

			const post = await fetch(`${url}/ui-response`, { method: "POST", body: JSON.stringify({ id, value: "a" }) });
			expect(post.status).toBe(200);
			expect(await request.result).toBe("a");
		} finally {
			server.stop();
		}
	});

	test("UI request cancelled resolves undefined; unknown ids are rejected", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const unknown = await fetch(`${url}/ui-response`, { method: "POST", body: JSON.stringify({ id: "unknown" }) });
			expect(unknown.status).toBe(400);

			const request = server.requestInput("Name", "your name");
			const cancelled = await fetch(`${url}/ui-response`, {
				method: "POST",
				body: JSON.stringify({ id: request.id, cancelled: true }),
			});
			expect(cancelled.status).toBe(200);
			expect(await request.result).toBeUndefined();

			const replay = await fetch(`${url}/ui-response`, { method: "POST", body: JSON.stringify({ id: request.id }) });
			expect(replay.status).toBe(400);
		} finally {
			server.stop();
		}
	});

	test("UI request times out to undefined; cancelUIRequest drops pending", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		try {
			const request = server.requestSelect("Pick", ["a"], 50);
			expect(await request.result).toBeUndefined();

			const request2 = server.requestSelect("Pick", ["a"]);
			server.cancelUIRequest(request2.id);
			const res = await fetch(`${url}/ui-response`, {
				method: "POST",
				body: JSON.stringify({ id: request2.id, value: "a" }),
			});
			expect(res.status).toBe(400);
		} finally {
			server.stop();
		}
	});

	test("stop is idempotent and closes event streams", async () => {
		const ref = { current: createFakeSession() };
		const { server, url } = await startWith(ref);
		const res = await fetch(`${url}/events`);
		const next = createSseReader(res);
		await next();
		server.stop();
		server.stop();
		await expect(next()).rejects.toThrow();
	});
});
