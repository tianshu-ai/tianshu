// Tool Display registry.
//
// Stores the tool-display config received from the server (via the
// `connected` WS event) and provides a lookup function that
// `ToolCallDetail` uses to pick a renderer. Falls back to
// `inferRender()` when no config matches.
//
// Matching priority:
//   1. Exact tool name match.
//   2. Wildcard match (trailing `*`, e.g. `"ds_*"` matches `"ds_query"`).
//   3. No match → caller uses `inferRender()`.

import type { WireToolDisplay } from "./ws";

// ── Module-level store ─────────────────────────────────────────

// ── Built-in defaults for host tools and unconfigured plugins ──

const BUILTIN_DEFAULTS: WireToolDisplay[] = [
  // Host tools
  { tool: "compact_context", input: { format: "hidden" }, output: { format: "plain" } },
  { tool: "tool_catalog_refresh", input: { format: "hidden" }, output: { format: "plain" } },
  { tool: "switch_panel",
    input: { format: "key-value", labels: { panel: "面板" } },
    output: { format: "plain" } },
  { tool: "solution",
    input: { format: "key-value", labels: { action: "操作", slug: "方案", spec: "配置" }, omit: ["spec"] },
    output: { format: "plain" } },
  { tool: "generate_image",
    input: { format: "key-value", labels: { prompt: "描述", style: "风格", size: "尺寸" } },
    output: { format: "plain" } },
  { tool: "ask_user",
    input: { format: "key-value", labels: { question: "问题" }, pick: ["question"] },
    output: { format: "plain" } },
  { tool: "channel_send_file",
    input: { format: "key-value", labels: { path: "文件", target: "目标" } },
    output: { format: "plain" } },
  { tool: "recall_tool_call", input: { format: "hidden" }, output: { format: "plain" } },
  { tool: "recall_range", input: { format: "hidden" }, output: { format: "plain" } },
  { tool: "inspect_session", input: { format: "hidden" }, output: { format: "plain" } },
  { tool: "read_session_log", input: { format: "hidden" }, output: { format: "plain" } },
  { tool: "nudge_session",
    input: { format: "key-value", labels: { sessionId: "会话", message: "消息" } },
    output: { format: "plain" } },
  // Workboard plugin
  { tool: "task_create",
    input: { format: "key-value", labels: { title: "标题", description: "描述", projectSlug: "项目" }, omit: ["description"] },
    output: { format: "plain" } },
  { tool: "task_list",
    input: { format: "key-value", labels: { projectSlug: "项目", status: "状态" } },
    output: { format: "plain" } },
  { tool: "task_update",
    input: { format: "key-value", labels: { taskId: "任务", status: "状态", title: "标题" } },
    output: { format: "plain" } },
  // Wiki plugin
  { tool: "wiki_search",
    input: { format: "key-value", labels: { query: "搜索" }, pick: ["query"] },
    output: { format: "markdown" } },
  { tool: "wiki_read",
    input: { format: "key-value", labels: { page: "页面" }, pick: ["page"] },
    output: { format: "markdown" } },
  // Cron plugin
  { tool: "cron_list", input: { format: "hidden" }, output: { format: "json" } },
  { tool: "cron_create",
    input: { format: "key-value", labels: { name: "名称", schedule: "计划", command: "命令" } },
    output: { format: "plain" } },
  // Memory / recall
  { tool: "memory_search",
    input: { format: "key-value", labels: { query: "搜索" }, pick: ["query"] },
    output: { format: "markdown" } },
  { tool: "memory_read",
    input: { format: "key-value", labels: { key: "键" }, pick: ["key"] },
    output: { format: "markdown" } },
  // Tenant config
  { tool: "tenant_config_read",
    input: { format: "key-value", labels: { path: "路径" }, pick: ["path"] },
    output: { format: "code", language: "text" } },
  { tool: "tenant_config_write",
    input: { format: "key-value", labels: { path: "路径" } },
    output: { format: "plain" } },
];

let exactMap: Map<string, WireToolDisplay> = new Map();
let wildcardEntries: Array<{ prefix: string; entry: WireToolDisplay }> = [];

/**
 * Replace the entire tool-display config. Called once on `connected`
 * (and again on reconnect / `hello`).
 */
export function setToolDisplayConfig(entries: WireToolDisplay[]): void {
  const nextExact = new Map<string, WireToolDisplay>();
  const nextWild: typeof wildcardEntries = [];
  // Built-in defaults first (server entries override)
  for (const e of BUILTIN_DEFAULTS) {
    if (e.tool.endsWith("*")) {
      nextWild.push({ prefix: e.tool.slice(0, -1), entry: e });
    } else {
      nextExact.set(e.tool, e);
    }
  }
  // Server-supplied entries override built-ins
  for (const e of entries) {
    if (e.tool.endsWith("*")) {
      nextWild.push({ prefix: e.tool.slice(0, -1), entry: e });
    } else {
      nextExact.set(e.tool, e);
    }
  }
  exactMap = nextExact;
  wildcardEntries = nextWild;
}

/** Resolved display config for a single tool call. */
export interface ResolvedToolDisplay {
  input?: WireToolDisplay["input"];
  output?: WireToolDisplay["output"];
}

/**
 * Look up the display config for a tool by name. Returns `undefined`
 * when no plugin declared a display hint for this tool — the caller
 * should fall back to `inferRender()`.
 */
export function getToolDisplay(name: string): ResolvedToolDisplay | undefined {
  // 1. Exact match
  const exact = exactMap.get(name);
  if (exact) return exact;
  // 2. Wildcard (longest prefix wins)
  let best: WireToolDisplay | undefined;
  let bestLen = -1;
  for (const { prefix, entry } of wildcardEntries) {
    if (name.startsWith(prefix) && prefix.length > bestLen) {
      best = entry;
      bestLen = prefix.length;
    }
  }
  return best;
}

// Pre-seed built-in defaults so they're available before WS connects
setToolDisplayConfig([]);
