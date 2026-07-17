// board_act bridge — the server-side request/response rendezvous.
//
// The agent's board_act tool can't touch the board iframe directly (it
// lives in the user's browser). So:
//   1. board_act registers a pending request here (reqId + Promise) and
//      broadcasts `board_act_request` to the tenant.
//   2. BoardPanel (browser) catches it, postMessages the op into its
//      iframe, awaits the injected runtime's reply, and sends a
//      `board_act_response` WS message back with the same reqId.
//   3. The plugin's ws handler calls resolveRequest(reqId, result),
//      fulfilling the Promise the tool was awaiting.
//
// Per-request timeout (default 30s) drops the pending entry so the
// Promise rejects cleanly and the agent gets a clean error.

export interface BoardActResult {
  ok: boolean;
  /** Op-specific data: textContent for query, return value for eval, etc. */
  data?: unknown;
  /** Error message when ok=false. */
  error?: string;
}

interface PendingEntry {
  resolve: (r: BoardActResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  createdAt: number;
}

const pending = new Map<string, PendingEntry>();

let counter = 0;
function newReqId(): string {
  counter = (counter + 1) % 1e6;
  return `bact-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Register a pending board_act request. Returns the reqId to send to
 *  the browser and a Promise that resolves when the iframe replies. */
export function registerRequest(
  timeoutMs = 30_000,
): { reqId: string; promise: Promise<BoardActResult> } {
  const reqId = newReqId();
  const promise = new Promise<BoardActResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(reqId)) return;
      pending.delete(reqId);
      reject(new Error(`board_act request ${reqId} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(reqId, { resolve, reject, timer, createdAt: Date.now() });
  });
  return { reqId, promise };
}

/** Called from the plugin's ws handler when the browser reports an op
 *  result. Returns true if a matching pending request was resolved. */
export function resolveRequest(reqId: string, result: BoardActResult): boolean {
  const entry = pending.get(reqId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(reqId);
  entry.resolve(result);
  return true;
}
