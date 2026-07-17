// Per-uri cache for MCP-UI resource HTML.
//
// Why this exists (the A1 design, aligned with the ChatGPT Apps SDK
// model where the UI template is addressed by a stable uri and the
// heavy HTML never rides on the model context or gets re-sent per
// call):
//
//   - The tool result HTML can be large (a whole board page). We do
//     NOT persist it on the chat message (the DB row only carries the
//     tool result's {uri, mimeType} reference, not the html) and the
//     model never sees it (it gets a short "[interactive UI]"
//     placeholder). So on a page reload the tool chip is rebuilt from
//     history WITHOUT the html.
//   - To render it anyway, we cache the html keyed by its `ui://` uri
//     the first time it arrives (live, over the WS tool_result event),
//     in sessionStorage so it survives a reload within the tab.
//   - The uri is the cache key / version (MCP-UI + Apps SDK both treat
//     a changed UI as a new uri), so caching by uri is safe: a new
//     version is a new key.
//
// Scope: sessionStorage (per-tab, cleared when the tab closes). That's
// the right lifetime — a board's html is cheap to re-fetch by re-running
// the tool in a new session, and we don't want unbounded localStorage
// growth across every ui:// a user ever saw.

const PREFIX = "tianshu:mcp-ui:";
// In-memory mirror so repeated reads in one render pass don't hit
// sessionStorage each time.
const mem = new Map<string, string>();

function keyFor(uri: string): string {
  return PREFIX + uri;
}

/** Store the html for a ui:// uri (called when a live tool_result
 *  delivers an inline resource). Idempotent; last write wins. */
export function cacheMcpUiHtml(uri: string, html: string): void {
  if (!uri || typeof html !== "string") return;
  mem.set(uri, html);
  try {
    sessionStorage.setItem(keyFor(uri), html);
  } catch {
    // sessionStorage may be full or unavailable (private mode); the
    // in-memory copy still serves this tab session until reload.
  }
}

/** Retrieve cached html for a uri, or null if we've never seen it in
 *  this tab (e.g. a reload after the tab was closed, or a chip whose
 *  tool was run in a different session). */
export function getMcpUiHtml(uri: string): string | null {
  if (!uri) return null;
  const inMem = mem.get(uri);
  if (inMem !== undefined) return inMem;
  try {
    const stored = sessionStorage.getItem(keyFor(uri));
    if (stored !== null) {
      mem.set(uri, stored);
      return stored;
    }
  } catch {
    /* ignore */
  }
  return null;
}
