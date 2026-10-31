// Experience Harvester — two-phase manual pipeline.
//
// Step 1 (Organise): Walk session turns, segment into events with
//   turnFrom/turnTo/taskId, classify by category.
//   Output → knowledgeBase/harness2/events/<sessionId-short>.json
//
// Step 2 (Analyse): Read all event files, group by category, compare
//   good vs bad outcomes, extract best practices.
//   Output → knowledgeBase/harness2/insights/<category>.md

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Context, TextContent, UserMessage } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionChain } from "./session-chain.js";
import { loadTenantSkills } from "../core/tenant-skills.js";
import type { LoadedSkill } from "../core/plugins/skills.js";

import type { TenantContext } from "../core/index.js";
import { buildModel, resolveApiKey, type ResolvedModelInfo } from "../core/index.js";
import type { ModelResilienceConfig } from "../core/config.js";
import { resolveResilience, retryCompletion } from "../core/model-retry.js";
import { createLogger } from "../setup/logger.js";

const log = createLogger("experience-harvester");

const KB_DIR = "knowledgeBase";
const HARNESS2_DIR = "harness2";
const EVENTS_DIR = "events";
const INSIGHTS_DIR = "insights";
const MAX_TOKENS = 4000;

// ── In-memory progress tracker ──────────────────────────────────

interface HarvestProgress {
  step: "organise" | "analyse" | "idle";
  current: number;
  total: number;
  label?: string; // current session / category being processed
}

const progressByUser = new Map<string, HarvestProgress>();

export function getHarvestProgress(userId: string): HarvestProgress {
  return progressByUser.get(userId) ?? { step: "idle", current: 0, total: 0 };
}

export function setProgress(userId: string, p: HarvestProgress) {
  progressByUser.set(userId, p);
}

// ── Types ───────────────────────────────────────────────────────

export interface SessionEvent {
  sessionId: string;
  turnFrom: number;
  turnTo: number;
  taskId?: string;
  label: string;
  category: string;
  turnCount: number;
  summary: string;
  outcome?: string; // good | bad | mixed
}

export interface EventFile {
  sessionId: string;
  createdAt: string;
  events: SessionEvent[];
}

export interface CategoryInsight {
  category: string;
  eventCount: number;
  bestPractices: string[];
  antiPatterns: string[];
  toolUsage: string[];
  recommendations: string;
}

// ── Step 1: Organise ────────────────────────────────────────────

const SEGMENT_PROMPT = `You are analysing a conversation between a user and an AI assistant. Segment it into distinct "events" — coherent units of work.

For each event, output a JSON object on its own line (JSON Lines format):

{"turnFrom": <first turn>, "turnTo": <last turn>, "taskId": "<if mentioned>", "label": "<short description>", "category": "<free-form category>", "summary": "<1-2 sentences>", "outcome": "<good|bad|mixed>"}

Category guidelines:
- Do NOT use a fixed list. Infer the category from what actually happened.
- Think about: what was the agent trying to do for the user? Was this the optimal approach?
- Good categories describe the nature of the work: e.g. "code-review", "data-migration",
  "deployment", "user-onboarding", "api-debugging", "task-delegation", "knowledge-retrieval", etc.
- Be specific enough to be useful for cross-event comparison later.

Pay attention to:
- Tool/plugin usage: which tools did the agent use? Were they the right ones?
- Worker delegation: did the agent delegate to workers? Was the right worker chosen?
- Efficiency: was this done in a reasonable number of turns, or was there unnecessary back-and-forth?
- Error recovery: did the agent recover well from errors, or did it spiral?

Rules:
- Turns use the [Turn N] labels from the transcript. Use those exact numbers.
- Group consecutive turns working on the same thing into one event.
- If a task/issue ID is mentioned (e.g. PR #636, task name), include it as taskId.
- outcome: "good" if completed successfully, "bad" if failed/abandoned, "mixed" if partial.
- Output ONLY the JSON lines, no commentary, no markdown fences.

Transcript:
`;

export interface OrganiseResult {
  sessionsProcessed: number;
  eventsFound: number;
  filesWritten: string[];
  skipped: boolean;
  reason?: string;
}

/**
 * Step 1: Segment sessions into events and save to events/ directory.
 */
function getSkillsContext(ctx: TenantContext): string {
  try {
    const skills = loadTenantSkills({
      tenantId: ctx.tenantId,
      scope: { kind: "main" },
    });
    if (skills.length === 0) return "";
    const parts: string[] = [`\n\n--- CURRENT SKILLS (${skills.length}) ---`];
    for (const s of skills) {
      // Read full skill content
      let body = "";
      try {
        body = fs.readFileSync(s.filePath, "utf8");
        // Cap each skill to avoid blowing context
        if (body.length > 2000) body = body.slice(0, 2000) + "\n...(truncated)";
      } catch {
        body = `(could not read ${s.filePath})`;
      }
      parts.push(`\n### Skill: ${s.name}\nSource: ${s.source.pluginId}\n${body}`);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function getWorkersContext(ctx: TenantContext): string {
  try {
    const workersDir = path.join(ctx.root, "_tenant", "config", "workers");
    if (!fs.existsSync(workersDir)) return "";
    const slugs = fs.readdirSync(workersDir).filter(d => {
      try { return fs.statSync(path.join(workersDir, d)).isDirectory(); } catch { return false; }
    });
    if (slugs.length === 0) return "";
    const parts: string[] = [`\n\n--- CONFIGURED WORKERS (${slugs.length}) ---`];
    for (const slug of slugs) {
      const specPath = path.join(workersDir, slug, "agent.json");
      const soulPath = path.join(workersDir, slug, "SOUL.md");
      let spec = "(no agent.json)";
      try { spec = fs.readFileSync(specPath, "utf8").slice(0, 1000); } catch {}
      let soul = "";
      try {
        soul = fs.readFileSync(soulPath, "utf8");
        if (soul.length > 1500) soul = soul.slice(0, 1500) + "\n...(truncated)";
      } catch {}
      parts.push(`\n### Worker: ${slug}\nConfig: ${spec}`);
      if (soul) parts.push(`System prompt:\n${soul}`);
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function getEnabledPluginsContext(ctx: TenantContext): string {
  const plugins = ctx.config.plugins;
  if (!plugins) return "";
  const enabled = Object.entries(plugins)
    .filter(([, v]) => v && typeof v === "object" && (v as any).enabled !== false)
    .map(([k]) => k);
  if (enabled.length === 0) return "";
  return `\n\nEnabled plugins/capabilities: ${enabled.join(", ")}\nConsider whether the right tools and workers were used for each task.\n`;
}

function getLanguageInstruction(ctx: TenantContext): string {
  const lang = ctx.config.outputLanguage;
  if (!lang || lang === "auto") return "";
  const langMap: Record<string, string> = {
    zh: "\n\nIMPORTANT: Write all labels, summaries, and text fields in Chinese (中文).",
    en: "\n\nIMPORTANT: Write all labels, summaries, and text fields in English.",
    de: "\n\nIMPORTANT: Write all labels, summaries, and text fields in German (Deutsch).",
    ja: "\n\nIMPORTANT: Write all labels, summaries, and text fields in Japanese (日本語).",
    ko: "\n\nIMPORTANT: Write all labels, summaries, and text fields in Korean (한국어).",
  };
  return langMap[lang] ?? "";
}

export async function organiseEvents(args: {
  ctx: TenantContext;
  userId: string;
  sessions: Array<{ sessionId: string; transcript: string }>;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
  /** Epoch ms cutoff — encoded in event filenames for incremental tracking. */
  cutoffMs?: number;
}): Promise<OrganiseResult> {
  const { ctx, userId, sessions, modelInfo, signal, cutoffMs } = args;

  if (sessions.length === 0) {
    return { sessionsProcessed: 0, eventsFound: 0, filesWritten: [], skipped: true, reason: "no sessions" };
  }

  const userHome = ctx.userHomeDir(userId);
  const eventsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, EVENTS_DIR);
  fs.mkdirSync(eventsDir, { recursive: true });

  const filesWritten: string[] = [];
  let totalEvents = 0;

  setProgress(userId, { step: "organise", current: 0, total: sessions.length });

  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]!;
    if (s.transcript.split("\n").length < 6) continue;

    const shortId = s.sessionId.replace(/^session_/, "").slice(0, 12);
    const suffix = cutoffMs ? `-${cutoffMs}` : "";
    const outFile = path.join(eventsDir, `${shortId}${suffix}.md`);
    // Skip if this exact file already exists (same session + same cutoff)
    if (fs.existsSync(outFile)) {
      log.info("skip already organised", { sessionId: s.sessionId });
      continue;
    }

    const sessionRow = ctx.db.prepare("SELECT title FROM sessions WHERE id = ?").get(s.sessionId) as { title?: string } | undefined;
    const label = sessionRow?.title || shortId;
    setProgress(userId, { step: "organise", current: i + 1, total: sessions.length, label });

    const langHint = getLanguageInstruction(ctx);
    const events = await segmentSession({ ctx, sessionId: s.sessionId, transcript: s.transcript, modelInfo, signal, langHint });
    if (events.length === 0) continue;

    // Write as markdown
    const lines: string[] = [
      `---`,
      `type: harness2-events`,
      `sessionId: ${s.sessionId}`,
      `createdAt: ${new Date().toISOString()}`,
      `eventCount: ${events.length}`,
      `---`,
      ``,
      `# Session ${shortId}`,
      ``,
    ];
    for (const e of events) {
      lines.push(`## ${e.label}`);
      lines.push(``);
      lines.push(`| Field | Value |`);
      lines.push(`|-------|-------|`);
      lines.push(`| Turns | ${e.turnFrom}–${e.turnTo} (${e.turnCount} turns) |`);
      lines.push(`| Category | ${e.category} |`);
      if (e.taskId) lines.push(`| Task | ${e.taskId} |`);
      lines.push(`| Outcome | ${e.outcome || "unknown"} |`);
      lines.push(``);
      lines.push(e.summary);
      lines.push(``);

      // Enrich: task info
      if (e.taskId) {
        const task = ctx.db.prepare<[string], {
          title: string; status: string; result_summary: string | null;
          created_at: number; started_at: number | null; ended_at: number | null;
          worker_role: string | null; description: string | null;
        }>(
          `SELECT title, status, result_summary, created_at, started_at, ended_at, worker_role, description
           FROM tasks WHERE id = ?`,
        ).get(e.taskId);
        if (task) {
          lines.push(`### Task Details`);
          lines.push(``);
          lines.push(`- **Title:** ${task.title}`);
          lines.push(`- **Status:** ${task.status}`);
          if (task.worker_role) lines.push(`- **Worker:** ${task.worker_role}`);
          if (task.description) lines.push(`- **Description:** ${task.description.slice(0, 500)}`);
          if (task.result_summary) lines.push(`- **Result:** ${task.result_summary.slice(0, 500)}`);
          if (task.started_at && task.ended_at) {
            const durationMin = Math.round((task.ended_at - task.started_at) / 60000);
            lines.push(`- **Duration:** ${durationMin} min`);
          }
          lines.push(``);
        }
      }

      // Enrich: recall full turn content
      const chain = resolveSessionChain(ctx.db, s.sessionId);
      const placeholders = chain.map(() => "?").join(",");
      const turnRows = ctx.db.prepare<string[], { role: string; content: string; turn_number: number | null }>(
        `SELECT role, content, turn_number FROM messages
         WHERE session_id IN (${placeholders})
           AND turn_number BETWEEN ? AND ?
         ORDER BY turn_number ASC, created_at ASC`,
      ).all(...chain, String(e.turnFrom), String(e.turnTo));

      if (turnRows.length > 0) {
        lines.push(`<details>`);
        lines.push(`<summary>Turn transcript (${turnRows.length} messages)</summary>`);
        lines.push(``);
        for (const row of turnRows) {
          const turnLabel = row.turn_number != null ? `[Turn ${row.turn_number}] ` : "";
          const text = extractMessageText(row.content, row.role);
          if (text) {
            const trimmed = text.length > 1000 ? text.slice(0, 1000) + "..." : text;
            lines.push(`**${turnLabel}${row.role}:** ${trimmed}`);
            lines.push(``);
          }
        }
        lines.push(`</details>`);
        lines.push(``);
      }
    }
    fs.writeFileSync(outFile, lines.join("\n"), "utf8");
    filesWritten.push(outFile);
    totalEvents += events.length;
  }

  setProgress(userId, { step: "idle", current: 0, total: 0 });

  if (filesWritten.length > 0) {
    const harness2Dir = path.join(userHome, KB_DIR, HARNESS2_DIR);
    const lang = ctx.config.outputLanguage;
    const commitMsg = lang === "zh"
      ? `📋 整理 ${filesWritten.length} 个对话，发现 ${totalEvents} 个事件`
      : `📋 Organised ${filesWritten.length} sessions, found ${totalEvents} events`;
    gitCommit(harness2Dir, commitMsg);
  }

  log.info("organise complete", { sessions: sessions.length, events: totalEvents, files: filesWritten.length });
  return { sessionsProcessed: sessions.length, eventsFound: totalEvents, filesWritten, skipped: false };
}

async function segmentSession(args: {
  ctx: TenantContext;
  sessionId: string;
  transcript: string;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
  langHint?: string;
}): Promise<SessionEvent[]> {
  const { ctx, sessionId, transcript, modelInfo, signal, langHint = "" } = args;

  // Inject enabled plugins context so LLM can reason about tool/worker usage
  const pluginsCtx = getEnabledPluginsContext(ctx);
  const raw = await callLLM(ctx, modelInfo, SEGMENT_PROMPT + pluginsCtx + langHint + "\n\n" + transcript, signal);
  if (!raw) return [];

  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.turnFrom != null && obj.label) {
        events.push({
          sessionId,
          turnFrom: Number(obj.turnFrom),
          turnTo: Number(obj.turnTo ?? obj.turnFrom),
          taskId: obj.taskId || undefined,
          label: String(obj.label),
          category: String(obj.category || "other"),
          turnCount: Number(obj.turnTo ?? obj.turnFrom) - Number(obj.turnFrom) + 1,
          summary: String(obj.summary || ""),
          outcome: obj.outcome || undefined,
        });
      }
    } catch { /* skip unparseable lines */ }
  }

  log.info("segmented session", { sessionId, events: events.length });
  return events;
}

// ── Step 2: Analyse ─────────────────────────────────────────────

const ANALYSE_PROMPT = `You are an AI assistant behavior optimizer. You have access to:
1. Real work events showing what the assistant did (good and bad)
2. The current USER.md (user preferences and profile)
3. Enabled plugins and capabilities

Your job: produce TWO outputs that will directly improve the assistant's future behavior.

Output 1 — SKILL: A behavioral skill document (like a SKILL.md) containing concrete rules
the assistant should follow. This will be injected into the assistant's system prompt.
Write it as direct instructions TO the assistant, not about the assistant.
Format: markdown with clear sections, imperative voice ("Do X", "Never Y", "When Z, always W").

Output 2 — USER_MD_CHANGES: Specific additions or changes to USER.md based on observed
user behavior patterns. Only include things that are durable preferences revealed by the
events, NOT things already captured in the current USER.md.

Focus on:
- Task delegation: when to use workers, which worker for which task
- Tool choice: which tools/plugins to prefer for which situations
- Error recovery: what to do (and not do) when things go wrong
- Efficiency: avoid patterns that wasted turns or led to rework
- User preferences: implicit patterns in how the user likes to work

IMPORTANT:
- Only include rules that would CHANGE behavior. If something already works well, skip it.
- Be specific: mention tool names, worker roles, plugin names.
- The skill should be 10-30 lines, not a novel.
- USER_MD_CHANGES should be empty if nothing new was discovered about the user.
`;

const ANALYSE_SUFFIX = `

Output a JSON object:
{
  "skill": "<markdown content for the behavioral skill — write as instructions TO the assistant>",
  "userMdChanges": ["<specific addition or change to USER.md, one per item>"],
  "summary": "<2-3 sentences: the key behavioral improvements>"
}

Rules:
- skill content should be imperative, concise, actionable — like a SKILL.md.
- userMdChanges: only durable user preferences not already in USER.md. Empty array if none.
- If existing insights are provided, refine them: keep valid rules, remove outdated ones.
- Output ONLY the JSON, no commentary.
`;

export interface AnalyseResult {
  totalEvents: number;
  rulesGenerated: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Step 2: Global analysis — read ALL events, produce one consolidated insights file.
 */
export async function analyseInsights(args: {
  ctx: TenantContext;
  userId: string;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
}): Promise<AnalyseResult> {
  const { ctx, userId, modelInfo, signal } = args;

  setProgress(userId, { step: "analyse", current: 0, total: 1, label: "loading events…" });

  const userHome = ctx.userHomeDir(userId);
  const eventsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, EVENTS_DIR);
  const insightsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, INSIGHTS_DIR);

  if (!fs.existsSync(eventsDir)) {
    setProgress(userId, { step: "idle", current: 0, total: 0 });
    return { totalEvents: 0, rulesGenerated: 0, skipped: true, reason: "no event files — run Organise first" };
  }

  // Load all events from all event files
  const allEvents: SessionEvent[] = [];
  for (const f of fs.readdirSync(eventsDir).filter(f => f.endsWith(".md"))) {
    try {
      const content = fs.readFileSync(path.join(eventsDir, f), "utf8");
      allEvents.push(...parseEventMd(content));
    } catch { /* skip corrupt files */ }
  }

  if (allEvents.length === 0) {
    setProgress(userId, { step: "idle", current: 0, total: 0 });
    return { totalEvents: 0, rulesGenerated: 0, skipped: true, reason: "no events in event files" };
  }

  // Build a compact summary of ALL events for the LLM
  const eventsText = allEvents.map((e, i) => {
    const parts = [
      `Event ${i + 1}: "${e.label}" [${e.category}]`,
      `  Session: ${e.sessionId.slice(0, 12)}  Turns: ${e.turnFrom}-${e.turnTo}  Outcome: ${e.outcome || "unknown"}`,
      e.taskId ? `  Task: ${e.taskId}` : null,
      `  ${e.summary}`,
    ].filter(Boolean);
    return parts.join("\n");
  }).join("\n\n");

  // Read existing insights for iterative refinement
  const existingInsightsPath = path.join(insightsDir, "agent-rules.md");
  let existingSection = "";
  if (fs.existsSync(existingInsightsPath)) {
    existingSection = "\n\n--- EXISTING INSIGHTS (from previous analysis) ---\n" + fs.readFileSync(existingInsightsPath, "utf8");
  }

  // Read current USER.md for context
  const userMdPath = path.join(userHome, "USER.md");
  const currentUserMd = fs.existsSync(userMdPath) ? fs.readFileSync(userMdPath, "utf8") : "(no USER.md yet)";

  // Load current skills, plugins, and workers for context
  const skillsCtx = getSkillsContext(ctx);
  const pluginsCtx = getEnabledPluginsContext(ctx);
  const workersCtx = getWorkersContext(ctx);
  const langHint = getLanguageInstruction(ctx);
  setProgress(userId, { step: "analyse", current: 1, total: 1, label: `analysing ${allEvents.length} events…` });

  const raw = await callLLM(
    ctx, modelInfo,
    ANALYSE_PROMPT + pluginsCtx + skillsCtx + workersCtx
      + "\n\n--- CURRENT USER.MD ---\n" + currentUserMd.slice(0, 3000)
      + "\n\n--- ALL EVENTS ---\n" + eventsText
      + existingSection + ANALYSE_SUFFIX + langHint,
    signal,
  );

  fs.mkdirSync(insightsDir, { recursive: true });
  let rulesGenerated = 0;

  if (raw) {
    try {
      const jsonStr = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const obj = JSON.parse(jsonStr);
      const skillContent: string = String(obj.skill || "");
      const userMdChanges: string[] = Array.isArray(obj.userMdChanges) ? obj.userMdChanges : [];
      const summary: string = String(obj.summary || "");

      // Write the behavioral skill
      if (skillContent.trim()) {
        const skillLines = [
          `---`,
          `type: harness2-skill`,
          `totalEvents: ${allEvents.length}`,
          `updatedAt: ${new Date().toISOString()}`,
          `---`,
          ``,
          skillContent,
        ];
        fs.writeFileSync(path.join(insightsDir, "agent-rules.md"), skillLines.join("\n"), "utf8");
        rulesGenerated++;
      }

      // Write USER.md change proposals (separate file for review)
      if (userMdChanges.length > 0) {
        const proposalLines = [
          `---`,
          `type: harness2-user-proposal`,
          `updatedAt: ${new Date().toISOString()}`,
          `---`,
          ``,
          `# Proposed USER.md Changes`,
          ``,
          `> ${summary}`,
          ``,
          ...userMdChanges.map(c => `- ${c}`),
          ``,
        ];
        fs.writeFileSync(path.join(insightsDir, "user-md-proposals.md"), proposalLines.join("\n"), "utf8");
        rulesGenerated++;
      }
    } catch {
      fs.writeFileSync(path.join(insightsDir, "agent-rules.md"), raw.slice(0, 5000), "utf8");
      rulesGenerated = 1;
    }
  }

  setProgress(userId, { step: "idle", current: 0, total: 0 });

  if (rulesGenerated > 0) {
    const harness2Dir = path.join(userHome, KB_DIR, HARNESS2_DIR);
    const lang = ctx.config.outputLanguage;
    const commitMsg = lang === "zh"
      ? `🔍 分析 ${allEvents.length} 个事件，提炼 ${rulesGenerated} 条行为规则`
      : `🔍 Analysed ${allEvents.length} events, extracted ${rulesGenerated} behavioral rules`;
    await gitCommit(harness2Dir, commitMsg);
    try {
      const [latest] = await git.log({ fs, dir: harness2Dir, depth: 1 });
      if (latest) fs.writeFileSync(path.join(harness2Dir, ".active"), latest.oid, "utf8");
    } catch { /* ignore */ }
  }

  log.info("analyse complete", { events: allEvents.length, rules: rulesGenerated });
  return { totalEvents: allEvents.length, rulesGenerated, skipped: false };
}

function writeInsight(insightsDir: string, insight: CategoryInsight): string {
  const filename = `${insight.category}.md`;
  const filePath = path.join(insightsDir, filename);

  const lines: string[] = [
    `---`,
    `type: harness2-insight`,
    `category: ${insight.category}`,
    `eventCount: ${insight.eventCount}`,
    `updatedAt: ${new Date().toISOString()}`,
    `---`,
    ``,
    `# ${insight.category}`,
    ``,
  ];

  if (insight.bestPractices.length) {
    lines.push(`## Best Practices`, ``);
    for (const bp of insight.bestPractices) lines.push(`- ${bp}`);
    lines.push(``);
  }

  if (insight.antiPatterns.length) {
    lines.push(`## Anti-Patterns`, ``);
    for (const ap of insight.antiPatterns) lines.push(`- ⚠️ ${ap}`);
    lines.push(``);
  }

  if (insight.toolUsage?.length) {
    lines.push(`## Tool & Worker Usage`, ``);
    for (const tu of insight.toolUsage) lines.push(`- 🔧 ${tu}`);
    lines.push(``);
  }

  if (insight.recommendations) {
    lines.push(`## Recommendations`, ``, insight.recommendations, ``);
  }

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}

// ── Status helpers ──────────────────────────────────────────────

export function getHarvestStatus(userHome: string): {
  eventFiles: number;
  totalEvents: number;
  insightFiles: number;
  categories: string[];
  activeOid: string | null;
} {
  const eventsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, EVENTS_DIR);
  const insightsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, INSIGHTS_DIR);

  let eventFiles = 0;
  let totalEvents = 0;
  if (fs.existsSync(eventsDir)) {
    const files = fs.readdirSync(eventsDir).filter(f => f.endsWith(".md"));
    eventFiles = files.length;
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(eventsDir, f), "utf8");
        totalEvents += parseEventMd(content).length;
      } catch { /* skip */ }
    }
  }

  let insightFiles = 0;
  const categories: string[] = [];
  if (fs.existsSync(insightsDir)) {
    const files = fs.readdirSync(insightsDir).filter(f => f.endsWith(".md"));
    insightFiles = files.length;
    categories.push(...files.map(f => f.replace(/\.md$/, "")));
  }

  // Read active version marker
  const activePath = path.join(path.join(userHome, KB_DIR, HARNESS2_DIR), ".active");
  const activeOid = fs.existsSync(activePath) ? fs.readFileSync(activePath, "utf8").trim() : null;

  return { eventFiles, totalEvents, insightFiles, categories, activeOid };
}

// ── Markdown parser ─────────────────────────────────────────────

/** Parse events back from the markdown format written by organiseEvents. */
function parseEventMd(content: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  // Extract sessionId from frontmatter
  const sidMatch = content.match(/^sessionId:\s*(.+)$/m);
  const sessionId = sidMatch?.[1]?.trim() ?? "";

  // Split by ## headings (each is one event)
  const sections = content.split(/^## /m).slice(1);
  for (const section of sections) {
    const label = section.split("\n")[0]?.trim() ?? "";
    const tableRows = section.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/gm) ?? [];
    const fields: Record<string, string> = {};
    for (const row of tableRows) {
      const cells = row.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length === 2 && cells[0] !== "Field") {
        fields[cells[0]!.toLowerCase()] = cells[1]!;
      }
    }

    const turnsMatch = (fields["turns"] ?? "").match(/(\d+)\D+(\d+)/);
    const turnFrom = turnsMatch ? Number(turnsMatch[1]) : 0;
    const turnTo = turnsMatch ? Number(turnsMatch[2]) : 0;

    // Summary is the text after the table (non-table, non-empty lines)
    const lines = section.split("\n");
    const summary = lines
      .filter(l => !l.startsWith("|") && l.trim() && l.trim() !== label)
      .join(" ")
      .trim();

    events.push({
      sessionId,
      turnFrom,
      turnTo,
      taskId: fields["task"] || undefined,
      label,
      category: fields["category"] ?? "other",
      turnCount: turnTo - turnFrom + 1,
      summary,
      outcome: fields["outcome"] || undefined,
    });
  }
  return events;
}

// ── Git version control ───────────────────────────────────────

import git from "isomorphic-git";

async function gitCommit(harness2Dir: string, message: string): Promise<void> {
  try {
    // Init repo if needed
    if (!fs.existsSync(path.join(harness2Dir, ".git"))) {
      await git.init({ fs, dir: harness2Dir });
      log.info("git init", { dir: harness2Dir });
    }

    // Stage all files
    const status = await git.statusMatrix({ fs, dir: harness2Dir });
    for (const [filepath, , workdirStatus] of status) {
      if (workdirStatus === 0) {
        await git.remove({ fs, dir: harness2Dir, filepath });
      } else {
        await git.add({ fs, dir: harness2Dir, filepath });
      }
    }

    // Re-check after staging to see if anything actually changed
    const afterStatus = await git.statusMatrix({ fs, dir: harness2Dir });
    const hasChanges = afterStatus.some(([, head, , stage]) => head !== stage);
    if (!hasChanges) return;

    await git.commit({
      fs,
      dir: harness2Dir,
      message,
      author: { name: "tianshu-harvester", email: "harvester@tianshu.local" },
    });
    log.info("git commit", { dir: harness2Dir, message });
  } catch (err) {
    log.warn("git commit failed (non-fatal)", { error: String(err) });
  }
}

// ── Git history & rollback ──────────────────────────────────

export interface InsightVersion {
  oid: string;
  message: string;
  timestamp: number;
}

export async function getInsightHistory(userHome: string, limit = 20): Promise<InsightVersion[]> {
  const harness2Dir = path.join(userHome, KB_DIR, HARNESS2_DIR);
  if (!fs.existsSync(path.join(harness2Dir, ".git"))) return [];
  try {
    const commits = await git.log({ fs, dir: harness2Dir, depth: limit });
    return commits.map(c => ({
      oid: c.oid,
      message: c.commit.message,
      timestamp: c.commit.author.timestamp * 1000,
    }));
  } catch {
    return [];
  }
}

export async function rollbackInsights(userHome: string, oid: string): Promise<{ ok: boolean; message: string }> {
  const harness2Dir = path.join(userHome, KB_DIR, HARNESS2_DIR);
  if (!fs.existsSync(path.join(harness2Dir, ".git"))) {
    return { ok: false, message: "no git repo" };
  }
  try {
    // Read files from the target commit and write to disk.
    // Do NOT move HEAD/refs — history stays intact.
    const insightsDir = path.join(harness2Dir, INSIGHTS_DIR);

    // Collect files from target commit's insights/ subtree
    const files = await git.walk({
      fs, dir: harness2Dir, trees: [git.TREE({ ref: oid })],
      map: async (filepath, [entry]) => {
        if (!entry || filepath === "." || !filepath.startsWith(INSIGHTS_DIR + "/")) return undefined;
        const type = await entry.type();
        if (type === "blob") {
          const content = await entry.content();
          return { filepath, content };
        }
        return undefined;
      },
    }) as Array<{ filepath: string; content: Uint8Array } | undefined>;

    // Clear current insights and restore from target commit
    if (fs.existsSync(insightsDir)) {
      for (const f of fs.readdirSync(insightsDir)) fs.unlinkSync(path.join(insightsDir, f));
    }
    fs.mkdirSync(insightsDir, { recursive: true });

    for (const file of files) {
      if (!file) continue;
      const fullPath = path.join(harness2Dir, file.filepath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, Buffer.from(file.content));
    }

    // Record which version is active on disk
    fs.writeFileSync(path.join(harness2Dir, ".active"), oid, "utf8");

    return { ok: true, message: `Restored to ${oid.slice(0, 8)}` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── Housekeeping ────────────────────────────────────────────────

export function clearEvents(userHome: string): void {
  const eventsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, EVENTS_DIR);
  if (fs.existsSync(eventsDir)) {
    for (const f of fs.readdirSync(eventsDir)) {
      fs.unlinkSync(path.join(eventsDir, f));
    }
  }
}

// ── LLM helper ──────────────────────────────────────────────────

function extractMessageText(content: string, role: string): string {
  try {
    const j = JSON.parse(content);
    if (Array.isArray(j.content)) {
      const parts: string[] = [];
      for (const c of j.content) {
        if (c.type === "text" && c.text) parts.push(c.text);
        else if (c.type === "toolCall") {
          const args = JSON.stringify(c.arguments ?? {}).slice(0, 400);
          parts.push(`[tool:${c.name} args=${args}]`);
        }
      }
      return parts.join("\n");
    }
    if (typeof j.content === "string") return j.content;
  } catch { /* raw text */ }
  return content.slice(0, 1000);
}

async function callLLM(
  ctx: TenantContext,
  modelInfo: ResolvedModelInfo,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const llmCtx: Context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt } as TextContent],
        timestamp: Date.now(),
      } as UserMessage,
    ],
  };

  const model = buildModel(modelInfo);
  const apiKey = resolveApiKey(modelInfo);
  const resilience = resolveResilience(
    ctx.config.models?.resilience as ModelResilienceConfig | undefined,
  );

  const result = (await retryCompletion(
    (key) =>
      completeSimple(model, llmCtx, {
        apiKey: key,
        maxTokens: MAX_TOKENS,
        signal,
        maxRetries: 0,
      }) as Promise<AssistantMessage>,
    apiKey,
    {
      resilience,
      reResolveApiKey: () => resolveApiKey(modelInfo),
      label: `${modelInfo.providerId}/${modelInfo.modelId} (harvest)`,
    },
  )) as AssistantMessage;

  const parts = Array.isArray(result.content) ? result.content : [];
  return parts.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("");
}
