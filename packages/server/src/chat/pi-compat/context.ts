// Local Context replacement.
// The old pi-agent-core re-exported Context from @earendil-works/chord.
// tianshu only uses it as an abort-signal carrier + opaque passthrough.
// The new Agent class uses plain AbortSignal directly.

export interface Context {
  readonly abortSignal?: AbortSignal;
  value?<T>(key: unknown): T | undefined;
  toString?(): string;
}

export const BACKGROUND_CONTEXT: Context = {
  abortSignal: undefined,
  value: () => undefined,
  toString: () => "BACKGROUND_CONTEXT",
};

export function withAbortSignal(signal: AbortSignal, _ctx?: Context): Context {
  return {
    abortSignal: signal,
    value: () => undefined,
    toString: () => `Context(signal)`,
  };
}
