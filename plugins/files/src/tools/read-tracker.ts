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
//
// Pagination semantics: a single one-shot read (offset=0 && !more)
// counts as fully read. Files larger than 500 KB force the agent
// to page through, in which case the path is fully "seen" only
// after both the first chunk (offset=0) AND the final chunk
// (!more) have been observed. We track those two flags per path
// rather than full byte-range coverage — the simpler model covers
// the realistic cases (read 0..N until !more) without the
// bookkeeping cost of arbitrary-range merges.

const SESSION_PATH_CAP = 4096;
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Per-path read state for the pagination-aware tracker. */
interface PathState {
  /** Has the agent ever read offset=0 of this path? */
  sawStart: boolean;
  /** Has the agent ever observed the final chunk (!more)? */
  sawEnd: boolean;
}

interface SessionEntry {
  paths: Map<string, PathState>;
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
    entry = { paths: new Map(), order: [], lastTouchedMs: now };
    sessions.set(sessionId, entry);
  } else {
    entry.lastTouchedMs = now;
  }
  return entry;
}

function touchOrder(entry: SessionEntry, resolvedPath: string): void {
  const idx = entry.order.indexOf(resolvedPath);
  if (idx >= 0) entry.order.splice(idx, 1);
  entry.order.push(resolvedPath);
  while (entry.order.length > SESSION_PATH_CAP) {
    const evicted = entry.order.shift();
    if (evicted !== undefined) entry.paths.delete(evicted);
  }
}

/**
 * Mark a path as fully read. Used by `read_file` for one-shot
 * reads (offset=0 and final chunk in the same call) and by
 * `write_file` after a successful write (the agent now "knows"
 * the contents because it just authored them).
 */
export function markRead(
  sessionId: string | undefined,
  resolvedPath: string,
): void {
  if (!sessionId) return;
  const now = Date.now();
  sweepIdle(now);
  const entry = getOrCreate(sessionId, now);
  entry.paths.set(resolvedPath, { sawStart: true, sawEnd: true });
  touchOrder(entry, resolvedPath);
}

/**
 * Mark a single chunk of a paged read. The host calls this for
 * every successful `read_file` regardless of size. `isStart` is
 * true when the chunk began at offset 0; `isEnd` is true when the
 * server reported no more chunks left (`!more`). A path becomes
 * `hasRead`-true only after both flags have been seen — individually
 * or in the same call — which makes paged "read 0..N until !more"
 * count as a complete read without forcing the agent to do a second
 * full one-shot pass.
 */
export function markChunk(
  sessionId: string | undefined,
  resolvedPath: string,
  isStart: boolean,
  isEnd: boolean,
): void {
  if (!sessionId) return;
  if (!isStart && !isEnd) return; // mid-file chunk; nothing to flag
  const now = Date.now();
  sweepIdle(now);
  const entry = getOrCreate(sessionId, now);
  const prev = entry.paths.get(resolvedPath) ?? {
    sawStart: false,
    sawEnd: false,
  };
  const next: PathState = {
    sawStart: prev.sawStart || isStart,
    sawEnd: prev.sawEnd || isEnd,
  };
  entry.paths.set(resolvedPath, next);
  touchOrder(entry, resolvedPath);
}

/** Returns true if `sessionId` has fully read `resolvedPath`.
 *  "Fully" means the start (offset=0) and the end (final chunk)
 *  have both been observed in this session. Returns true when
 *  sessionId is missing — tools invoked outside an agent loop
 *  (route handlers, scheduled jobs) shouldn't be blocked by the
 *  read-required check. */
export function hasRead(sessionId: string | undefined, resolvedPath: string): boolean {
  if (!sessionId) return true;
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  const state = entry.paths.get(resolvedPath);
  return Boolean(state && state.sawStart && state.sawEnd);
}

/** Test helper: clear all session state. */
export function _resetForTests(): void {
  sessions.clear();
  lastSweepMs = 0;
}
