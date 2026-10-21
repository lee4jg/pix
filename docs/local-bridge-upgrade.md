# 飞书桥（local-bridge）上游升级指南

本 fork 在 pi 上叠加了一套飞书桥：`--local-bridge-port` 启动一个 127.0.0.1 上的 HTTP/SSE 服务，供外部桥客户端（`~/pi-feishu-bridge/config.json` → `connectUrl: http://127.0.0.1:9102`）注入 prompt、拉取事件、应答 TUI 弹窗。

本文记录把 fork 升到新上游时保住这套桥的流程。方法论借鉴 `~/feishu-omp-bridge/docs/oh-my-pi-upgrade-guide.md` 与 `~/feishu-omp-bridge/oh-my-pi-18.8.6-upgrade.md`。

## 当前基线

| 项 | 值 |
|---|---|
| fork 基线（上一轮升级后） | `60c329cea`（`@earendil-works/pi-coding-agent` 1.1.0，上游 `b9ab918c6` = v1.0.3） |
| 上游 | `earendil-works/pi` `main`，本地 clone 在 `~/org_pi` |
| 本轮升级到的上游 | `16f5f0af4`，195 commits（包版本 1.1.0 → 1.3.0）。本地 remote 名 `upstream-local` 指向 `~/org_pi` |
| 桥的客户端 | `~/pi-feishu-bridge/config.json`（`connectUrl` 模式，不 spawn 二进制） |

升级后 fork 的包版本是 `@earendil-works/pi-coding-agent` 1.3.0（`pi --version` 输出与上游 git tag 不是同一套号）。

桥的代码全在 fork 侧，上游从未有过 `local-bridge` 目录，`InputSource` 上游仍是 `"interactive" | "rpc" | "extension"` 三值。

## 一、桥的改动清单（KEEP 集合）

**fork-only（上游没有，原样加回）：**

| 文件 | 行数 | 说明 |
|---|---|---|
| `packages/coding-agent/src/modes/local-bridge/local-bridge-server.ts` | 386 | HTTP 服务本体：`/health` `/prompt` `/abort` `/events` `/ui-response` |
| `packages/coding-agent/test/local-bridge-server.test.ts` | 336 | 11 个用例 |

> 这两个文件自 `bd85b0f33` 起已 **tracked**（初稿时是 untracked，风险见下）。若将来再新增 fork-only 文件，升级前先 `git add` 提交或 `cp` 到仓库外备份 —— untracked 文件在 `git checkout`/`reset` 类操作里不会被保护。

**present-upstream（需要 3-way 合并）：**

| 文件 | 我方 delta |
|---|---|
| `src/cli/args.ts` | `Args.localBridgePort` 字段 + `--local-bridge-port` 解析（校验 1–65535）+ help 文本一行 |
| `src/main.ts` | `startLocalBridgeServer` 接线；非 interactive 模式打 warning；启动失败 `exit(1)`；把 `localBridge` 传给 `InteractiveMode` |
| `src/modes/index.ts` | re-export `startLocalBridgeServer` / `LocalBridgeServer` |
| `src/modes/interactive/interactive-mode.ts` | `localBridge` option；`rebindCurrentSession` 里 `attachSession`；`stop()` 里 `localBridge.stop()`；`raceDialogWithBridge` + 三个 `showExtension*WithBridge` 包装（把 TUI 弹窗与桥的 select/input 竞速）；`showExtensionEditor` 加 `signal` 形参 |
| `src/core/extensions/types.ts` | `InputSource` 加 `"bridge"` |
| `test/args.test.ts` | `--local-bridge-port` 四个用例 |
| `test/auth-storage.test.ts` | 与桥无关：把 coalesced-reload 用例的 `"new"` 改成 `"new-key"`（同尺寸 in-place 重写在粗 mtime 文件系统上与旧内容不可区分） |

合计 7 个 present-upstream 文件，fork delta 共 +201/-8。

## 二、标准升级流程

pi 是普通 monorepo（不是 subtree），所以**不需要** `patches/` + `merge-file` 那套；桥的改动直接以普通 git commit 落在 fork 分支上，`git merge upstream/main` 即可。但先做下面的预判，能省掉一次失败的 merge。

### 步骤 0：备份与基线检查

```bash
cd ~/pi
git status --porcelain          # 桥文件若是 untracked，先提交或备份到仓库外
git branch backup/bridge-$(git rev-parse --short HEAD)
```

记下 `BASE=$(git rev-parse HEAD)`，后面所有 3-way 都以它为 base。

### 步骤 1：拉上游并算出 KEEP 集合

```bash
git fetch origin main
git fetch --no-tags ~/org_pi main     # 本地上游 clone；或直接用 origin/main
git diff --numstat $BASE..FETCH_HEAD -- <bridge 文件>
```

### 步骤 2：预判冲突面（关键一步，别跳过）

对每个 present-upstream 文件，把 **fork delta 的 base 坐标行段** 与 **上游 churn 的 base 坐标行段** 求交集。行坐标要统一到 base 侧：hunk 头 `@@ -o,oc +n,nc @@` 取 `o..o+oc-1`；`oc == 0` 的纯插入 hunk 退化成锚点 `o`。留 3–5 行容差，因为上游在文件头的插入会把所有下游行号推走。

```bash
# 每个文件跑一次，输出 near-N 计数；全 0 即零冲突预判
# 见本文第四节脚本
```

实测结论（`d5629e204` → `b9ab918c6`）：

| 文件 | fork hunk | 上游 hunk | 相交 |
|---|---|---|---|
| `interactive-mode.ts` | 12 | 142 | 0 |
| `core/extensions/types.ts` | 1 | 39 | 0 |
| `cli/args.ts` | 3 | 5 | 1（fork @140 纯插入 vs 上游 @142 `--models` 过滤空 pattern；不同分支，3-way 分得开） |
| `main.ts` | 4 | 3 | 1（fork @66 import 区 vs 上游 @64 插入 `loadMcpCommand`；同一 import 块，3-way 分得开） |
| `modes/index.ts` | 1 | 0 | 0 |
| `test/args.test.ts` | 1 | 1 | 0 |
| `test/auth-storage.test.ts` | 3 | 0 | 0 |

### 步骤 3：3-way 合并（验证用，不落工作区）

在合并前先证明能合干净。pi 是普通 monorepo，本轮实测 `git merge` 直接零冲突 —— 预判的价值在于**提前知道会是零冲突**，出问题时才有对照。用 `git merge-file -p` 干跑，结果写仓库外：

```bash
for f in <7 个 present-upstream 文件>; do
  git show $BASE:$f > /tmp/3way/$(basename $f).base
  git show $UPSTREAM:$f > /tmp/3way/$(basename $f).theirs
  cp "$f" /tmp/3way/$(basename $f).ours
  git merge-file -p /tmp/3way/*.ours /tmp/3way/*.base /tmp/3way/*.theirs \
    > /tmp/3way/*.merged && echo "CLEAN $f" || echo "CONFLICT $f"
done
```

判零冲突之外，还要验**语义没被合坏**。逐项 grep merged 结果：

- `cli_args.ts.merged`：`local-bridge-port` 解析在；上游的 `mcp <command>` help 行、`--tui-mode` 默认值翻转也在
- `main.ts.merged`：`loadMcpCommand` / `runMcpCommand` 与 `startLocalBridgeServer` / `localBridge,` 同时在
- `interactive-mode.ts.merged`：`raceDialogWithBridge`、`attachSession`、`localBridge?.stop()`、`showExtensionEditor(..., signal?)` 同时在

最后做 delta 等价校验：`diff(merged, theirs)` 与 `diff(ours, base)` 的增删行数应逐文件相等（相等即 fork 补丁零漂移，只平移未变形）。本轮 7/7 相等。

### 步骤 4：真正合并

```bash
git remote add upstream-local ~/org_pi     # 本地上游 clone；已有 origin 就直接用它
git fetch --no-tags upstream-local main
git merge upstream-local/main
# 冲突时：只解自己改过的文件；桥的两个 fork-only 文件用 checkout/手动加回
git add packages/coding-agent/src/modes/local-bridge/
git commit
```

**坑：`git merge-file` 只改工作区、不 stage。** 若用 `merge-file` 手工三方合并，`git commit`（不带 `-a`）会丢掉全部桥补丁。commit 前 `git status` 确认桥文件在暂存区里。

### 步骤 5：跟上上游的仓库结构变化

这一轮（0.87.1 → 1.0.3）上游动了根配置，桥不受影响但构建会红：

| 变化 | 处理 |
|---|---|
| `packages/session-backends/` 删除 | 从 `workspaces` 移除（上游已移除）；本地若引用其构建脚本需清 |
| 新增 `packages/codemode`、`packages/mcp` | 加入 `build` / `build:offline` 链（上游已加） |
| `npm-shrinkwrap.json` + `generate-coding-agent-shrinkwrap.mjs` 删除（`581e7ba78`） | 本 fork 仍 track 着 shrinkwrap 且 `check:shrinkwrap` 还在 `check` 链里 → 删掉该脚本调用与文件；`AGENTS.md` 里提到该脚本的段落也要删 |
| `tsgo --noEmit` → `tsc --noEmit`，`typescript` 升到 7.0.2，移除 `@typescript/native-preview` | 跟上游；桥的代码是 erasable TS，不受影响 |
| `build:binary` 入口点变化 | 上游改为 `./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts` |
| `pi` 二进制 | `build:binary` 输出在 `packages/coding-agent/dist/pi`（不在 `binaries/`，那个目录是下载的官方发行包缓存），本地产物，升级后需重新构建 |

merge 本身会把这些都自动处理掉（`package.json` 的 `workspaces`/`check` 链、`AGENTS.md` 的 shrinkwrap 段落、shrinkwrap 文件与脚本都是上游直接覆盖/删除）。**要自己动手的是数据生成和 Rust 侧：**

```bash
# 模型数据是 gitignore 的生成物（.gitignore:11 → packages/ai/src/providers/data/）。
# 上游新增 provider（如 azure）后本地没有对应 data/*.json，tsc 会报几十个
# "Type 'unknown' does not satisfy the constraint 'ModelGroups'" 和
# "'gpt-4o-mini' is not assignable to parameter of type 'never'"。
# 根因不是类型回归，是 data 缺失。
#
# 首选：从固定 catalog revision 复现 Nix 构建的 data（确定性，与上游测试的模型 id 一致）。
# 上游源码里的测试硬编码了 pin 里的模型 id，实时目录会漂移出差异
# （本轮实时 models.dev 已下线 gpt-5-mini / claude-opus-4.7 / Kimi-K2.6，
#  而 nix/model-catalog.json 的旧 pin 缺 nvidia/nemotron-3.5-super-vl-120b-a12b）。
npm run update:model-catalog-pin    # 拉实时目录、校验能 hydrate 本 checkout，写 nix/model-catalog.json
# 再按新 pin 的字节 hydrate 本地 data（hydrate 不会由上一条命令代做，它只更新 pin）：
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { hydrateModelCatalogBytes } from "./scripts/update-model-catalog-pin.mjs";
  const rev = JSON.parse(readFileSync("nix/model-catalog.json", "utf8")).revision;
  const res = await fetch(`https://pi.dev/api/models/revisions/${rev}?types=chat,image,classifier`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  hydrateModelCatalogBytes(process.cwd(), Buffer.from(await res.arrayBuffer()));
' 2>&1 | tail -2                      # 需 NODE_OPTIONS=--dns-result-order=ipv4first；.ts 导入依赖 Node 24 strip-types
npm run generate:models               # 备选：抓实时 models.dev，仅当 pin 也拿不到时用；可能让 tsc 与上游测试脱节

# packages/env 是上游新增的 Rust workspace，测试前必须先建 daemon
npm run build:daemon --workspace packages/env   # cargo build --manifest-path daemon/Cargo.toml --locked
```

本环境 Node 的 `fetch` 走 IPv6 会 `ETIMEDOUT`（`internalConnectMultiple`），curl 正常。所有联网的生成/下载命令加
`NODE_OPTIONS=--dns-result-order=ipv4first`。

`packages/coding-agent/binaries/`（gitignore 的官方发行包下载缓存）里的旧 `package.json` 会让
`npm run check` 的 `check:pinned-deps` 报 `must be pinned, found ^0.87.1`——清掉或移出仓库，上游 CI 是干净 clone 所以不会碰到。

`build:binary` 会先跑 `npm --prefix ../ai run build`（联网重生成模型数据）。数据已按 pin hydrate 过时，
直接执行其中的 bun 步骤更快也更可靠：

```bash
cd packages/coding-agent
bun build --compile --no-compile-autoload-bunfig --no-compile-autoload-dotenv \
  ./dist/bun/cli.js ./src/utils/image-resize-worker.ts ./src/extensions/codemode/worker.ts \
  --outfile dist/pi && npm run copy-binary-assets
```

顺序照 CI（`.github/workflows/ci.yml`）：`npm ci --ignore-scripts` → `npm run build` → `npm run check` → `npm run build:daemon --workspace packages/env` → `npm test`。`generate:models` 已包含在 `packages/ai` 的 `build` 里。

### 步骤 6：验证门禁

```bash
# 1. 桥的单元测试（不依赖任何 provider API/key）
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  packages/coding-agent/test/local-bridge-server.test.ts
# 期望：11 passed

# 2. 参数解析
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run \
  packages/coding-agent/test/args.test.ts

# 3. 类型 + lint（桥文件在 src/ 内，tsc 会覆盖）
npm run check

# 4. 全量非 e2e 测试
./test.sh
```

端到端（`--local-bridge-port` 只在 interactive 模式生效，需要真 TTY；用 `pty.openpty()` 起进程即可）：

```bash
npm --prefix packages/coding-agent run build:binary
./packages/coding-agent/dist/pi --local-bridge-port 9399   # 另开 pty
# 另一个终端
curl -s localhost:9399/health                              # => ok
curl -sN localhost:9399/events | head -1                   # => text/event-stream
curl -s -XPOST localhost:9399/prompt -d '{"message":""}'   # => 400 {"error":"message must be a non-empty string"}
# 然后让 ~/pi-feishu-bridge 指向 http://127.0.0.1:9399，发一条消息验证卡片流式
```

验收要点：

- [ ] `local-bridge-server.test.ts` 11 passed
- [ ] `args.test.ts` 全绿（含 4 个 `--local-bridge-port` 用例）
- [ ] `npm run check` 零 error/warning
- [ ] `./test.sh` 绿
- [ ] `pi --local-bridge-port <port>` 起来后 `/health` 返回 `ok`、`/events` 是 `text/event-stream`、`/prompt` 空 body 返回 400
- [ ] 飞书消息能注入 prompt 并收到流式卡片（验证 `/prompt` 的 `message_update` 携带完整累积 `message`）
- [ ] 桥发起 select/input 时 TUI 弹窗同步出现，两侧任一应答另一侧收敛（验证 `raceDialogWithBridge`）
- [ ] `/new` 或 fork 切会话后 `/events` 仍推流（验证 `attachSession`）

## 三、桥侧的固有约束（改代码时别破坏）

这些不是 fork 差异，是桥与 pi 会话之间的契约：

1. **`/prompt` 的 `message_update` 必须携带完整累积 `message`。** 不要把事件过 `toJsonEvent` —— 它会剥掉 `message`，桥的流式卡片会空。
2. **忙时返回 409，不排队。** `bridgePromptInFlight || session.isStreaming` 时直接 409。pi 自己的 `streamingBehavior` 队列不被桥协议使用。
3. **客户端断开只停止转发，prompt 继续跑完并在 TUI 渲染**（ompX cancel 语义）。
4. **`InputSource` 的 `"bridge"` 必须留着。** 桥用它把消息标记为非 TUI 来源；`session_turn_source` 会读它。
5. **桥的弹窗竞速里，桥超时/cancel 返回 `undefined` 不算答案**，本地弹窗继续等；桥先答则 abort 本地，本地先答则 `cancelUIRequest` 掉桥的请求。
6. **只绑 127.0.0.1，无鉴权。** 任何本地进程都能注入 prompt —— 与 ompX 桥同一信任模型，不要暴露到非 loopback。
7. **`stop()` 必须幂等**，且 `interactive-mode.ts` 的 `stop()` 里要调 `localBridge.stop()`，否则进程退出时 SSE 连接泄漏。
8. **对 `this.options` 的访问要容忍它不存在。** 上游的回归测试用 `InteractiveMode.prototype.rebindCurrentSession.call(bareStub)` 直接调私有方法，stub 对象上没有 `options` 字段。桥在 `rebindCurrentSession` / `stop` 里读 `this.options.localBridge` 时写成 `this.options?.localBridge?.`，否则这些测试会以 `TypeError: Cannot read properties of undefined (reading 'localBridge')` 挂掉 —— 而且挂的是**上游**的测试，看起来像升级引入的回归。

## 四、辅助脚本

冲突预判（步骤 2）：

```js
// /tmp/overlap.mjs — 用法: node /tmp/overlap.mjs <base> <upstream>
import { execSync } from "node:child_process";
const [base, up] = process.argv.slice(2);
const files = [
	"packages/coding-agent/src/cli/args.ts",
	"packages/coding-agent/src/core/extensions/types.ts",
	"packages/coding-agent/src/main.ts",
	"packages/coding-agent/src/modes/index.ts",
	"packages/coding-agent/src/modes/interactive/interactive-mode.ts",
	"packages/coding-agent/test/args.test.ts",
	"packages/coding-agent/test/auth-storage.test.ts",
];
// 两侧都取 base 坐标：@@ -o,oc +n,nc @@ => o..o+oc-1；oc===0 退化为锚点 o
function hunks(spec) {
	const out = [];
	for (const m of spec.matchAll(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/g)) {
		const oc = m[2] === undefined ? 1 : Number(m[2]);
		const o = Number(m[1]);
		out.push({ s: o, e: oc === 0 ? o : o + oc - 1 });
	}
	return out;
}
const TOL = 5; // 行位移容差
for (const f of files) {
	const F = hunks(execSync(`git diff -U0 -- ${f}`, { encoding: "utf8" }));
	const U = hunks(execSync(`git diff -U0 ${base} ${up} -- ${f}`, { encoding: "utf8" }));
	const near = F.filter((h) => U.some((u) => h.s - TOL <= u.e && u.s <= h.e + TOL));
	console.log(`${f}  fork=${F.length} up=${U.length} near=${near.length}`, JSON.stringify(near));
}
```

delta 等价校验（步骤 3 末）：

```bash
# 逐文件：两者应相等
diff -u X.merged X.theirs | grep -c '^+[^+]'   # 期望 == diff -u X.ours X.base 的 '^+[^+]' 计数
diff -u X.merged X.theirs | grep -c '^-[^-]'   # 期望 == diff -u X.ours X.base 的 '^-[^-]' 计数
```

## 五、常见问题排查

| 现象 | 原因 | 处理 |
|---|---|---|
| merge "成功"但桥功能消失 | `merge-file` 结果未 stage，commit 时丢失 | `git status` 确认桥文件在暂存区；重做该文件合并 |
| `local-bridge-server.test.ts` 编译失败（`AgentSessionEvent` 类型不匹配） | 上游给事件联合加了成员 | 对照 `git show $UPSTREAM:packages/coding-agent/src/core/agent-session.ts` 的事件联合；桥只 switch 6 个类型，其余走 default 忽略 |
| `--local-bridge-port` 启动但 `/health` 连不上 | 二进制没重新构建，或 fork-only 文件没进构建产物 | `npm run build:binary` 后重试；确认 `src/modes/local-bridge/` 在仓库里（不是只在 untracked 且被 checkout 清掉） |
| 飞书卡片空转 / 无流式 | 事件被过 `toJsonEvent`，`message` 被剥 | 见第三节约束 1 |
| 飞书能发消息但 pi 无反应 | 桥起在非 interactive 模式 | `--local-bridge-port` 只在 interactive 生效，其他模式只打 warning |
| 会话切换后 `/events` 断流 | `rebindCurrentSession` 没重新 attach | 该函数是 `attachSession` 的唯一调用点，检查它没被上游重命名/搬家 |
| `tsc` 报几十个 `Type 'unknown' does not satisfy 'ModelGroups'` / `'x' is not assignable to 'never'` | `packages/ai/src/providers/data/*.json` 是 gitignore 的生成物，上游新增 provider 后本地缺对应文件 | `npm run generate:models`；不是类型回归 |
| `./test.sh` 里 `packages/env` 5 个 suite 报 `Build the daemon first` | 上游新增的 Rust workspace，daemon 未构建 | `npm run build:daemon --workspace packages/env` |
| `./test.sh` 里 `openai-chatgpt-oauth.test.ts` 报 `Port 1455 is in use` | 本机有并发 pi 登录占着 OAuth 回调端口 | 无关代码；关掉占用进程后重跑该文件 |
| 上游新加的回归测试报 `Cannot read properties of undefined (reading 'localBridge')` | 桥在私有方法里读 `this.options.localBridge`，而上游测试用 bare prototype stub 调用该方法 | 见第三节约束 8；改成 `this.options?.localBridge?.` |
| `check:pinned-deps` 报 `binaries/.../package.json: must be pinned, found ^0.87.1` | `packages/coding-agent/binaries/` 是 gitignore 的旧发行包缓存，该检查会遍历全仓库 package.json | 把该目录移出仓库（或重下当前版本），不是代码问题 |
| `tsc` 报某些模型 id `is not assignable to` 联合类型（且 `packages/ai` 与上游零差异） | 本地 data 与上游期望的 catalog revision 不一致：实时 models.dev 已下线这些 id，或 pin 比上游测试旧 | 按步骤 5 用 `update:model-catalog-pin` + hydrate 从 pin 重建 data，别用实时 `generate:models` |
| `npm run generate:models` / `build:binary` 里 `[TypeError: fetch failed] ETIMEDOUT` | Node 的 DNS 排序走了不可达的 IPv6（curl 同一 URL 正常） | `NODE_OPTIONS=--dns-result-order=ipv4first`；`build:binary` 可只跑 bun 步骤 |
| `./test.sh` 每次挂在不同用例（`worker-lifetime`、`compaction`），单跑全绿 | 20 核并发下计时敏感用例的资源抖动 | 单跑确认后整体重跑；不是升级引入的回归 |

## 六、版本历史

| fork 基线 | 上游 | 结果 | 备注 |
|---|---|---|---|
| `d5629e204`（0.87.1） | `b9ab918c6`（1.0.3） | `git merge` 零冲突；7/7 present-upstream 补丁零漂移 | 2026-10-09 实测。`npm run check` exit 0；`./test.sh` exit 0；`/health` → `ok`、`/events` → `text/event-stream`、`/prompt` 空 body → 400。修复一处桥的 `this.options` 兼容（见约束 8） |
| `60c329cea`（1.1.0） | `16f5f0af4`（1.3.0，195 commits） | 6/7 文件自动合并零冲突；`interactive-mode.ts` 3 块冲突，手工解 | 2026-10-21 实测。上游 `38847563f` 把弹窗改成栈式（`pushExtensionDialog`/`removeExtensionDialog`，删掉 `hideExtensionEditor` 与 `extensionEditor` 字段），与桥的 `showExtensionEditor(..., signal?)` 同区冲突。解法：保留上游结构，把 `signal` 重新接进 `finish()`（`onAbort = () => finish(undefined)`、`finish` 里 `removeEventListener` + `removeExtensionDialog(editor)`），删掉我方 `hideExtensionEditor` 副本。delta 等价 7/7 成立（`interactive-mode.ts` +102/-4 vs 原 +106/-4，差 4 行正是不再需要带回 `hideExtensionEditor`）。`npm run check` exit 0；`./test.sh` exit 0；桥 11 passed、args 96 passed；`dist/pi --local-bridge-port 9399` → `/health` `ok`、`/events` `text/event-stream`、`/prompt` 空 body 400。另需 `update:model-catalog-pin` bump（tracked）与移走 `binaries/` 旧缓存 |
