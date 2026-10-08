// Local Context type replacing @earendil-works/chord's Context.
//
// Tianshu's actual usage of chord's Context was:
//   - as an opaque token passed to pi-agent-core methods
//   - BACKGROUND_CONTEXT for fire-and-forget operations
//   - withAbortSignal to attach cancellation
//
// Chord's telemetry and value-propagation features were never used.
// This minimal replacement covers all three patterns.

/**
 * Lightweight context carrier. Replaces chord's full `Context` with
 * the subset tianshu actually consumed.
 */
export type Context = { signal?: AbortSignal };

/** Context for operations with no user-facing cancellation. */
export const BACKGROUND_CONTEXT: Context = {};

/** Create a context with an attached AbortSignal. */
export function withAbortSignal(
  signal: AbortSignal,
  _ctx?: Context,
): Context {
  return { signal };
}
