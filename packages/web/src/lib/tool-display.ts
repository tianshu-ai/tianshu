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

// Built-in defaults are intentionally empty. Host tool display is
// handled by humanizeArgs() in humanize-tool.ts which produces
// semantic one-line descriptions. Plugin-declared toolDisplay entries
// (from manifest.json) override via the server connected event.
const BUILTIN_DEFAULTS: WireToolDisplay[] = [];

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
