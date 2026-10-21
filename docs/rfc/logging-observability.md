# RFC: Unified Logging & Observability

## 问题

现在的日志散在各处，没有统一格式，没法端到端追踪：
- Server 用 `console.log/warn/error`，无结构
- Bridge 用 `this.log(msg)`，纯文本
- Launcher log pipe 在外面包了一层时间戳，但 server/bridge 自己不带
- 没有 correlation ID，一个用户请求经过 WS → handler → agent → bridge tool → bridge 执行，日志完全散的

## 设计目标

1. **统一格式**：所有组件输出一致的结构化日志
2. **端到端追踪**：correlation ID 从请求入口贯穿到 bridge 执行
3. **Level 语义清晰**：不同 level 控制详细程度
4. **低侵入**：不引入重依赖，保持 Node 生态简单

## 日志格式

每行一个 JSON 对象（JSON Lines），方便解析和搜索：

```json
{"ts":"2026-10-21T21:16:00.123+08:00","level":"info","mod":"handler","msg":"turn started","traceId":"tr_abc123","userId":"ul_xxx","sessionId":"session_xxx"}
{"ts":"2026-10-21T21:16:00.456+08:00","level":"debug","mod":"bridge-registry","msg":"call tools/call","traceId":"tr_abc123","deviceId":"F5Y2G6F2NR","tool":"exec"}
{"ts":"2026-10-21T21:16:01.789+08:00","level":"info","mod":"bridge-conn","msg":"tool_end","traceId":"tr_abc123","tool":"exec","durationMs":1333,"outcome":"ok"}
```

**字段：**
| 字段 | 说明 | 必填 |
|------|------|------|
| `ts` | ISO 8601 带时区 | ✓ |
| `level` | error/warn/info/debug/trace | ✓ |
| `mod` | 模块名 | ✓ |
| `msg` | 人类可读消息 | ✓ |
| `traceId` | 端到端追踪 ID | 有请求上下文时 |
| `userId` | 用户 ID | 有时 |
| `sessionId` | 会话 ID | 有时 |
| `deviceId` | Bridge 设备 ID | Bridge 相关时 |
| `durationMs` | 耗时 | 完成事件时 |
| `error` | 错误信息 | 出错时 |

## Level 定义

| Level | 什么时候用 | 生产环境默认 | 举例 |
|-------|----------|------------|------|
| **error** | 影响用户的故障，需要人工介入 | ✓ 始终 | provider 认证过期、DB 写入失败、bridge 持久化失败 |
| **warn** | 异常但系统自动恢复 | ✓ 始终 | bridge 重连、tool call 超时重试、rate limit 退避 |
| **info** | 关键业务事件，运营需要看 | ✓ 始终 | turn 开始/结束、bridge 注册/断连、recovery 触发、用户登录 |
| **debug** | 开发排查用的详细信息 | ✗ 按需开 | tool call 参数/结果、WS 消息内容、心跳 re-register |
| **trace** | 极细粒度，性能分析 | ✗ 按需开 | 每个 WS frame、token streaming、内存/CPU 快照 |

## Correlation ID（traceId）

### 生成时机
- **WS 消息进入 handler**：生成 `tr_<nanoid>` 绑定到这个 turn
- **Inbox enqueue**（recovery/cron/a2a）：生成 `tr_<nanoid>`
- **Bridge tool call**：server 把 traceId 放到 JSON-RPC request 的 `params._traceId` 里

### 传播路径
```
Client WS message
  → handler.ts: 生成 traceId, 绑到 turn context
    → agent turn: traceId 随 context 传递
      → tool execute: traceId 传入
        → bridge registry.call: traceId 放到 params._traceId
          → bridge connection: 收到 traceId, 本地日志带上
          → bridge tool.run: traceId 传入
        ← bridge response: traceId 原样返回
      ← tool result: 日志带 traceId
    ← turn end: 日志带 traceId
  → WS response: 日志带 traceId
```

### Channel 请求
```
Telegram/WeChat message
  → channel adapter: 生成 traceId
    → inbox enqueue: traceId 存到 message meta
      → idle-runner: 从 meta 取 traceId
        → handler/agent turn: 同上
```

## 模块清单 & 日志点

### Server（tianshu）

| 模块 | mod 名 | 关键日志点 |
|------|--------|-----------|
| WS handler | `ws` | 连接建立/关闭、identity resolution |
| Chat handler | `handler` | turn 开始/结束、abort、follow_up |
| Agent harness | `agent` | prompt 发送、stream 开始/结束、tool_call_start/end |
| Tool execution | `tool` | tool 调用、结果、耗时 |
| Session inbox | `inbox` | enqueue、drain、idle-runner 触发 |
| Recovery | `recovery` | interrupted 检测、cleanup、resume |
| Bridge registry | `bridge-reg` | register、unregister、stale、ghost 加载 |
| Bridge call | `bridge-call` | call 发送、settle、timeout、retry |
| Plugin system | `plugin` | 激活、失败、WS handler dispatch |
| Auth/identity | `auth` | 登录、token 验证、identity resolution |
| Channel adapter | `channel` | 消息收/发、adapter 错误 |

### Local Bridge

| 模块 | mod 名 | 关键日志点 |
|------|--------|-----------|
| Connection | `conn` | 连接、断连、重连、heartbeat |
| Tool execution | `tool` | tool_start、tool_end（含耗时/outcome） |
| MCP child | `mcp` | 子进程启动/退出 |

## 实现方案

### Logger 框架：pino

用 [pino](https://github.com/pinojs/pino)——Node 生态最快的 JSON logger：
- 原生 JSON Lines 输出
- `child()` 继承上下文字段
- 极低开销（序列化在单独 worker thread）
- 零编译依赖（纯 JS）
- 5 级日志（trace/debug/info/warn/error/fatal）
- `pino-pretty` 开发模式人类友好输出

安装：
```bash
# server
cd packages/server && npm i pino pino-pretty
# local-bridge
cd ~/git/local-bridge && npm i pino pino-pretty
# plugin-sdk（plugins 通过 sdk 间接使用）
cd packages/plugin-sdk && npm i pino
```

### Logger 封装

```typescript
// packages/server/src/core/logger.ts
import pino from "pino";

const transport = process.env.LOG_FORMAT === "text"
  ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" } }
  : undefined; // default: JSON Lines to stdout

export const rootLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport,
  // Rename pino's default fields to match our RFC
  timestamp: pino.stdTimeFunctions.isoTime, // "time" → ISO string
  messageKey: "msg",
  // Base fields on every log line
  base: { pid: undefined, hostname: undefined }, // strip noise
});

/** Create a module-scoped logger. */
export function createLogger(mod: string) {
  return rootLogger.child({ mod });
}

// Re-export pino types
export type Logger = pino.Logger;
```

### 使用方式

```typescript
// handler.ts
import { createLogger } from "../core/logger.js";
const log = createLogger("handler");

// Turn 开始 — child logger 自动带 cid/userId/sessionId
const cid = `cid_${nanoid(12)}`;
const turnLog = log.child({ cid, userId, sessionId: session.id });
turnLog.info("turn started");
turnLog.info({ kind: "user_prompt", modelId }, "processing prompt");

// Tool call — 嵌套 child
const toolLog = turnLog.child({ tool: toolName });
toolLog.debug({ args: rawArgs }, "tool execute");
toolLog.info({ durationMs: 1200, outcome: "ok" }, "tool done");

// Turn 结束
turnLog.info({ durationMs: Date.now() - startedAt, toolCalls: 3 }, "turn ended");
```

输出（JSON Lines）：
```json
{"level":30,"time":"2026-10-21T21:16:00.123+08:00","mod":"handler","cid":"cid_abc123","userId":"ul_xxx","sessionId":"session_xxx","msg":"turn started"}
{"level":30,"time":"2026-10-21T21:16:01.456+08:00","mod":"handler","cid":"cid_abc123","tool":"exec","durationMs":1200,"outcome":"ok","msg":"tool done"}
```

开发模式（`LOG_FORMAT=text`）：
```
21:16:00.123 INFO  (handler) turn started cid=cid_abc123 userId=ul_xxx
21:16:01.456 INFO  (handler/exec) tool done durationMs=1200 outcome=ok
```

### Bridge 端

```typescript
// local-bridge/src/logger.ts
import pino from "pino";

export const rootLogger = pino({
  level: process.env.BRIDGE_LOG_LEVEL || "info",
  transport: process.env.LOG_FORMAT === "text"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
  base: { pid: undefined, hostname: undefined },
});

export function createLogger(mod: string) {
  return rootLogger.child({ mod });
}
```

```typescript
// connection.ts — 替换 this.log()
const log = createLogger("conn");

// heartbeat
log.debug("heartbeat re-register");
// dead link
log.warn({ silentFor: 65000 }, "dead link detected, forcing reconnect");
// tool call（带 server 传来的 cid）
log.info({ cid, tool: name, durationMs, outcome: "ok" }, "tool_end");
```

### Plugin SDK 适配

`ctx.log` 底层换成 pino child logger：

```typescript
// plugin-sdk/src/context.ts
import type { Logger } from "pino";

export interface PluginContext {
  log: Logger; // 之前是 { info, warn, error }，pino 完全兼容
  // ...
}
```

已经用 `ctx.log.info/warn/error` 的插件（workboard 50、messenger 39、openshell 33 等）**零改动自动升级**。
只有用裸 `console.log` 的 4 个插件需要手动迁移（reverse-mcp、wiki、microsandbox、messenger）。

### Launcher log viewer 适配

JSON Lines 格式让 log.html 的解析变得确定性：
- 每行 `JSON.parse` → 拿到 `ts`、`level`、`mod`、`msg`、`traceId`
- 搜索可以按 `traceId` 过滤，一键看完整请求链路
- Level 过滤直接用 `level` 字段，不用猜

### 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `LOG_LEVEL` | `info` | 全局日志级别 |
| `LOG_FORMAT` | `json` | `json` 或 `text`（开发友好） |
| `BRIDGE_LOG_LEVEL` | `info` | Bridge 专用（已有） |

### text 格式（开发用）

`LOG_FORMAT=text` 时输出人类友好格式：
```
21:16:00.123 INFO  [handler] turn started traceId=tr_abc123 userId=ul_xxx
21:16:01.789 WARN  [bridge-call] timeout tool=exec traceId=tr_abc123 durationMs=60000
```

## 迁移计划

### Phase 1: Logger 基础设施
- [ ] 写 `packages/server/src/core/logger.ts`
- [ ] 写 `local-bridge/src/logger.ts`（同一套，copy 或 shared package）
- [ ] Launcher log viewer 支持 JSON Lines 解析

### Phase 2: Server 关键路径
- [ ] handler.ts: turn 生命周期 + traceId 生成
- [ ] bridge registry/call: 注册、调用、stale
- [ ] session-inbox: enqueue/drain
- [ ] recover-interrupted: recovery 流程

### Phase 3: Bridge 关键路径
- [ ] connection.ts: 连接、心跳、重连
- [ ] tool execution: start/end/duration
- [ ] traceId 传播: 从 params._traceId 提取

### Phase 4: 全面覆盖
- [ ] plugin system、auth、channel adapters
- [ ] 去掉所有裸 console.log/warn/error
- [ ] LOG_FORMAT=text 开发模式

## 不做的事

- **不引入 ELK/Grafana**：当前规模不需要，JSON Lines + grep/jq 够用
- **不做分布式 tracing**：没有微服务，单进程内 traceId 够了
- **不做日志轮转**：Launcher 已经 truncate-on-start，暂时够用
