// Shared repetitive tool call loop detection.
//
// Two detection modes:
//   A) Exact match — same tool + identical JSON-stable args
//   B) Name match — same tool name called consecutively (any args)
//
// Used by both the main chat handler and the worker agent-loop.

import { createLogger } from "../setup/logger.js";

const log = createLogger("loop-detect");

export type LoopAction = "ok" | "hint" | "warn" | "stop";

export interface LoopCheckResult {
  action: LoopAction;
  message?: string;
}

// Thresholds (exact / name-only):
//   hint:  3 / 5      warn:  5 / 8      stop:  10 / 15
const EXACT_HINT = 3, EXACT_WARN = 5, EXACT_STOP = 10;

export class ToolLoopDetector {
  private calls: Array<{ name: string; fp: string }> = [];
  private _endReason: string | null = null;
  private _wasTriggered = false;
  /** tool name → set of valid parameter names from schema */
  private schemaKeys = new Map<string, Set<string>>();

  get endReason(): string | null { return this._endReason; }
  /** True if finishTurn ended a run due to loop detection. */
  get wasTriggered(): boolean { return this._wasTriggered; }
  clearEndReason(): void { this._endReason = null; }
  /** Reset state for a new prompt round (e.g. after injecting a system notice). */
  reset(): void { this.calls.length = 0; this._endReason = null; this._wasTriggered = false; }

  /** Register tool schemas so fingerprinting only uses declared parameters. */
  registerTools(tools: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }>): void {
    for (const t of tools) {
      const props = t.parameters?.properties;
      if (props) this.schemaKeys.set(t.name, new Set(Object.keys(props)));
    }
  }

  check(name: string, args: unknown): LoopCheckResult {
    let argsStr: string;
    try {
      // Only fingerprint parameters declared in the tool's schema.
      // Models may invent extra fields (title, _title, etc.) that
      // vary per call but don't affect the actual operation.
      const raw = args as Record<string, unknown> ?? {};
      const validKeys = this.schemaKeys.get(name);
      let filtered: Record<string, unknown>;
      if (validKeys) {
        filtered = {};
        for (const k of validKeys) {
          if (k in raw) filtered[k] = raw[k];
        }
      } else {
        // No schema registered — fall back to stripping _-prefixed fields
        filtered = {};
        for (const [k, v] of Object.entries(raw)) {
          if (!k.startsWith("_")) filtered[k] = v;
        }
      }
      argsStr = JSON.stringify(filtered, Object.keys(filtered).sort());
    } catch { argsStr = String(args); }
    const fp = `${name}::${argsStr}`;
    this.calls.push({ name, fp });
    if (this.calls.length > EXACT_STOP + 2) this.calls.splice(0, this.calls.length - EXACT_STOP - 2);

    let exactStreak = 0;
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i]!.fp === fp) exactStreak++; else break;
    }

    // Only detect exact match loops (same tool + same args).
    // Name-only detection (same tool, different args) removed —
    // it false-positives on legitimate exploration like querying
    // different tables with ds_query.
    if (exactStreak >= EXACT_STOP)
      return { action: "stop", message: `Repetitive tool call loop detected: ${name} was called ${exactStreak} times with identical arguments. The result is the same every time. Do NOT call this tool again. Respond to the user or try a completely different approach.` };
    if (exactStreak >= EXACT_WARN)
      return { action: "warn", message: `Warning: ${name} was called ${exactStreak} times with identical arguments. The result is the same every time. Stop repeating this call and try a different approach.` };
    if (exactStreak >= EXACT_HINT)
      return { action: "hint", message: `Note: ${name} was called ${exactStreak} times with identical arguments. Consider whether continuing is productive, or try a different approach.` };
    return { action: "ok" };
  }

  /** afterToolCall hook for pi-agent-core. */
  makeAfterToolCall(logPrefix: string = "[loop_detect]") {
    return async (ctx: { toolCall: { name: string }; args: unknown; result: { content: Array<{ type: string; text?: string }> } }) => {
      const check = this.check(ctx.toolCall.name, ctx.args);
      if (check.action === "ok") return undefined;
      log.warn(`${logPrefix} action=${check.action} tool=${ctx.toolCall.name} streak=${this.calls.length}`);
      this._endReason = check.message!;
      return undefined;
    };
  }

  /** finishTurn hook for pi-agent-core. */
  makeFinishTurn(opts?: {
    onEnd?: (reason: string) => void;
  }) {
    return async () => {
      if (!this._endReason) return undefined;
      const reason = this._endReason;
      this._endReason = null;
      log.warn(`[loop_detect] ending run`);
      this._wasTriggered = true;
      opts?.onEnd?.(reason);
      return { action: "end" as const };
    };
  }
}
