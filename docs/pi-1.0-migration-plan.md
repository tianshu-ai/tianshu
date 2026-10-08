# pi-agent-core 1.0 迁移方案

## 变更概览

pi-agent-core 从 0.87.1 升到 1.0.0，删掉了整个 `harness/` 层（~1069 行类型），替换为精简的 `Agent` class（~136 行类型）。

### 架构对比

| 维度 | 旧 (0.87) | 新 (1.0) |
|---|---|---|
| 编排 | `AgentHarness` + `AgentLane` | `Agent` class |
| 状态 | 外部 `Session` + `Storage` 接口 | 内存 `AgentState`（messages 数组） |
| 上下文传递 | `Context`（来自 @earendil-works/chord） | `AbortSignal`（原生） |
| 事件 | `HarnessEvent`（30+ 子类型） | `AgentEvent`（10 子类型） |
| 压缩 | 内置 `compact()` + `estimateContextTokens` + `shouldCompact` | 无（应用层自己管） |
| 持久化 | `Storage` 接口 → `StorageBackedSession` | 无（Agent 状态在内存里） |
| 工具 | `AgentHarnessTool` | `AgentTool`（基本相同） |
| 依赖 | chord, pi-telemetry, pi-ai | 仅 pi-ai + typebox |

### 删除的符号（tianshu 用到的 40 个）

**编排层（替换为 Agent）**
- `AgentHarness`, `AgentLane`, `HarnessEvent`
- `Context`, `BACKGROUND_CONTEXT`, `withAbortSignal`

**持久化层（tianshu 需自建）**
- `Session`, `SessionRepo`, `SessionMetadata`, `Storage`, `StorageBackedSession`
- `Entry`, `MessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `NewEntry`
- `EntryStructure`, `EntryScan`, `StorageBranchScan`, `SessionStats`
- `CommitResult`, `Write`, `ForkOptions`
- `StoredValue`, `Value`, `ValueList`, `ListElement`, `ListReadOptions`
- `UsageRow`, `UsageScan`

**压缩层（tianshu 需内化）**
- `CompactionSettings`, `CompactResult`, `CompactionPreparation`
- `DEFAULT_COMPACTION_SETTINGS`, `estimateContextTokens`, `shouldCompact`

**工具/执行层**
- `ExecutionEnv`, `ExecutionError`, `FileError`, `Result`

---

## 影响面

94 个 tsc 错误，10 个文件：

| 文件 | 错误数 | 改动性质 |
|---|---|---|
| `sqlite-storage.ts` | 21 | **持久化核心**：实现旧 `Storage` 接口。保留实现，改为本地接口 |
| `handler.ts` | 17 | **编排核心**：创建 Harness/Lane，run prompt。需重写为 Agent |
| `sqlite-session-repo.ts` | 15 | **持久化核心**：实现旧 `SessionRepo`。保留实现，改为本地接口 |
| `compact-decision.ts` | 10 | **压缩决策**：用旧压缩函数。需内化 |
| `agent-loop.ts` | 10 | **Worker 编排**：Worker 的 AgentHarness 使用。需重写为 Agent |
| `stub-execution-env.ts` | 6 | **工具执行环境**：ExecutionEnv/Error 类。需本地定义 |
| `host-tools.ts` | 5 | **宿主工具**：引用 Harness/Lane/Context 类型。改类型引用 |
| `structured-compaction.ts` | 4 | **结构化压缩 hook**：挂载到 Harness 的压缩事件。需重写 |
| `sqlite-session-storage.ts` | 3 | **会话存储辅助**：引用 Session/Context/Entry。改类型引用 |
| `active-harnesses.ts` | 3 | **活跃会话注册表**：存 Harness/Lane/Context 引用。改类型 |

---

## 迁移策略（分 4 阶段）

### 阶段 1：本地化持久化层类型（不改运行时逻辑）

**目标**：让 tianshu 的 SQLite 持久化代码不再依赖 pi-agent-core 的 Session/Storage 类型。

**做法**：
1. 创建 `packages/server/src/chat/pi-compat/session-types.ts`
2. 从旧版 0.87.1 复制以下接口定义（纯类型，无运行时代码）：
   - `Entry`, `MessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `NewEntry`, `EntryBase`
   - `Storage`, `Session`, `SessionRepo`, `SessionMetadata`, `SessionStats`
   - `CommitResult`, `Write`, `ForkOptions`, `EntryScan`, `EntryStructure`, `StorageBranchScan`
   - `StoredValue`, `Value`, `ValueList`, `ListElement`, `ListReadOptions`, `UsageRow`, `UsageScan`
3. 更新 `sqlite-storage.ts`, `sqlite-session-repo.ts`, `sqlite-session-storage.ts` 的 import 指向本地类型

**影响文件**：sqlite-storage.ts, sqlite-session-repo.ts, sqlite-session-storage.ts
**预期修复**：~39 个错误
**风险**：低——纯类型移动，运行时行为不变

### 阶段 2：本地化 Context + 压缩 + 执行环境

**目标**：把 chord 依赖和压缩函数内化。

**做法**：

**2a. Context 替代方案**

旧 `Context` 是 chord 的 Go-style context（cancellation + values + telemetry）。tianshu 实际使用模式：
- 作为不透明令牌传递给 pi 方法
- `BACKGROUND_CONTEXT` 用于无用户上下文时
- `withAbortSignal(signal, context)` 用于附加取消信号

**迁移方案**：定义本地 `Context` 为 `{ signal?: AbortSignal }`，`BACKGROUND_CONTEXT = {}`，`withAbortSignal = (signal, _ctx) => ({ signal })`。这覆盖了 tianshu 的实际使用场景（chord 的 telemetry 和 value propagation tianshu 不用）。

**2b. 压缩函数内化**

从旧版复制以下到 `packages/server/src/chat/pi-compat/compaction.ts`：
- `CompactionSettings` 接口
- `DEFAULT_COMPACTION_SETTINGS` 常量
- `estimateContextTokens()` 函数
- `shouldCompact()` 函数
- `CompactResult`, `CompactionPreparation` 接口

这些函数逻辑简单（token 估算 + 阈值判断），无外部依赖，可以直接复制。

**2c. ExecutionEnv 内化**

`ExecutionEnv`, `ExecutionError`, `FileError`, `Result` 只在 `stub-execution-env.ts` 里用。从旧版复制类型定义和类实现到本地。

**影响文件**：compact-decision.ts, structured-compaction.ts, stub-execution-env.ts, host-tools.ts, active-harnesses.ts
**预期修复**：~28 个错误
**风险**：中——压缩函数复制需要验证行为一致

### 阶段 3：编排层重写（核心）

**目标**：把 AgentHarness + AgentLane 替换为新的 Agent class。

这是最大最复杂的阶段。涉及 `handler.ts` 和 `agent-loop.ts` 的核心编排逻辑。

**旧编排流程（handler.ts）**：
```
SessionRepo.open(metadata, context)     // 打开会话
  → AgentHarness.create(options, context) // 创建 harness
  → harness.lane("main", context)         // 获取 lane
  → lane.prompt(text, images, context)    // 发起对话
  → harness.events.on("message_end", ...)  // 监听事件
  → harness.close(context)                // 关闭
```

**新编排流程**：
```
new Agent({                             // 创建 agent
  initialState: { messages, tools, ... },
  streamFn: Models.streamSimple,
  beforeToolCall, afterToolCall,
  finishTurn, prepareRequest,
})
agent.subscribe((event) => ...)          // 监听事件
agent.prompt(messages)                   // 发起对话
agent.followUp(message)                  // 追加消息
agent.abort()                            // 取消
agent.waitForIdle()                      // 等待完成
```

**关键差异和迁移点**：

| 旧 | 新 | 迁移方案 |
|---|---|---|
| `AgentHarness.create(opts, ctx)` | `new Agent(opts)` | 重写 handler.ts 的 harness 创建逻辑 |
| `harness.lane("main", ctx)` | 不需要（Agent 自己管） | 删除 lane 获取代码 |
| `lane.prompt(text, images, ctx)` | `agent.prompt(messages)` | 改调用方式 |
| `lane.followUp(msg, undefined, ctx)` | `agent.followUp(msg)` | 简化调用 |
| `lane.abort(ctx)` | `agent.abort()` | 简化调用 |
| `lane.waitForIdle(ctx)` | `agent.waitForIdle()` | 简化调用 |
| `lane.compact(opts, ctx)` | 无——需自己实现 | 用阶段 2 内化的压缩函数 |
| `lane.getActiveTools(ctx)` | `agent.state.tools` | 直接读 state |
| `lane.setActiveTools(names, ctx)` | `agent.state.tools = [...]` | 直接写 state |
| `lane.getModel(ctx)` | `agent.state.model` | 直接读 state |
| `lane.setModel(model, ctx)` | `agent.state.model = model` | 直接写 state |
| `lane.findEntries(query, ctx)` | 无——tianshu 的 SQLite 直接查 | 改用 SqliteStorage 直接查询 |
| `harness.events.on(type, listener)` | `agent.subscribe(listener)` | 改事件订阅方式 |
| `HarnessEvent` 30+ 子类型 | `AgentEvent` 10 子类型 | 重新映射事件处理 |

**持久化桥接（关键设计决策）**：

旧架构：Agent 状态通过 Storage 接口自动持久化到 SQLite。
新架构：Agent 状态在内存里（`agent.state.messages`），不自动持久化。

**方案**：在 Agent 的 event subscriber 里手动同步到 SQLite：
```typescript
agent.subscribe(async (event) => {
  if (event.type === "message_end") {
    // 写入 SQLite messages 表
    sqliteStorage.appendMessage(event.message, sessionId);
  }
  if (event.type === "agent_end") {
    // 同步最终状态
    sqliteStorage.syncState(agent.state, sessionId);
  }
});
```

启动时从 SQLite 恢复状态到 Agent：
```typescript
const messages = sqliteStorage.loadMessages(sessionId);
const agent = new Agent({
  initialState: { messages, systemPrompt, model, tools },
  ...
});
```

**active-harnesses.ts 改造**：
```typescript
// 旧：存 { harness, lane, context }
// 新：存 { agent, sessionId }
```

**影响文件**：handler.ts, agent-loop.ts, active-harnesses.ts
**预期修复**：~30 个错误
**风险**：高——核心编排重写，需要充分测试

### 阶段 4：StorageBackedSession 替代

**目标**：让 SqliteSessionRepo 不再依赖 `StorageBackedSession`。

旧做法：`SqliteSessionRepo.create()` 返回 `StorageBackedSession(sqliteStorage)`。Harness 通过 `Session` 接口读写持久化状态。

新做法：Agent 不需要 Session 接口。SqliteSessionRepo 变成纯粹的 CRUD 管理器（创建/删除/列出 session 行），不再需要返回 `Session` 对象。tianshu 自己的 SqliteStorage 直接被 handler.ts 调用来 load/save messages。

**影响文件**：sqlite-session-repo.ts
**预期修复**：~15 个错误
**风险**：中——需要确保 session fork/branch 功能不丢失

---

## 事件映射

| 旧 HarnessEvent | 新 AgentEvent | 备注 |
|---|---|---|
| `run_start` | `agent_start` | |
| `run_end` | `agent_end` | 少了 fromTipId/tipId |
| `turn_start` | `turn_start` | 少了 runId/turnId |
| `turn_end` | `turn_end` | 少了 runId/turnId |
| `message_start` | `message_start` | |
| `message_update` | `message_update` | 字段名变了 |
| `message_end` | `message_end` | |
| `tool_start` | `tool_execution_start` | |
| `tool_update` | `tool_execution_update` | |
| `tool_end` | `tool_execution_end` | |
| `compaction_start/end` | 无 | 压缩事件需自己发 |
| `entry_added` | 无 | 需在持久化桥接中自己处理 |
| `config_update` | 无 | 直接改 agent.state |
| `retry_*` | 无 | 重试逻辑在 streamFn 层 |
| `fault` | 无 | 错误通过 agent_end 传递 |

---

## 执行顺序和工作量估算

| 阶段 | 预计改动 | 工作量 | 可独立提交 |
|---|---|---|---|
| 1. 本地化持久化层类型 | ~4 文件 | 2h | ✅ |
| 2. 本地化 Context + 压缩 + 执行环境 | ~6 文件 | 3h | ✅ |
| 3. 编排层重写 | ~3 文件（但改动大） | 8h+ | ❌（需和阶段 4 一起） |
| 4. StorageBackedSession 替代 | ~2 文件 | 2h | ❌（和阶段 3 一起） |

**总计**：~15h，建议分 2-3 天完成。阶段 1-2 可以先合（不影响运行时），阶段 3-4 一起做。

---

## 风险和回退

- **阶段 1-2 是安全的**：只是类型移动和函数复制，运行时行为不变
- **阶段 3 是高风险的**：核心编排重写，需要：
  - 全套现有测试跑通
  - 手动测试：正常对话、压缩、worker task、session inbox、idle-runner
  - 特别关注：持久化桥接的一致性（崩溃恢复、并发写入）
- **回退方案**：分支 `feat/pi-1.0-upgrade`，main 不动，随时可以丢弃
