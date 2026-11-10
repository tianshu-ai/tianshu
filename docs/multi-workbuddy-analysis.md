# Multi-WorkBuddy 可行性分析

## 目标

在 tianshu 里支持同时运行多个 workbuddy worker 实例，让不同的 worker 可以在各自的 session 里独立操作 WorkBuddy AI 桌面应用。

## 当前架构

### Worker Agent 系统

```
tenant/_tenant/config/workers/
├── llm-default/
│   ├── agent.json    { kind: "llm", displayName: "LLM Worker", ... }
│   └── SOUL.md
├── workbuddy-1/
│   ├── agent.json    { kind: "workbuddy", displayName: "WorkBuddy", ... }
│   └── SOUL.md
└── coding-worker/
    ├── agent.json    { kind: "coding", ... }
    └── SOUL.md
```

- **Worker agents** 通过文件系统定义（`fs-worker-agents.ts`）
- 每个 `<slug>/agent.json` 定义一个 worker agent，`kind` 字段决定运行时类型
- `kind: "workbuddy"` → `createWorkBuddyWorker()` → 注入 workbuddy skill 的 LLMWorker

### Worker Pool

- `WorkerPool` 管理所有 worker slots
- 每个 agent spec 对应一个 `WorkerHandle`（slot）
- 一个 slot 可以并发处理多个 task（Yu 2026-06-28 解除了 one-task-per-worker 限制）
- `rebuild()` 根据 agent specs 重建 slots，保留存活的 in-flight tasks
- `nudge()` 事件驱动分配，无轮询

### WorkBuddy Worker

- `workbuddy-worker.ts` 很薄——就是 `LLMWorker` + 预注入 `skills/workbuddy-agent.md`
- 通过 `(worker as any).kind = "workbuddy"` 标记类型
- skill 内容在模块加载时一次性读取（`const workbuddySkillContent = loadWorkBuddySkill()`）

## 多开 WorkBuddy 的可行性

### ✅ 已经支持——零代码改动

**当前架构已经支持多个 workbuddy worker。** 只需要在文件系统里创建多个 `kind: "workbuddy"` 的 agent：

```
workers/
├── workbuddy-research/
│   ├── agent.json    { "kind": "workbuddy", "displayName": "研究助手" }
│   └── SOUL.md       // 专注研究的 system prompt
├── workbuddy-coding/
│   ├── agent.json    { "kind": "workbuddy", "displayName": "编码助手" }
│   └── SOUL.md       // 专注编码的 system prompt
└── workbuddy-analysis/
    ├── agent.json    { "kind": "workbuddy", "displayName": "分析助手" }
    └── SOUL.md       // 专注数据分析的 system prompt
```

Pool 的 `rebuild()` 会为每个 agent spec 创建独立的 `WorkerHandle`，每个 handle 有独立的：
- session（`runnerSession`）
- system prompt
- 模型配置
- tool 权限
- 并发 task 队列

### ✅ 并发执行

Pool 已经支持多个 worker 同时执行 task：
- `busy` Map 按 taskId 索引，一个 agentId 可以同时处理多个 task
- `busyByUser` 按 userId 计数，有 per-user 并发上限
- `drainCursor` 做 round-robin 分配，负载均衡

### ⚠️ 潜在限制

#### 1. Bridge 并发

WorkBuddy worker 通过 bridge 的 Playwright 操作桌面应用。如果多个 worker 同时操作**同一个** WorkBuddy 窗口，会冲突（鼠标/键盘争抢）。

**解法**：
- **方案 A（简单）**：任务级串行——同一时间只有一个 workbuddy worker 操作 bridge。Pool 已有并发控制，加一个 `maxConcurrent: 1` 配置即可。
- **方案 B（理想）**：每个 workbuddy worker 操作不同的 WorkBuddy 窗口/实例。需要 bridge 支持多窗口 CDP target 选择。

#### 2. Session 隔离

每个 worker 已经有独立的 session（`AgentLoopRunner` 为每个 task 创建独立的 session）。但如果多个 workbuddy worker 操作同一个 workspace 文件，可能有文件冲突。

**解法**：通过 system prompt 或 task 分配策略，让不同 worker 操作不同的文件/目录。

#### 3. UI 展示

当前 Workboard UI 已经支持显示多个 worker agent。每个 agent 在 sidebar 里有独立的 card，task 可以指定分配给哪个 agent。

## 推荐方案

### Phase 1：零代码——文件系统配置多个 workbuddy agent（立即可用）

1. 在 Settings → Worker Agents 页面创建多个 workbuddy 类型的 agent
2. 每个 agent 配不同的 system prompt（专注不同领域）
3. 通过 task 的 `assignedAgent` 字段指定由哪个 workbuddy 处理

用户在 Workboard 里 `task_create` 时指定 `agent: "workbuddy-research"` 或 `agent: "workbuddy-coding"`。

### Phase 2：增强——per-agent bridge target（需要开发）

让每个 workbuddy agent 绑定不同的 browser/CDP target：

```json
// agent.json
{
  "kind": "workbuddy",
  "displayName": "研究助手",
  "config": {
    "cdpTarget": "ws://localhost:9222",
    "targetFilter": { "title": "WorkBuddy - Research" }
  }
}
```

workbuddy-worker.ts 在注入 skill 时把 CDP target 写进 system prompt，worker 操作指定窗口。

### Phase 3：优化——智能 task 路由

Pool 根据 task 内容自动选择最合适的 workbuddy agent：
- 研究类 task → workbuddy-research
- 编码类 task → workbuddy-coding
- 分析类 task → workbuddy-analysis

## 结论

**多开 workbuddy 已经可行，不需要代码改动。** 当前架构的 worker pool + 文件系统 agent 定义已经支持创建任意数量的同类型 worker。唯一需要注意的是 bridge 并发控制——多个 workbuddy 同时操作同一个桌面应用会冲突，Phase 2 通过 per-agent CDP target 解决。

建议先试试 Phase 1：在 Settings 里创建 2-3 个 workbuddy agent，分配不同的 task 看效果。
