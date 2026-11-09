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

// Cycle detection thresholds: how many full repeats of a pattern
// before we hint / warn / stop. E.g. A B C A B C A B C = 3 repeats
// of cycle length 3.
const CYCLE_HINT_REPEATS = 2, CYCLE_WARN_REPEATS = 3, CYCLE_STOP_REPEATS = 4;
// Max cycle length to search for (keep small to avoid O(n²) blowup)
const MAX_CYCLE_LEN = 8;

// Duplicate call detection: same input → same output.
// If we've seen this exact (tool, args) before AND got the same result,
// there's no point calling it again — the answer is already in context.
const DUP_HINT = 5, DUP_WARN = 8, DUP_STOP = 12;

// Tool name frequency: same tool called too many times (any args).
// Catches loops where the model varies arguments but keeps hammering
// the same tool (e.g. bridge_exec with sleep 1, sleep 2, sleep 3, repeat).
const TOOL_FREQ_HINT = 30, TOOL_FREQ_WARN = 50, TOOL_FREQ_STOP = 100;

export class ToolLoopDetector {
  private calls: Array<{ name: string; fp: string }> = [];
  private _endReason: string | null = null;
  private _wasTriggered = false;
  /** tool name → set of valid parameter names from schema */
  private schemaKeys = new Map<string, Set<string>>();
  /**
   * Tracks (input fingerprint → output hash) pairs across the entire
   * turn. Key = tool+args fingerprint, value = { outputHash, count }.
   * Non-consecutive duplicates (A B A B) are caught here even though
   * the exact-streak detector misses them.
   */
  private seen = new Map<string, { outputHash: string; count: number }>();

  /** Tracks total calls per tool name across the session. */
  private toolFreq = new Map<string, number>();

  get endReason(): string | null { return this._endReason; }
  /** True if finishTurn ended a run due to loop detection. */
  get wasTriggered(): boolean { return this._wasTriggered; }
  clearEndReason(): void { this._endReason = null; }
  /** Full reset — clears everything including cross-turn duplicate tracking. */
  reset(): void { this.calls.length = 0; this._endReason = null; this._wasTriggered = false; this.seen.clear(); this.toolFreq.clear(); }

  /** Reset per-turn state. Keeps cross-turn duplicate tracking
   *  (seen) but resets everything else so detection
   *  thresholds start fresh each turn. */
  resetStreaks(): void {
    this.calls.length = 0;
    this._endReason = null;
    this._wasTriggered = false;
    this.toolFreq.clear();
  }

  /** Register tool schemas so fingerprinting only uses declared parameters. */
  registerTools(tools: Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }>): void {
    for (const t of tools) {
      const props = t.parameters?.properties;
      if (props) this.schemaKeys.set(t.name, new Set(Object.keys(props)));
    }
  }

  /** Build a stable fingerprint for (tool name, args), filtering to schema-declared params. */
  private fingerprint(name: string, args: unknown): string {
    try {
      const raw = args as Record<string, unknown> ?? {};
      const validKeys = this.schemaKeys.get(name);
      let filtered: Record<string, unknown>;
      if (validKeys) {
        filtered = {};
        for (const k of validKeys) {
          // Skip _-prefixed keys even if they are in the schema.
          // _title is injected by tianshu for UI display and varies
          // per call; including it makes every fingerprint unique.
          if (k.startsWith("_")) continue;
          if (k in raw) filtered[k] = raw[k];
        }
      } else {
        filtered = {};
        for (const [k, v] of Object.entries(raw)) { if (!k.startsWith("_")) filtered[k] = v; }
      }
      return `${name}::${JSON.stringify(filtered, Object.keys(filtered).sort())}`;
    } catch { return `${name}::${String(args)}`; }
  }

  check(name: string, args: unknown): LoopCheckResult {
    const fp = this.fingerprint(name, args);
    this.calls.push({ name, fp });
    // Keep enough history for cycle detection (longest cycle × max repeats + buffer)
    const maxHistory = MAX_CYCLE_LEN * (CYCLE_STOP_REPEATS + 1) + 2;
    if (this.calls.length > maxHistory) this.calls.splice(0, this.calls.length - maxHistory);

    // ── Cycle / pattern detection ────────────────────────────────
    // Detect repeating patterns like A B C A B C A B C.
    // Check cycle lengths from 2..MAX_CYCLE_LEN.
    const cycle = this.detectCycle();
    if (cycle) {
      const tools = cycle.pattern.map(c => c.split("::")[0]).join(" → ");
      if (cycle.repeats >= CYCLE_STOP_REPEATS)
        return { action: "stop", message: `The pattern [${tools}] has repeated ${cycle.repeats} times. Please review: if this is a loop, try a different approach to break out; if not, continue.` };
      if (cycle.repeats >= CYCLE_WARN_REPEATS)
        return { action: "warn", message: `The pattern [${tools}] has repeated ${cycle.repeats} times. Please check whether you are in a loop. If yes, try an alternative approach; if not, continue.` };
      if (cycle.repeats >= CYCLE_HINT_REPEATS)
        return { action: "hint", message: `The pattern [${tools}] has repeated ${cycle.repeats} times. Quick self-check: is this a loop? If yes, try a different approach; if not, carry on.` };
    }
    return { action: "ok" };
  }

  /**
   * Detect repeating cycles in the call history.
   * Checks cycle lengths from 2..MAX_CYCLE_LEN. Returns the longest
   * cycle with the most repeats, or null if no cycle found.
   */
  private detectCycle(): { pattern: string[]; repeats: number } | null {
    const fps = this.calls.map(c => c.fp);
    const n = fps.length;
    let best: { pattern: string[]; repeats: number } | null = null;
    for (let len = 2; len <= Math.min(MAX_CYCLE_LEN, Math.floor(n / 2)); len++) {
      // Take the last `len` fingerprints as the candidate pattern
      const pattern = fps.slice(n - len);
      let repeats = 1;
      // Walk backwards checking if preceding chunks match
      for (let offset = n - len * 2; offset >= 0; offset -= len) {
        const chunk = fps.slice(offset, offset + len);
        if (chunk.length !== len) break;
        let match = true;
        for (let j = 0; j < len; j++) {
          if (chunk[j] !== pattern[j]) { match = false; break; }
        }
        if (!match) break;
        repeats++;
      }
      if (repeats >= CYCLE_HINT_REPEATS && (!best || repeats > best.repeats || (repeats === best.repeats && len > best.pattern.length))) {
        best = { pattern, repeats };
      }
    }
    return best;
  }

  /**
   * Record the output of a tool call and check for duplicate results.
   * Called after a tool returns. Returns a LoopCheckResult if the
   * same (tool, args) produced the same output before.
   */
  checkResult(name: string, args: unknown, result: unknown): LoopCheckResult {
    const fp = this.fingerprint(name, args);

    // Hash the output, stripping unstable fields (duration_ms, timed_out,
    // timestamps, etc.) so that semantically identical results match even
    // when timing varies between executions.
    let outputHash: string;
    try {
      const stripped = JSON.parse(JSON.stringify(result, (key, val) => {
        if (key === "duration_ms" || key === "durationMs" || key === "timed_out" || key === "timedOut" || key === "aborted") return undefined;
        return val;
      }));
      const s = JSON.stringify(stripped);
      outputHash = s.length <= 512 ? s : s.slice(0, 512);
    } catch { outputHash = String(result); }

    // 1. Exact (input+output) duplicate check
    const prev = this.seen.get(fp);
    if (prev && prev.outputHash === outputHash) {
      prev.count++;
      if (prev.count >= DUP_STOP)
        return { action: "stop", message: `${name} has been called ${prev.count} times with the same arguments and returned the same result. The data is already in the conversation. Please review: if this is a loop, try a different approach; if you need the data, it is already available above.` };
      if (prev.count >= DUP_WARN)
        return { action: "warn", message: `${name} returned the same result ${prev.count} times for the same arguments. Please check whether you are in a loop. The data is already in the conversation; if you need it, look above instead of re-querying.` };
      if (prev.count >= DUP_HINT)
        return { action: "hint", message: `${name} returned the same result again (${prev.count} times). Quick self-check: the data is already in the conversation. If this is a loop, try a different approach; if not, carry on.` };
    } else {
      this.seen.set(fp, { outputHash, count: 1 });
    }

    // 2. Tool name frequency: same tool called too many times regardless
    //    of arguments or results. Catches loops where the model keeps
    //    hammering a tool with varied args (e.g. sleep 1, sleep 2, sleep 3, repeat).
    const freq = (this.toolFreq.get(name) ?? 0) + 1;
    this.toolFreq.set(name, freq);
    if (freq >= TOOL_FREQ_STOP)
      return { action: "stop", message: `${name} has been called ${freq} times this turn. Please review: if this is a loop, try a different approach to break out; if not, continue.` };
    if (freq >= TOOL_FREQ_WARN)
      return { action: "warn", message: `${name} has been called ${freq} times this turn. Please check whether you are in a loop. If yes, try an alternative approach; if not, continue.` };
    if (freq >= TOOL_FREQ_HINT)
      return { action: "hint", message: `${name} has been called ${freq} times this turn. Quick self-check: is this a loop? If yes, try a different approach; if not, carry on.` };

    return { action: "ok" };
  }

  /** afterToolCall hook for pi-agent-core. */
  makeAfterToolCall(opts?: {
    logPrefix?: string;
    /** Called when detection triggers (hint/warn/stop). Use to push
     *  a visible notification to the user's chat UI. */
    onDetected?: (action: LoopAction, message: string) => void;
  }) {
    const logPrefix = opts?.logPrefix ?? "[loop_detect]";
    return async (ctx: { toolCall: { name: string }; args: unknown; result: { content: Array<{ type: string; text?: string }> } }) => {
      // Check input pattern (streak + cycle)
      const check = this.check(ctx.toolCall.name, ctx.args);
      // Check input+output duplicate
      const dupCheck = this.checkResult(ctx.toolCall.name, ctx.args, ctx.result?.content);
      // Use the more severe result
      const severity: Record<string, number> = { ok: 0, hint: 1, warn: 2, stop: 3 };
      const effective = (severity[dupCheck.action] ?? 0) > (severity[check.action] ?? 0) ? dupCheck : check;
      log.info(`${logPrefix} tool=${ctx.toolCall.name} streak=${check.action} dup=${dupCheck.action} effective=${effective.action} calls=${this.calls.length} seen=${this.seen.size}`);
      if (effective.action === "ok") return undefined;
      log.warn(`${logPrefix} action=${effective.action} tool=${ctx.toolCall.name} calls=${this.calls.length}`);
      // Notify the chat UI
      opts?.onDetected?.(effective.action, effective.message!);
      // For stop/warn: terminate immediately within this turn by returning
      // { terminate: true } — pi-agent-core will stop executing further
      // tool calls in this batch. Also append the warning to the tool
      // result content so the model sees it.
      if (effective.action === "stop" || effective.action === "warn") {
        this._endReason = effective.message!;
        return {
          terminate: true,
          content: [
            ...ctx.result.content,
            { type: "text" as const, text: `\n\n⚠️ [Loop Detection] ${effective.message}` },
          ],
        };
      }
      // hint: append note to tool result but don't terminate
      return {
        content: [
          ...ctx.result.content,
          { type: "text" as const, text: `\n\n💡 [Loop Detection] ${effective.message}` },
        ],
      };
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
