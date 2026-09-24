# Structured Compaction + Recall (Planned)

**Status**: Design — not started  
**Date**: 2026-09-24  
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

## Implementation Steps

1. **Compaction prompt override** — pi 0.85 compaction hook: intercept summary generation, use a structured prompt that produces the turn-range format
2. **Turn counting in compaction** — count user turns in the compacted range, include turn numbers in the summary
3. **Wiki sync** — on compaction complete, write section summaries to wiki pages
4. **`toProviderMessages` injection** — ensure the structured summary is injected at the top of the model context
5. **Testing** — verify recall_range works with the turn numbers from the structured summary

## Dependencies

- pi 0.85 compaction hook/callback API (check if pi exposes summary customization)
- Wiki write API from server context
- Turn counting logic (reuse from recall_range)
