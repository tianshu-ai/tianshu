// Tracks which workspace paths each chat/worker session has loaded
// via `read_file` in the current process lifetime.
//
// Used by `edit_file` and `write_file` (when target exists) to
// refuse blind edits — if the agent never read a file, it has no
// business overwriting or string-replacing into it. The error
// surface tells the agent exactly what to do: "use read_file to
// load <path> first".
//
// Why per-session and not per-tenant: two parallel chats by the
// same user shouldn't share read state — chat A reading a file
// doesn't authorise chat B to edit it sight-unseen. Sessions are
// the natural granularity for "what the agent has seen so far".
//
// Why in-process and not persisted: the contract we want is
// "agent has the file's contents in this conversation's context",
// which is itself in-memory in the LLM provider and lives only as
// long as the host process anyway. Persisting readSet across
// restarts would create a false sense that the agent "knows" a
// file when in reality the model has no token of it.
//
// Memory bound: each entry is a path string (~100 bytes typical),
// session caps via LRU at 4096 paths per session, and we evict
// idle sessions after 30 min. A tenant pegging this would need
// ~30 MB for 1000 idle sessions — fine for our scale.

const SESSION_PATH_CAP = 4096;
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface SessionEntry {
  paths: Set<string>;
  /** Path-insertion order for LRU when we hit the cap. Same string
   *  appearing twice gets bumped to the end. */
  order: string[];
  lastTouchedMs: number;
}

const sessions = new Map<string, SessionEntry>();
let lastSweepMs = 0;

function sweepIdle(now: number): void {
  if (now - lastSweepMs < 60_000) return; // at most once a minute
  lastSweepMs = now;
  for (const [sid, entry] of sessions) {
    if (now - entry.lastTouchedMs > SESSION_IDLE_MS) {
      sessions.delete(sid);
    }
  }
}

function getOrCreate(sessionId: string, now: number): SessionEntry {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { paths: new Set(), order: [], lastTouchedMs: now };
    sessions.set(sessionId, entry);
  } else {
    entry.lastTouchedMs = now;
  }
  return entry;
}

/** Mark `resolvedPath` as having been read by `sessionId`. Idempotent. */
export function markRead(sessionId: string | undefined, resolvedPath: string): void {
  if (!sessionId) return;
  const now = Date.now();
  sweepIdle(now);
  const entry = getOrCreate(sessionId, now);
  if (entry.paths.has(resolvedPath)) {
    // Bump LRU position
    const idx = entry.order.indexOf(resolvedPath);
    if (idx >= 0) entry.order.splice(idx, 1);
    entry.order.push(resolvedPath);
    return;
  }
  entry.paths.add(resolvedPath);
  entry.order.push(resolvedPath);
  while (entry.order.length > SESSION_PATH_CAP) {
    const evicted = entry.order.shift();
    if (evicted !== undefined) entry.paths.delete(evicted);
  }
}

/** Returns true if `sessionId` has previously read `resolvedPath`.
 *  Returns true when sessionId is missing — tools invoked outside
 *  an agent loop (route handlers, scheduled jobs) shouldn't be
 *  blocked by the read-required check. */
export function hasRead(sessionId: string | undefined, resolvedPath: string): boolean {
  if (!sessionId) return true;
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  return entry.paths.has(resolvedPath);
}

/** Test helper: clear all session state. */
export function _resetForTests(): void {
  sessions.clear();
  lastSweepMs = 0;
}
