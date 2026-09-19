// System-prompt construction for both the main chat agent and worker
// agents. Pure functions over the (ctx, userId, skills, plugin
// fragments) tuple — no DB writes, no side effects beyond optional
// fs.existsSync probes for context-file presence. Extracted from
// handler.ts so the 1782-line file stays focused on the runPrompt
// orchestration loop; agent-loop.ts already consumes most of these
// helpers and was the second-biggest caller before the split.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TenantContext } from "../core/index.js";
import type { LoadedSkill } from "../core/plugins/skills.js";

/**
 * Build the system prompt the orchestrator runs with.
 *
 * The prompt encodes the workspace scaffold defined in ADR-0001 so the
 * agent has a stable mental model of where things live:
 *
 *   - Default cwd is the user's per-tenant home (`users/<userId>/`).
 *   - Projects, uploads, scratch and trash all live under that home.
 *   - The shared `_tenant/` area is read-only by convention (team
 *     persona / memory / config).
 *
 * Tools currently expose a path model rooted at the user's home, so
 * paths in this prompt are written relative to `./` (= cwd) for
 * exactly that reason. When sandbox mounts land (PR #22+) the absolute
 * `/workspace/...` view will become real and we'll surface it here.
 *
 * Worker / task vocabulary is intentionally absent: workers don't ship
 * until PR #23+, and dangling references just let the model fabricate.
 */
/** Plugin-contributed system-prompt fragment (see
 *  `manifest.contributes.systemPromptFragments`). The handler
 *  pulls these from the plugin registry on every turn and injects
 *  them between the workspace section and the available-skills
 *  block, grouped by plugin so the agent can attribute the
 *  guidance. */
export interface PluginPromptFragment {
  pluginId: string;
  pluginDisplayName: string;
  fragmentId: string;
  text: string;
}

/** Applied-solution main-agent customisations. All optional;
 *  when omitted the prompt is the pure host default. */
export interface MainAgentPromptOverrides {
  /** Tenant prompt override block, injected after workspace
   *  context. null = none. */
  tenantPrompt?: string | null;
  /** Replacement text for host blocks. null/undefined = host
   *  default. */
  executionBias?: string | null;
  replyStyle?: string | null;
  userOnboarding?: string | null;
  /** Extra fragments appended near the end of the prompt. */
  customFragments?: ReadonlyArray<{ id: string; title: string; body: string }>;
}

/** One-line reply-language directive for the system prompt, or ""
 *  when set to auto/unset (let the model match the user). */
export function formatOutputLanguageLine(
  lang: "auto" | "en" | "zh" | undefined,
): string {
  if (lang === "en") return "Always reply in English, regardless of the language the user writes in.";
  if (lang === "zh") return "\u603b\u662f\u7528\u4e2d\u6587\u56de\u590d\uff0c\u65e0\u8bba\u7528\u6237\u7528\u4ec0\u4e48\u8bed\u8a00\u63d0\u95ee\u3002(Always reply in Chinese regardless of the user's language.)";
  return "";
}

/**
 * Runtime hint attached to a single turn. Currently only carries
 * whether the client has voice mode on so tianshu knows to append a
 * <voice_summary> block. Kept as a separate object rather than an
 * extra positional arg so we can add more per-turn hints later
 * without breaking every caller.
 */
export interface PerTurnPromptHints {
  /** When true, inject a voice-mode fragment asking tianshu to end
   *  its reply with a <voice_summary>...</voice_summary> block. */
  voiceMode?: boolean;
}

/**
 * Fragment injected when the client currently has voice mode on.
 *
 * Semantic: FULLY SPOKEN STYLE. The whole reply is written as if
 * you were talking to a colleague on a phone call — short sentences,
 * no markdown scaffolding, no code blocks unless absolutely needed.
 *
 * Yu, 2026-09-19 22:51: earlier iterations tried to keep the reply
 * looking like normal markdown + add a <silent> opt-out for machine
 * bits. Yu observed the visible bubble still felt "documenty" and
 * asked for the reply itself to adopt spoken style. This fragment
 * asks tianshu to write like it's speaking. <silent>...</silent> is
 * still available for the rare cases where a technical token must
 * appear on screen but shouldn't be spoken (a hash you asked for,
 * a file path).
 *
 * Kept tight — every sentence here costs on every voice-mode turn.
 */
function formatVoiceModeFragment(): string {
  return [
    `## Voice reply mode`,
    `The user has enabled voice mode. Write your reply as if you were talking to them on a phone call — the ENTIRE reply is spoken aloud.`,
    ``,
    `Style:`,
    `  - Short sentences. One idea per sentence.`,
    `  - Casual, natural spoken register in the user's language (usually 中文). If the user said "你好", answer as if you were speaking to them, not writing a report.`,
    `  - No markdown scaffolding: no headings, no bullet lists, no bold/italic markers, no tables. Prose only.`,
    `  - No code blocks. If code is unavoidable, keep it inline and short, and wrap it in <silent>...</silent> so TTS skips it.`,
    `  - No emoji, no ASCII art, no decorative separators.`,
    `  - Skip filler openers like "好的，我来为您……". Just answer.`,
    ``,
    `Length: keep it TO THE POINT. If a normal text reply would run 400 words with sections, the voice-mode version should be ~100–200 words of continuous prose. Don't drop information the user needs, but don't decorate it.`,
    ``,
    `<silent>...</silent> escape hatch: when a technical token MUST appear on screen but reading it aloud would sound wrong (hex hashes, file paths, long URLs, phone numbers), wrap that token in <silent>...</silent>. The visible bubble still shows the wrapped content; TTS just skips it.`,
    ``,
    `Example:`,
    `  已经把修复合进去了。你看下最新的 commit 就知道了，小尾巴是 <silent>7f3a8b2c</silent>。如果还有问题告诉我。`,
    ``,
    `Reminder: don't wrap the whole reply. Don't summarise — the user hears what you say.`,
  ].join("\n");
}

export function defaultSystemPrompt(
  ctx: TenantContext,
  userId: string,
  skills: readonly LoadedSkill[] = [],
  pluginFragments: readonly PluginPromptFragment[] = [],
  mainOverrides: MainAgentPromptOverrides = {},
  turnHints: PerTurnPromptHints = {},
): string {
  const brand = ctx.config.branding?.name ?? "Tianshu";
  const lines: string[] = [
    `You are ${brand}, an open-source AI assistant.`,
  ];

  // Default output language (Settings → Models → Output language).
  const langLine = formatOutputLanguageLine(ctx.config.outputLanguage);
  if (langLine) lines.push(langLine);

  // Runtime context (time / timezone / host / tenant + user).
  // Injected for every main-agent prompt build so the LLM never
  // has to guess "what day is it?" / "am I on macOS or Linux?" /
  // "what timezone is the user in?". The block also re-prints
  // tenantId + userId, replacing the bare "Tenant: ... User:
  // ..." line we used to emit here — same information, denser
  // format, single source of truth shared with the worker path
  // below.
  lines.push(``, formatRuntimeContextBlock({ tenantId: ctx.tenantId, userId }));

  // Workspace layout / directory conventions / file-reference
  // rules used to live here as a host-hardcoded block. Per
  // ADR-0006 they now belong to the `files` plugin's
  // `manifest.contributes.systemPromptFragments` and reach the
  // prompt via `formatPluginPromptFragments(pluginFragments)`
  // below — same path as every other plugin's guidance, and the
  // same path workers already take. Disabling the `files` plugin
  // cleanly drops its guidance from the prompt.
  //
  // The host stays plugin-agnostic, and main + worker prompts
  // reach symmetric layout text without the host having to inject
  // a separate workspace block on each side.

  // Execution Bias — host-level behaviour rules that shape every
  // turn, regardless of which plugins are loaded. Borrowed from
  // OpenClaw's main prompt because the failure modes it prevents
  // ("finish with a plan/promise instead of doing the work",
  // "weak tool result → give up rather than vary the query")
  // matched real stalls we saw on long task runs (PR #141
  // workboard tasks ending without task_complete being a typical
  // case). Phrasing kept tight on purpose: the LLM only needs the
  // rule, not a long argument for it.
  lines.push(
    ``,
    mainOverrides.executionBias != null
      ? mainOverrides.executionBias
      : formatExecutionBiasBlock(),
  );

  // Workspace context files. Each is optional; missing files emit
  // nothing. We inject content (not paths) so the agent has them
  // in context without having to read_file first.
  //
  // Layout:
  //   _tenant/AGENTS.md   — tenant working agreements (main agent)
  //   _tenant/SOUL.md     — main agent persona
  //   _tenant/MEMORY.md   — tenant long-term memory
  //   users/<userId>/USER.md — per-user preferences
  //
  // Files larger than the per-file cap get a head + tail snippet
  // with a [… truncated …] marker so a runaway log can't blow the
  // prompt budget.
  const userHomeDir = ctx.userHomeDir(userId);
  const ctxBlock = formatMainAgentContextBlock(
    ctx.workspaceDir,
    userHomeDir,
  );
  if (ctxBlock) lines.push("", ctxBlock);

  // Voice mode fragment. Injected before tenant prompt so the
  // agent sees the voice mode instruction FIRST (per-turn behaviour)
  // and can layer tenant-specific tenantPrompt guidance on top.
  if (turnHints.voiceMode) {
    lines.push("", formatVoiceModeFragment());
  }

  // Tenant prompt override (applied solution). Injected right
  // after workspace context so it reads as tenant-level guidance
  // layered on top of the workspace files.
  if (mainOverrides.tenantPrompt && mainOverrides.tenantPrompt.trim()) {
    lines.push("", mainOverrides.tenantPrompt);
  }

  // Plugin guidance + skills first; the User Profile rule lands
  // last on purpose because it overrides the "reply concisely"
  // / "delegate to a worker" defaults on the very first turn
  // when USER.md is still scaffold.
  lines.push(
    ``,
    mainOverrides.replyStyle != null
      ? mainOverrides.replyStyle
      : `Reply concisely. When you make changes, briefly say what you changed.`,
  );

  const fragmentBlock = formatPluginPromptFragments(pluginFragments);
  if (fragmentBlock) lines.push("", fragmentBlock);

  const skillBlock = formatAvailableSkillsBlock(skills);
  if (skillBlock) lines.push("", skillBlock);

  // Custom fragments from the applied solution — operator-authored
  // extra guidance, appended after skills (lower priority than
  // identity / tools, same tier as discoverable reference).
  for (const frag of mainOverrides.customFragments ?? []) {
    if (frag.body && frag.body.trim()) {
      lines.push("", `## ${frag.title}`, frag.body);
    }
  }

  // User onboarding rule — placed last so it wins recency-bias
  // over the brevity / delegate-to-worker rules above. Without
  // this position the LLM responds to a one-word "hi" by replying
  // "hi" back instead of capturing the user's profile.
  const hasUserFile = userMdExists(userHomeDir);
  lines.push(
    ``,
    mainOverrides.userOnboarding != null
      ? mainOverrides.userOnboarding
      : formatUserOnboardingBlock(hasUserFile),
  );

  // Final pass: bind `<self>` / `<userId>` placeholders that
  // appear anywhere in the assembled prompt (manifest fragments,
  // tool descriptions, context-block labels, our own onboarding
  // text) to the caller's actual userId. Plugin authors can't
  // know the runtime value, so they ship the placeholder; we
  // substitute here. Without this the LLM has been observed to
  // hallucinate a userId (`user1`, `user3`, `user_x`) and burn a
  // run on a path that doesn't exist.
  return substituteUserIdPlaceholders(lines.join("\n"), userId);
}

/**
 * Whether `users/<self>/USER.md` already exists for the caller.
 * Wraps the same fs check the context block uses, but exported
 * separately so the onboarding prompt can branch its wording
 * without re-reading the file content.
 */
export function userMdExists(userHomeDir: string): boolean {
  try {
    const p = path.join(userHomeDir, "USER.md");
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * User onboarding block. Tells main agents to actively curate the
 * per-user USER.md — ask before going off-script, then write what
 * was learnt back so future runs start with concrete preferences.
 *
 * Branches on whether USER.md exists today. The cold-start wording
 * is more proactive ("propose to start one"); the populated
 * wording skips the proposal step and only nudges on missing /
 * stale facts. Both versions are short — the LLM doesn't need a
 * lecture, just the rule + the file path to write to.
 */
export function formatUserOnboardingBlock(userMdPresent: boolean): string {
  // Same prompt regardless of whether the file exists — the LLM
  // makes the call by inspecting the Workspace Context block above.
  // (We tried branching on `userMdExists` but a USER.md that's
  // just the empty template scaffolding got treated as "populated"
  // and the cold-start questions never fired. Pushing the
  // "populated vs scaffold" judgement into the LLM is more robust
  // than parsing markdown templates here.)
  void userMdPresent;
  return [
    `## User Profile (USER.md) — read this first`,
    `Look at \`### users/<self>/USER.md\` in the Workspace Context block above and decide right now whether it's POPULATED or a SCAFFOLD.`,
    `- POPULATED = real concrete entries (real name, the user's actual projects, communication preferences they've stated, etc.)`,
    `- SCAFFOLD = mostly headings + italics hints + empty form fields like \`**Name:**\` / \`**Pronouns:**\` / a single seeded value (e.g. a default time zone) with everything else blank.`,
    `On a fresh conversation where USER.md is missing OR a scaffold:`,
    `1. Even if the user just says "hi", do NOT just reply hi back. First proactively ask 3-5 short questions to fill USER.md (preferred name, current projects, communication style, anything that should never be forgotten). Keep it conversational, not a form.`,
    `2. When they answer, immediately \`write_file({ path: "USER.md", content: ... })\` (relative path resolves to their workspace home) with what you learnt, plus a one-line ack like "saved that to your profile".`,
    `3. If they explicitly decline, drop it for this run — don't re-ask the same session.`,
    `On a populated USER.md: don't ask the intro questions again. Just keep it accurate during normal work — when a durable new fact surfaces, \`edit_file\` it in. Fix stale entries when contradicted. Don't announce these edits unless they're material.`,
    `This rule wins over any "reply concisely" or "delegate first" guidance above — first-time profile capture is more valuable than a short hi.`,
  ].join("\n");
}

/**
 * Host-level Execution Bias block. Exported so the worker
 * agent-loop path (which builds its own systemPrompt by
 * concatenating SOUL + fragments + skills, bypassing
 * defaultSystemPrompt) can include the same rules without copying
 * the strings.
 */
/**
 * Runtime context the LLM almost always wants but doesn't get
 * for free from the conversation history: wall-clock time,
 * timezone, host OS. Injected for BOTH main and worker prompts
 * so an agent that needs "what day is today?" / "am I on macOS
 * or Linux?" / "what timezone is the user in?" doesn't have to
 * ask or guess.
 *
 * We re-render on every prompt build so the time stamps stay
 * fresh across turns of a long session. Cheap (a handful of
 * Date / Intl calls per build).
 *
 * Format is markdown so it stitches into the prompt the same
 * way the other helpers in this file do; the section title
 * matches our convention (`## <Title>`).
 *
 * Time format: ISO-8601 with timezone offset (e.g.
 * `2026-06-23T23:45:12+08:00`). Provider models all parse this
 * cleanly; no provider has a known regression with it.
 */
export function formatRuntimeContextBlock(opts: {
  tenantId: string;
  userId: string;
  brand?: string;
}): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // ISO with local offset, not UTC — "now" matches the wall clock
  // the user is reading. Date.toISOString() prints Z; we re-derive
  // the offset by hand to avoid the date-fns/luxon dependency.
  const isoWithOffset = formatLocalIso(now);
  // Weekday helps a model reason about "is it the weekend?" type
  // questions without an extra computation step.
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const lines: string[] = [
    `## Runtime Context`,
    `- Time: ${isoWithOffset} (${weekday}, timezone ${tz})`,
    `- Tenant: \`${opts.tenantId}\` · User: \`${opts.userId}\``,
    `- Host: ${os.platform()} ${os.arch()} · Node ${process.versions.node}`,
  ];
  if (opts.brand) {
    // Branding line is informational — the assembled prompt's
    // first sentence already states "You are <brand>...", so we
    // skip it here unless the caller passes one explicitly.
    lines.splice(1, 0, `- Assistant identity: ${opts.brand}`);
  }
  return lines.join("\n");
}

/**
 * `2026-06-23T23:45:12+08:00` from a Date in local time. The
 * native `toISOString()` always renders UTC, which is
 * conventional but obscures "what time is it where I am?". We
 * surface the local view because that's what humans (and the
 * LLM, when answering them) reason in.
 */
function formatLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  const off = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = off >= 0 ? "+" : "-";
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`;
}

export function formatExecutionBiasBlock(): string {
  return [
    `## Execution Bias — Loop Agent Mode`,
    ``,
    `You are a **loop agent**: upon receiving a request, execute autonomously until the task is fully complete before replying to the user.`,
    ``,
    `### IRON RULE: Never ask permission to continue`,
    ``,
    `The single most common failure mode is stopping mid-task to ask "要我继续吗 / 要不要我接着做 / do you want me to X / should I continue / 需要我继续么 / 可以开始吗". This is forbidden. If your next reply would end with any of the following phrases (in any language), delete that reply and DO the thing instead:`,
    ``,
    `- "要我继续操作吗", "要不要继续", "要我接着做吗", "需要我继续么", "要不要我帮你…"`,
    `- "接下来要不要…", "可以开始了吗", "确认一下…吗", "你看如何", "如果可以的话…"`,
    `- "Want me to X?", "Should I continue?", "Shall I proceed?", "Ready to X?"`,
    `- "Let me know if you want me to X", "Say the word and I'll X", "Just say go"`,
    `- A recommendation followed by asking the user to pick, when the recommendation itself is sound`,
    ``,
    `The user already told you what to do by opening this session and describing the goal. Every mid-task question is a tax on their attention. Just proceed.`,
    ``,
    `### The rest`,
    `1. **Loop until done** — A request may need many steps (search→read→analyze→write→verify→retry). Do all of them. Report once at the end, not after each step.`,
    `2. **No plans, only results** — Don't reply "I'll do X then Y" and wait. Do X and Y, then report what you did. "Here's what I would do" is not a reply; "Here's what I did" is.`,
    `3. **Weak results → retry differently** — Empty/weak tool output? Change query, path, or method and retry. Don't hand a shrug back to the user.`,
    `4. **Ambiguity resolves toward the obvious interpretation** — If two interpretations exist and one is 90% likely, act on that one and STATE the assumption in your final report. Don't stop to disambiguate the 10%.`,
    ``,
    `### The only three times you may stop and ask`,
    ``,
    `1. **Credentials / secrets you cannot obtain** — API key, password, one-time token that isn't in the environment.`,
    `2. **Truly destructive & irreversible** — bulk delete of user data, force-push to protected branch, wire transfer. NOT: overwriting a file inside a git repo (undo with git), NOT: sending a chat message.`,
    `3. **Genuinely divergent branches** — the user asked something whose interpretations lead to opposite outcomes ("delete X" — do they mean the row, the table, or the whole database?) AND you cannot pick the safer default.`,
    ``,
    `If your reason for stopping doesn't fit one of those three, it doesn't fit. Proceed.`,
    ``,
    `### Worked examples`,
    ``,
    `- User: "clone this repo" → clone it, cd in, read the top-level files, summarise. Don't ask "want me to read it?"`,
    `- User: "看看为什么断了" → grep logs, correlate timestamps, find the cause, propose a fix. Don't ask "要不要我开始排查".`,
    `- User: "fix the failing test" → read the test, read the code under test, patch, re-run. Don't ask "want me to try approach A or B?" — pick one, try it, fall back to the other if it fails.`,
    `- Tool call fails → read the error, adjust, retry. Don't ask the user what to do.`,
    `- A recovery / auto-continue notification wakes you (e.g. after context compaction or a transient provider error) → pick up where you left off and finish the task. Don't ask "需要我接着吗" — the whole point of the recovery was to keep going.`,
    ``,
    `### Verification (do this INSIDE the loop, before reporting)`,
    `- File operations: read the file back and confirm the change is there.`,
    `- Research: cite reliable sources.`,
    `- Code changes: compile / lint / re-run tests.`,
    `- Shell/exec: check exit code, read relevant output.`,
  ].join("\n");
}

// Per-file cap (in bytes). Files bigger than this get truncated
// with a head + tail snippet so the prompt stays bounded even
// when AGENTS.md / SOUL.md / MEMORY.md grow into multi-page docs.
const WORKSPACE_FILE_HEAD_BYTES = 4_000;
const WORKSPACE_FILE_TAIL_BYTES = 1_000;
const WORKSPACE_FILE_FULL_CAP_BYTES = 6_000;

/** Each entry inside the Workspace Context section. */
interface ContextFileSpec {
  /** Absolute path on disk. */
  absPath: string;
  /** Label rendered as the section title (e.g. `_tenant/AGENTS.md`). */
  label: string;
}

/**
 * Read a workspace file from `userHome`, returning its (possibly
 * truncated) content or null when the file doesn't exist or is
 * unreadable. We swallow read errors deliberately — missing files
 * are the steady state and an unreadable file should never break
 * prompt assembly.
 */
function readWorkspaceFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return null;
    if (stat.size <= WORKSPACE_FILE_FULL_CAP_BYTES) {
      return fs.readFileSync(filePath, "utf8");
    }
    // Big file: head + tail.
    const fd = fs.openSync(filePath, "r");
    try {
      const headBuf = Buffer.alloc(WORKSPACE_FILE_HEAD_BYTES);
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      const tailBuf = Buffer.alloc(WORKSPACE_FILE_TAIL_BYTES);
      fs.readSync(
        fd,
        tailBuf,
        0,
        tailBuf.length,
        Math.max(0, stat.size - tailBuf.length),
      );
      const omitted = stat.size - headBuf.length - tailBuf.length;
      return [
        headBuf.toString("utf8"),
        ``,
        `[… ${omitted} bytes truncated …]`,
        ``,
        tailBuf.toString("utf8"),
      ].join("\n");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Render a Workspace Context section from a list of files. Each
 * present file becomes a `### <label>` block so the agent can
 * attribute statements ("per `_tenant/AGENTS.md` the team
 * prefers X"). Returns an empty string when none of the files
 * exist on disk.
 */
function renderContextBlock(specs: readonly ContextFileSpec[]): string {
  const sections: string[] = [];
  for (const spec of specs) {
    const content = readWorkspaceFile(spec.absPath);
    if (content === null) continue;
    sections.push(`### ${spec.label}`, content.trimEnd());
  }
  if (sections.length === 0) return "";
  return [`## Workspace Context`, ``, ...sections].join("\n");
}

/**
 * Main-agent context: tenant-shared working files plus the
 * caller's per-user USER.md. SOUL / MEMORY / AGENTS live at the
 * tenant root because they're team-wide; USER.md is the only
 * per-user file because it captures preferences that don't
 * generalise.
 */
export function formatMainAgentContextBlock(
  workspaceDir: string,
  userHome: string,
): string {
  const tenantRoot = path.join(workspaceDir, "_tenant");
  return renderContextBlock([
    { absPath: path.join(tenantRoot, "AGENTS.md"), label: "_tenant/AGENTS.md" },
    { absPath: path.join(tenantRoot, "SOUL.md"), label: "_tenant/SOUL.md" },
    { absPath: path.join(tenantRoot, "MEMORY.md"), label: "_tenant/MEMORY.md" },
    { absPath: path.join(userHome, "USER.md"), label: "users/<self>/USER.md" },
  ]);
}

/**
 * Worker-agent context: the worker's own bundle (AGENTS.md /
 * MEMORY.md — SOUL.md is already injected upstream via
 * req.systemPrompt) plus the caller's USER.md. Workers don't
 * read the tenant-shared SOUL/AGENTS/MEMORY because each worker
 * has its own personality + own long-term notes scoped to its
 * specialisation.
 */
export function formatWorkerAgentContextBlock(
  workspaceDir: string,
  userHome: string,
  workerSlug: string,
): string {
  const bundleRoot = path.join(
    workspaceDir,
    "_tenant",
    "config",
    "workers",
    workerSlug,
  );
  return renderContextBlock([
    {
      absPath: path.join(bundleRoot, "AGENTS.md"),
      label: `_tenant/config/workers/${workerSlug}/AGENTS.md`,
    },
    {
      absPath: path.join(bundleRoot, "MEMORY.md"),
      label: `_tenant/config/workers/${workerSlug}/MEMORY.md`,
    },
    { absPath: path.join(userHome, "USER.md"), label: "users/<self>/USER.md" },
  ]);
}

/**
 * Backwards-compatible thin wrapper. The previous shape pointed
 * to user home only; kept as an alias for tests / external
 * callers but new code should use formatMainAgentContextBlock.
 */
export function formatWorkspaceContextBlock(userHome: string): string {
  return renderContextBlock([
    { absPath: path.join(userHome, "AGENTS.md"), label: "AGENTS.md" },
    { absPath: path.join(userHome, "SOUL.md"), label: "SOUL.md" },
    { absPath: path.join(userHome, "USER.md"), label: "USER.md" },
  ]);
}

/**
 * Replace `<self>` and `<userId>` placeholders with the caller's
 * concrete userId throughout an assembled system prompt.
 *
 * Plugin manifests + tool descriptions write paths like
 * `/workspace/users/<self>/...` because the plugin author can't
 * know the runtime userId. Without substitution the LLM sees a
 * literal `<self>` and either invents a userId (we caught
 * `user1` / `user3` / `user_x` in production) or just guesses
 * wrong. Substituting at the very end of prompt assembly — after
 * SOUL, plugin fragments, context block, skills are all stitched
 * together — means every appearance of these placeholders
 * resolves to the right value, regardless of which layer wrote
 * it.
 *
 * Idempotent and safe to call on prompts that don't contain
 * either placeholder.
 */
export function substituteUserIdPlaceholders(
  prompt: string,
  userId: string,
): string {
  if (!userId) return prompt;
  return prompt
    .replace(/<self>/g, userId)
    .replace(/<userId>/g, userId);
}

/** Render plugin-contributed system-prompt fragments. Grouped by
 *  plugin so the agent sees one section per plugin (workboard
 *  rules in one block, microsandbox rules in another, etc), and
 *  so debugging prompts is straightforward ("this guidance came
 *  from plugin X"). Returns an empty string when no fragments
 *  are contributed. */
export function formatPluginPromptFragments(
  fragments: readonly PluginPromptFragment[],
): string {
  if (fragments.length === 0) return "";
  const byPlugin = new Map<
    string,
    { displayName: string; texts: string[] }
  >();
  for (const f of fragments) {
    const slot = byPlugin.get(f.pluginId);
    if (slot) {
      slot.texts.push(f.text);
    } else {
      byPlugin.set(f.pluginId, {
        displayName: f.pluginDisplayName,
        texts: [f.text],
      });
    }
  }
  const lines: string[] = ["## Plugin guidance"];
  for (const [pid, slot] of byPlugin) {
    lines.push(``, `### ${slot.displayName} (${pid})`);
    for (const t of slot.texts) {
      lines.push(t.trim());
    }
  }
  return lines.join("\n");
}

/**
 * Render the `<available_skills>` block that's appended to every
 * system prompt — the host default prompt for the main chat agent,
 * AND any custom worker prompt coming from `worker_agents.system_prompt`.
 *
 * Worker LLMs need this just as badly as the main agent: without
 * it they only see plugin-shipped skills via `tenant_config_list`,
 * not their per-tenant ones. Workers ship a kind-specific
 * `system_prompt` in the worker_agents table, and the agent-loop
 * bypasses `defaultSystemPrompt` when that's set; so we expose the
 * skill block as a reusable helper and the loop appends it after
 * the kind-specific prompt.
 *
 * Returns "" when the skills list is empty so callers can drop the
 * block entirely (no leading blank lines, no half-empty XML).
 */
export function formatAvailableSkillsBlock(
  skills: readonly LoadedSkill[],
): string {
  if (skills.length === 0) return "";
  const lines: string[] = [
    `## Skills`,
    `Scan <available_skills>. If one clearly applies, read its SKILL.md at the exact <location> with \`tenant_config_read\`, then follow it. All skill locations are tenant-config:/// URIs — host / plugin skills are mirrored into the tenant config tree at boot, so one tool reads them all.`,
    `If several apply, choose the most specific. If none clearly apply, read none.`,
    `One skill up front max. Never guess/fabricate skill paths.`,
    `Skill bundles may ship sibling files (\`scripts/\`, \`references/\`, \`assets/\`) next to SKILL.md — those still go through the regular file tools (\`read_file\` for workspace paths, \`tenant_config_read\` for tenant-config paths) using the relative paths SKILL.md mentions.`,
    ``,
    `<available_skills>`,
  ];
  for (const skill of skills) {
    lines.push(
      `  <skill>`,
      `    <name>${skill.name}</name>`,
      `    <description>${skill.description}</description>`,
      `    <location>${skillLocationUri(skill)}</location>`,
      `  </skill>`,
    );
  }
  lines.push(`</available_skills>`);
  return lines.join("\n");
}

/** Build the location URI we expose to the agent for a skill.
 *
 *  - Tenant skills (loaded via `loadTenantSkills`) get a
 *    `tenant-config:///...` URI rooted at `_tenant/config/`.
 *  - Host + plugin skills (read-only, shipped on disk under host
 *    or plugin dirs) fall back to their absolute filePath — the
 *    agent can't read them anyway through `tenant_config_read`,
 *    but the URI gives it a stable identifier to mention.
 */
function skillLocationUri(skill: LoadedSkill): string {
  // Every skill that lives under a tenant config tree — user-
  // authored, plugin-mirrored, host-mirrored — emits a portable
  // `tenant-config:///<rest>` URI. The pluginId no longer
  // matters here; the mirror layer in the registry stamps
  // plugin/host skills with `_tenant/config/skills/_host/...`
  // filePaths just like user skills.
  const idx = skill.filePath.indexOf("_tenant/config/");
  if (idx >= 0) {
    const rel = skill.filePath
      .slice(idx + "_tenant/config/".length)
      .replace(/\\/g, "/");
    return `tenant-config:///${rel}`;
  }
  // Fall-through: a skill whose filePath isn't under _tenant/
  // config/. This shouldn't happen post-mirror; if it does, we'd
  // rather surface the absolute path than silently hide the
  // skill, so the agent can at least diagnose the gap.
  return skill.filePath;
}

