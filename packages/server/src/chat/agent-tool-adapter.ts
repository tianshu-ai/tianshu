// Adapter: tianshu plugin `AgentTool` (sdk shape) → pi-agent-core `AgentTool`.
//
// Why this exists:
//   * Plugin authors keep using the simpler tianshu shape:
//       execute(args, ctx) → { ok, text, ... }
//     which we don't want to break or re-architect across every
//     plugin in this repo (files, microsandbox, workboard).
//   * The agent loop uses pi-agent-core, whose tool contract is
//     richer:
//       execute(toolCallId, params, signal, onUpdate) → AgentToolResult
//   * The adapter wraps each plugin tool into the pi shape: it
//     forwards args, normalises return shapes via the same
//     `normaliseToolResult` the chat handler already uses, and
//     translates `ok=false` returns into AgentToolResult `isError`.
//
// One subtlety worth flagging: pi's contract says `execute()` should
// THROW on failure rather than encode errors in the content array.
// Our plugin tools, by long-standing convention, return
// `{ ok: false, text: "..." }` instead of throwing. The adapter
// converts that pattern into an AgentToolResult with the same text
// content but does NOT throw — pi's `runAgentLoop` already supports
// "soft failures" via the ToolResultMessage's `isError` flag, but
// tianshu plugins want them to be visible to the LLM verbatim.
// Tracked in workers.md §7.2.

import type {
  AgentTool as PiAgentTool,
  AgentToolResult,
} from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent, Tool as PiTool } from "@earendil-works/pi-ai";
import type { Toolset } from "../tools/index.js";

export interface AnyToolResult {
  ok: boolean;
  text: string;
  /** Optional images to include in the tool result so the vision
   *  model can SEE them this turn. pi-ai's ToolResultMessage.content
   *  is (TextContent | ImageContent)[] natively; we pass these
   *  through. base64 is the image bytes (no data: prefix). */
  images?: Array<{ base64: string; mimeType?: string }>;
}

/** Normalise a plugin-returned `images` field (each entry may be a
 *  `{ base64, mimeType }` or a data: URL string) into the internal
 *  shape. Silently drops malformed entries. */
function extractImages(out: unknown): AnyToolResult["images"] {
  const raw = (out as { images?: unknown } | null | undefined)?.images;
  if (!Array.isArray(raw)) return undefined;
  const imgs: NonNullable<AnyToolResult["images"]> = [];
  for (const it of raw) {
    if (typeof it === "string") {
      const m = /^data:([^;]+);base64,(.*)$/.exec(it);
      if (m) imgs.push({ base64: m[2]!, mimeType: m[1] });
      else imgs.push({ base64: it });
    } else if (it && typeof it === "object" && typeof (it as { base64?: unknown }).base64 === "string") {
      const o = it as { base64: string; mimeType?: string };
      imgs.push({ base64: o.base64, mimeType: typeof o.mimeType === "string" ? o.mimeType : undefined });
    }
  }
  return imgs.length ? imgs : undefined;
}

/**
 * Normalise an executor's structured return value to `{ ok, text }`.
 * Two shapes are accepted:
 *
 *   1. Fs-style: `{ ok: boolean, text: string, ...extras }` — used
 *      as-is.
 *   2. Anything else: JSON-encoded into `text`. `ok` is derived
 *      from common hints (`ok`, `exit_code`, `state`) and defaults
 *      to true when there's no clear signal.
 *
 *  Lives in the adapter file because it's the only consumer now
 *  that the host's chat handler runs through pi-agent-core.
 */
export function normaliseToolResult(out: unknown): AnyToolResult {
  if (
    out &&
    typeof out === "object" &&
    typeof (out as { text?: unknown }).text === "string" &&
    typeof (out as { ok?: unknown }).ok === "boolean"
  ) {
    const r = out as { ok: boolean; text: string };
    return { ok: r.ok, text: r.text, images: extractImages(out) };
  }
  if (out && typeof out === "object") {
    const r = out as Record<string, unknown>;
    let ok = true;
    if (typeof r.ok === "boolean") ok = r.ok;
    else if (typeof r.exit_code === "number") ok = r.exit_code === 0;
    else if (typeof r.state === "string")
      ok = r.state !== "error" && r.state !== "failed";
    return { ok, text: JSON.stringify(out) };
  }
  return { ok: true, text: String(out ?? "") };
}

export interface AdaptedToolset {
  /** pi-agent-core tools, ready to drop into AgentContext.tools. */
  tools: PiAgentTool[];
  /** Tool name → original plugin executor. Useful when the host
   *  needs to peek (e.g. agent-loop's task_complete capture). */
  executors: Toolset["executors"];
}

export function adaptToolset(toolset: Toolset): AdaptedToolset {
  // Per-toolset truncation counter. The toolset is freshly built
  // per agent loop run (chat handler / worker pool), so this map
  // covers "this agent's lifetime" — the natural granularity
  // for an escalation rule. Resetting between turns would let a
  // model thrash forever: hit truncation once per turn, get the
  // permissive message, repeat. Persisting across turns lets us
  // catch "second time the same tool ate truncation" reliably.
  const truncationCount = new Map<string, number>();
  const tools: PiAgentTool[] = toolset.schemas.map((schema) => {
    const exec = toolset.executors[schema.name];
    const piTool: PiAgentTool = {
      ...schema,
      // pi-agent-core requires a `label` (UI display); fall back to
      // the schema name. Plugin-side schema doesn't carry one yet.
      label: schema.name,
      // Default execution mode "sequential" matches the legacy
      // tianshu chat handler behaviour (one tool at a time). We can
      // flip individual plugin tools to "parallel" later when their
      // contract documents thread-safety.
      executionMode: "sequential",
      // pi-agent-core calls `prepareArguments` BEFORE schema
      // validation. We use it to detect Anthropic stream
      // truncation — a frequent failure mode where the
      // assistant emits a tool_use block whose input_json never
      // finishes streaming, so the framework receives `{}` (or a
      // partial dict missing required fields). The default error
      // message ("must have required property X") looks like a
      // model mistake, so the model dutifully retries the tool
      // call AND HITS THE SAME TRUNCATION. By throwing a more
      // diagnostic error here — in pi-agent-core's prepare phase,
      // which still gets converted into an immediate error tool
      // result — we tell the model what actually happened so it
      // changes strategy on the retry (often: re-issue the call
      // earlier in the turn before context bloats).
      prepareArguments: (raw: unknown) => {
        const truncated = detectStreamTruncation(schema, raw);
        if (truncated) {
          // Escalate on repeat. After the first truncation the
          // model already saw the standard hint ("re-issue first,
          // keep fields concise, use skeleton-then-fill"). If it
          // hits truncation a second time on the same tool inside
          // the same agent run, hinting harder rarely helps — the
          // model is stuck. Switch to a fatal-flavored message
          // that explicitly forbids the bad pattern and tells it
          // exactly which alternative tools to call.
          const prior = truncationCount.get(schema.name) ?? 0;
          truncationCount.set(schema.name, prior + 1);
          if (prior >= 1) {
            throw new Error(formatRepeatTruncationError(schema.name, prior + 1));
          }
          throw new Error(truncated);
        }
        return raw;
      },
      execute: async (
        _toolCallId: string,
        params: unknown,
        _signal?: AbortSignal,
      ): Promise<AgentToolResult<unknown>> => {
        const args =
          params && typeof params === "object"
            ? (params as Record<string, unknown>)
            : {};
        if (!exec) {
          // Should be unreachable — schema came from the same map.
          return {
            content: [
              { type: "text", text: `unknown tool: ${schema.name}` } as TextContent,
            ],
            details: undefined,
          };
        }
        // Plugin tools are sync OR async; both are fine.
        const raw = await Promise.resolve(exec(args));
        const norm = normaliseToolResult(raw);
        // Tool text first, then any images the tool returned so the
        // vision model sees them this turn (pi ToolResultMessage.content
        // is (Text | Image)[]). Images are opt-in per call — most tools
        // return none, so this stays zero-overhead by default.
        const content: (TextContent | ImageContent)[] = [
          { type: "text", text: norm.text } as TextContent,
        ];
        for (const img of norm.images ?? []) {
          content.push({
            type: "image",
            data: img.base64,
            mimeType: img.mimeType ?? "image/png",
          } as ImageContent);
        }
        const result: AgentToolResult<unknown> = {
          content,
          // Stash the raw tool result on `details` so future UI
          // bits (chat panel rendering) can introspect it without
          // re-parsing the text.
          details: raw,
        };
        if (!norm.ok) {
          // pi-agent-core has no boolean on AgentToolResult itself
          // — it routes "isError" via the afterToolCall hook or
          // via promise rejection. We piggyback on the surrounding
          // run's afterToolCall to flip isError when this happens
          // (caller wires that up).
          (result as AgentToolResult<unknown> & { __ok: boolean }).__ok = false;
        }
        return result;
      },
    };
    return piTool;
  });
  return { tools, executors: toolset.executors };
}

/** Helper for the surrounding agent run: detect whether a finished
 *  AgentToolResult came from a `{ ok:false }` plugin return, so
 *  pi-agent's `afterToolCall` can mark it as an error to the LLM. */
export function isAdapterError(result: unknown): boolean {
  return Boolean(
    (result as { __ok?: boolean } | null | undefined)?.__ok === false,
  );
}

/**
 * Heuristic: did Anthropic / Bedrock truncate the tool_use input
 * stream before the assistant finished serialising arguments?
 *
 * Returns a diagnostic message when truncation is the most likely
 * explanation; the caller (prepareArguments hook) throws it so
 * the model sees a clear "stream cut, retry differently" prompt
 * instead of pi-ai's default schema error.
 *
 * Two signal cases — both confined to "the framework received
 * suspiciously little JSON, AND the schema clearly expected more":
 *
 *   1. params is null / not an object → received nothing at all.
 *   2. params is an object missing one or more required fields.
 *      We list the missing ones; the model can usually tell from
 *      the names which call it tried to make.
 *
 * If the model legitimately omitted a required field on its own
 * (rare but possible — bad system prompt, distracted run), the
 * message still helps it: "you didn't pass X" is true either
 * way, only the "stream may have been truncated" hint is
 * speculative. We word it accordingly.
 */
function detectStreamTruncation(
  schema: PiTool,
  rawArgs: unknown,
): string | null {
  const required = extractRequiredKeys(schema);
  if (required.length === 0) return null;

  if (rawArgs == null || typeof rawArgs !== "object") {
    return formatTruncationError(schema.name, required, required);
  }
  const args = rawArgs as Record<string, unknown>;
  const missing = required.filter((k) => !(k in args));
  if (missing.length === 0) return null;
  // If MOST of the required fields are missing AND args has zero
  // present keys, treat it as full truncation (the most common
  // shape we've actually observed). Otherwise it's just a
  // partial — still worth flagging, but with a slightly softer
  // hint.
  return formatTruncationError(schema.name, required, missing);
}

function extractRequiredKeys(schema: PiTool): string[] {
  // pi-ai uses TypeBox JSON-schema-ish objects. The `required`
  // field is a top-level array of strings. Defensive: the schema
  // may not carry it (Type.Object infers required from non-Optional
  // members at compile time and stamps the array onto the JSON
  // schema, but plugin authors could in principle hand-craft a
  // schema without one).
  const params = (schema as { parameters?: { required?: unknown } }).parameters;
  const req = params?.required;
  if (!Array.isArray(req)) return [];
  return req.filter((k): k is string => typeof k === "string");
}

function formatTruncationError(
  toolName: string,
  required: string[],
  missing: string[],
): string {
  const reqList = required.map((k) => `\`${k}\``).join(", ");
  const missList = missing.map((k) => `\`${k}\``).join(", ");
  const suspectsTruncation = missing.length === required.length;
  const head = suspectsTruncation
    ? `Tool call to \`${toolName}\` arrived with empty arguments — the model's tool_use input stream may have been truncated by the provider before parameters finished serialising.`
    : `Tool call to \`${toolName}\` is missing required field${missing.length === 1 ? "" : "s"} ${missList}. This often means the provider truncated the tool_use input stream mid-write.`;
  const requiredHint = `Required: ${reqList}.`;
  const retryAdvice =
    "To retry: re-issue the tool call as the FIRST action in your next assistant turn (no preamble text), and keep `description` / `content` / similar long fields concise. If you keep hitting the same truncation, switch tactics — use the skeleton-then-fill pattern (write a short scaffold first, then fill sections via batch `edit_file`) instead of one giant call.";
  return `${head} ${requiredHint} ${retryAdvice}`;
}

/**
 * Second-time truncation on the same tool in the same agent run.
 * The model has already seen the permissive hint and ignored it,
 * so we make the failure mode explicit and prescribe one specific
 * alternative — "don't call this tool again, use these instead".
 *
 * Tool-specific advice covers the two we actually see thrash:
 *   - write_file / tenant_config_write → skeleton + edit_file
 *   - everything else → generic "split the call into smaller chunks"
 *
 * The wording is intentionally direct ("STOP calling") because the
 * permissive version above already failed; subtle is for first-
 * time messages, not for the loop-breaker.
 */
function formatRepeatTruncationError(
  toolName: string,
  attempts: number,
): string {
  const head =
    `Tool call to \`${toolName}\` truncated again (attempt ${attempts}). ` +
    "The first hint did not change the outcome, so the call shape " +
    "itself is the problem.";
  const isWriter =
    toolName === "write_file" || toolName === "tenant_config_write";
  const prescription = isWriter
    ? `STOP calling \`${toolName}\` with a large \`content\` payload. Instead:\n` +
      `  1. Call \`${toolName}\` ONCE with a small skeleton (title, ` +
      `headings, and \`<!-- TODO: section X -->\` placeholders only).\n` +
      "  2. Use `edit_file` (or `tenant_config_edit`) with `edits[]` to " +
      "replace each placeholder with its real content. The batch form " +
      "of edit_file accepts multiple disjoint replacements in one call " +
      "— plan two or three sections per edit_file call rather than one " +
      "giant write.\n\n" +
      "Read the `large-input-large-output` skill for the worked example. " +
      "Do not attempt another `write_file` with the same content shape; " +
      "the next attempt will fail the same way."
    : `STOP retrying \`${toolName}\` with the same shape. Split the request ` +
      "into smaller calls (fewer items, shorter strings) before calling it " +
      "again. The provider's tool-use input stream cannot accept the size " +
      "of payload you keep submitting.";
  return `${head}\n\n${prescription}`;
}
