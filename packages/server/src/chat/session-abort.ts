/**
 * Per-session abort registry.
 *
 * Allows WS "abort" messages to cancel idle-runner (inbox-triggered)
 * turns that run outside the WS handler's own AbortController scope.
 *
 * Usage:
 *   idle-runner: registerSessionAbort(sessionId, controller)
 *   WS handler:  abortSession(sessionId)  — called on user stop
 *   cleanup:     unregisterSessionAbort(sessionId)
 */

const abortMap = new Map<string, AbortController>();

export function registerSessionAbort(sessionId: string, controller: AbortController): void {
  abortMap.set(sessionId, controller);
}

export function unregisterSessionAbort(sessionId: string): void {
  abortMap.delete(sessionId);
}

/** Abort an idle-runner turn for this session. Returns true if found. */
export function abortSession(sessionId: string): boolean {
  const controller = abortMap.get(sessionId);
  if (controller) {
    controller.abort();
    abortMap.delete(sessionId);
    return true;
  }
  return false;
}
