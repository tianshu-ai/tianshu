# Structured Compaction + Recall

**Status**: Implemented on branch `structured-compaction` (2026-09-24, pending PR merge). Wiki archive component intentionally deferred — to be built later when we add day/week/month roll-up summaries.  
**Date**: 2026-09-24 (design + implementation)  
**Context**: pi 0.85 migration changed compaction from flat list to branch-based. After compaction, the model's context only has the summary + post-compaction turns. The model doesn't know about pre-compaction turn numbers, so it can't use `recall_range` effectively.

## Problem

pi 0.85 compaction replaces old turns with a summary entry on a new branch. The model loses awareness of:
- How many turns were compacted
- What topics each turn range covered
- That `recall_range(from, to)` can retrieve archived content

## Design

### 1. Structured Compaction Summary

Replace the free-form summary with a structured format:

```
[Compacted Context — turns 1-47]

## turns 1-12: 项目初始化
讨论了天枢开源仓 scaffolding，确定多租户架构...
→ wiki 搜索关键词: 多租户架构, scaffolding

## turns 13-28: bridge 插件开发  
实现了 local-bridge WebSocket 通信，文件大小限制...
→ wiki 搜索关键词: local-bridge, WebSocket

## turns 29-47: 三主题视觉统一
dark/light/classical 主题，印章水印，气泡装饰...
→ wiki 搜索关键词: 主题, 印章, 气泡

[当前上下文从 turn 48 开始。用 recall_range(from, to) 查看原始对话。]
```

### 2. Wiki Archive on Compaction

When compaction runs, write each section summary to wiki as a session archive page. This enables free-text search via wiki tools for content that was compacted out of context.

### 3. Agent Awareness

With the structured summary, the agent knows:
- Total turns compacted and their ranges
- Topic of each range
- How to access details: `recall_range(from, to)` for raw turns, wiki search for semantic lookup

## Implementation

### Turn numbering invariants (session-absolute)

1. Turn 1 starts at the session's first **real user JSON** row — role='user' AND the first text chunk (after trimStart) does NOT start with `[plugin-system]` or `[system note]`. Plugin notices and recovery stubs come in under role='user' too and are excluded.
2. Each subsequent real user JSON bumps the counter by one.
3. Every other entry (assistant / tool / compaction / branch_summary / plugin notice) inherits the current turn. Session-leading non-user entries get turn 0.
4. **turn_number is immutable once written.** Compaction, branching, and navigation NEVER rewrite it. New branches share their ancestors' turn numbers.

Single source of truth for the predicate: `packages/server/src/chat/real-user-turn.ts` (3 projections: AgentMessage, parsed JSON, raw JSON string). Migration 017 keeps a self-contained inline copy — migrations must not depend on chat/ code at replay time.

### Delivered pieces

1. **DB column + migration** — `messages.turn_number INTEGER` with `idx_messages_session_turn ON (session_id, turn_number)`. Migration 017 back-fills every existing session by walking (created_at, seq) order.
2. **Storage insert path** — `sqlite-storage.ts` seeds a per-session counter from `MAX(turn_number)` and writes the column on every new entry.
3. **Predicate unification** — `progressive-history`, `recall_range`, and storage all delegate to `real-user-turn.ts` (was three subtly-different implementations before).
4. **`before_compaction` hook** — `structured-compaction.ts` intercepts pi 0.87's compaction, computes [A, B] from stored turn_number, calls `completeSimple` with a purpose-built prompt asking for `## turns A-B: <label>` sections + key facts + recall keywords. Wraps the model output in `[Compacted context — turns A-B, N turns]` header + `recall_range(A, B)` footer. Fail-open: any exception / empty response falls back to pi's default summarizer with a `structured_compaction fallback reason=...` warn log.
5. **recall_range optimization** — uses `WHERE session_id=? AND turn_number BETWEEN ? AND ?` hitting the new index instead of full-scan + in-memory walk.

### How pi surfaces the summary

pi 0.87's `getMessageFromEntry` converts `entry.type === "compaction"` into `role: "compactionSummary"` → `convertToLlm` wraps it as `role: "user"` with the boilerplate:

```
The conversation history before this point was compacted into the following summary:

<summary>
[Compacted context — turns A-B, N turns]

... structured markdown ...

---
Original transcripts for turns A-B remain in the session's DB and can be pulled back with recall_range(A, B). Individual archived tool calls remain accessible via recall_tool_call(id).
</summary>
```

No custom `toProviderMessages` injection needed — pi handles the wire-up as long as the hook returns a well-formed `CompactResult`.

### Tests

- `structured-compaction.test.ts` — 8 unit tests over `computeCompactionTurnRange` edge cases and `buildStructuredSummary` header/footer shape.
- `/tmp/turn-number-e2e.mjs` + `/tmp/turn-number-prefix-e2e.mjs` — e2e smoke on migration 017 back-fill + prefix-whitelist rule (kept as evidence, not shipped).
- Full chat suite: 20 files / 189 tests all pass.

### Deferred (intentional)

- **Wiki archive on compaction.** Yu, 2026-09-24: skip synchronous wiki write on compaction; the day/week/month roll-up flow will read compacted sessions and archive selectively. That decision keeps the compaction hot path model-local and avoids losing structured summaries to wiki-write failures.

### Reference commits (branch `structured-compaction`)

- `f2c388e` — turn_number column + migration 017 + storage-side counter
- `ab60bef` — unify real-user-turn predicate across three sites
- `b1919c0` — before_compaction hook + `structured-compaction.ts` + unit tests
- `0074e31` — recall_range range-index optimization + dead-code removal

### Dependencies (met)

- pi 0.87 `Hooks.on("before_compaction", ...)` — available on `harness.hooks`
- `completeSimple` from `@earendil-works/pi-ai/compat` — same call path already used by `compact.ts`
- Turn counting rule shared with progressive-history via `real-user-turn.ts`
