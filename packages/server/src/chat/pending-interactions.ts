// Pending interaction registry — the glue between ask_user tool
// calls and WebSocket user responses.
//
// Lifecycle:
//   1. ask_user tool executor creates an Interaction, registers it,
//      and returns the Promise. The agent loop suspends.
//   2. The WS handler sends an "interaction_request" event to the
//      client with the question + options.
//   3. The user clicks an option → client sends "interaction_response".
//   4. The WS handler calls resolve() here → Promise fulfills →
//      agent loop resumes with the user's choice as the tool result.
//
// Timeout / abort:
//   - Each interaction has a deadline (default 5 min). On expiry
//     the Promise rejects and the agent sees a timeout error.
//   - If the session's AbortSignal fires (user hit Stop), the
//     Promise rejects immediately.

export interface InteractionOption {
  /** Value sent back as the tool result when selected. */
  value: string;
  /** Display label shown on the button. */
  label: string;
  /** Optional short description below the label. */
  description?: string;
}

export interface InteractionRequest {
  id: string;
  sessionId: string;
  question: string;
  options: InteractionOption[];
  /** When true, user can select multiple options. */
  multiSelect?: boolean;
}

interface PendingEntry {
  request: InteractionRequest;
  resolve: (value: string | string[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

const pending = new Map<string, PendingEntry>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let idCounter = 0;

/** Generate a short unique interaction id. */
function nextId(): string {
  return `ia_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

/**
 * Create a pending interaction. Returns a Promise that resolves
 * when the user responds, or rejects on timeout / abort.
 *
 * The caller (ask_user tool executor) should also arrange for the
 * InteractionRequest to be sent to the client via WebSocket.
 */
export function createInteraction(
  sessionId: string,
  question: string,
  options: InteractionOption[],
  opts?: {
    multiSelect?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): { request: InteractionRequest; result: Promise<string | string[]> } {
  const id = nextId();
  const request: InteractionRequest = {
    id,
    sessionId,
    question,
    options,
    multiSelect: opts?.multiSelect,
  };

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const result = new Promise<string | string[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup(id);
      reject(new Error("interaction_timeout: user did not respond within the time limit"));
    }, timeoutMs);

    const entry: PendingEntry = { request, resolve, reject, timer };

    // Wire up abort signal (user hit Stop)
    if (opts?.signal) {
      const onAbort = () => {
        cleanup(id);
        reject(new Error("interaction_aborted: session was aborted"));
      };
      if (opts.signal.aborted) {
        reject(new Error("interaction_aborted: session was already aborted"));
        clearTimeout(timer);
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      entry.abortHandler = onAbort;
    }

    pending.set(id, entry);
  });

  return { request, result };
}

/**
 * Resolve a pending interaction with the user's choice.
 * Called by the WS handler when it receives "interaction_response".
 * Returns true if the interaction was found and resolved.
 */
export function resolveInteraction(
  id: string,
  value: string | string[],
): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  cleanup(id);
  entry.resolve(value);
  return true;
}

/**
 * Get a pending interaction request by id (for validation).
 */
export function getPendingInteraction(
  id: string,
): InteractionRequest | undefined {
  return pending.get(id)?.request;
}

/**
 * Get all pending interactions for a session.
 */
export function getPendingForSession(
  sessionId: string,
): InteractionRequest[] {
  const result: InteractionRequest[] = [];
  for (const entry of pending.values()) {
    if (entry.request.sessionId === sessionId) {
      result.push(entry.request);
    }
  }
  return result;
}

/**
 * Get all pending interactions (across all sessions).
 * Used to re-push on WS reconnect.
 */
export function getAllPending(): InteractionRequest[] {
  return [...pending.values()].map((e) => e.request);
}

/** Clean up a pending entry. */
function cleanup(id: string): void {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (entry.abortHandler) {
    // Can't remove the listener without the signal ref, but the
    // handler is { once: true } so it auto-removes after firing.
    // Setting to undefined prevents double-fire in edge cases.
    entry.abortHandler = undefined;
  }
  pending.delete(id);
}
