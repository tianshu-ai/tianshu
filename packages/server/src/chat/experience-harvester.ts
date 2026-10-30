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

function setProgress(userId: string, p: HarvestProgress) {
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
}): Promise<OrganiseResult> {
  const { ctx, userId, sessions, modelInfo, signal } = args;

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

    // Skip already-organised sessions
    const shortId = s.sessionId.replace(/^session_/, "").slice(0, 12);
    const outFile = path.join(eventsDir, `${shortId}.md`);
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

const COMPARE_PROMPT = `You are refining actionable insights for an AI assistant based on real work events.

Your goal: figure out how the assistant can do better next time. Think about:
- What patterns lead to successful outcomes vs failures?
- When should the assistant delegate to workers vs handle directly?
- Which tools/plugins were used well vs misused vs underused?
- Where did the assistant waste turns (unnecessary back-and-forth, wrong approach, missing context)?
- What should the assistant always/never do in this type of situation?

If existing insights are provided from a previous round, UPDATE and IMPROVE them:
- Keep what's still valid, remove what's contradicted by new evidence
- Merge similar items, make recommendations more specific and actionable
- Reference specific turn numbers or task IDs when they illustrate a point

Events in this category:
`;

const COMPARE_EXISTING_SECTION = `

--- EXISTING INSIGHTS (from previous analysis) ---
`;

const COMPARE_SUFFIX = `

Output a JSON object with UPDATED insights:
{
  "bestPractices": ["<what worked well — be specific, mention tools/workers/approaches>"],
  "antiPatterns": ["<what went wrong or was wasteful — be specific about what to avoid>"],
  "toolUsage": ["<insights about which tools/plugins/workers to use when, and which to avoid>"],
  "recommendations": "<2-4 sentences: concrete guidance for the assistant on this type of work>"
}

Rules:
- Focus on PATTERNS across events, not one-off specifics.
- Be concrete — mention tool names, worker roles, plugin names, turn counts when relevant.
- If existing insights are provided, merge/refine them with evidence from new events.
- Remove items that are contradicted by newer evidence.
- toolUsage should cover: right tool for the job, worker delegation strategy, plugin capabilities.
- Output ONLY the JSON, no commentary.`;

export interface AnalyseResult {
  categoriesAnalysed: number;
  totalEvents: number;
  filesWritten: string[];
  skipped: boolean;
  reason?: string;
}

/**
 * Step 2: Read all event files, group by category, compare, write insights.
 */
export async function analyseInsights(args: {
  ctx: TenantContext;
  userId: string;
  modelInfo: ResolvedModelInfo;
  signal?: AbortSignal;
}): Promise<AnalyseResult> {
  const { ctx, userId, modelInfo, signal } = args;

  setProgress(userId, { step: "analyse", current: 0, total: 0, label: "loading events…" });

  const userHome = ctx.userHomeDir(userId);
  const eventsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, EVENTS_DIR);
  const insightsDir = path.join(userHome, KB_DIR, HARNESS2_DIR, INSIGHTS_DIR);

  if (!fs.existsSync(eventsDir)) {
    setProgress(userId, { step: "idle", current: 0, total: 0 });
    return { categoriesAnalysed: 0, totalEvents: 0, filesWritten: [], skipped: true, reason: "no event files — run Organise first" };
  }

  // Load all event files (md format)
  const allEvents: SessionEvent[] = [];
  for (const f of fs.readdirSync(eventsDir).filter(f => f.endsWith(".md"))) {
    try {
      const content = fs.readFileSync(path.join(eventsDir, f), "utf8");
      const events = parseEventMd(content);
      allEvents.push(...events);
    } catch { /* skip corrupt files */ }
  }

  if (allEvents.length === 0) {
    return { categoriesAnalysed: 0, totalEvents: 0, filesWritten: [], skipped: true, reason: "no events in event files" };
  }

  // Group by category
  const categoryMap = new Map<string, SessionEvent[]>();
  for (const e of allEvents) {
    const key = e.category || "other";
    if (!categoryMap.has(key)) categoryMap.set(key, []);
    categoryMap.get(key)!.push(e);
  }

  fs.mkdirSync(insightsDir, { recursive: true });
  const filesWritten: string[] = [];
  const catEntries = [...categoryMap.entries()];
  let catIdx = 0;
  setProgress(userId, { step: "analyse", current: 0, total: catEntries.length });

  for (const [category, events] of catEntries) {
    catIdx++;
    setProgress(userId, { step: "analyse", current: catIdx, total: catEntries.length, label: category });
    if (events.length < 2) {
      // Single event — record raw, skip comparison
      const insight: CategoryInsight = {
        category,
        eventCount: 1,
        bestPractices: events[0]?.outcome === "good" ? [events[0].summary] : [],
        antiPatterns: events[0]?.outcome === "bad" ? [events[0].summary] : [],
        toolUsage: [],
        recommendations: "",
      };
      const fp = writeInsight(insightsDir, insight);
      filesWritten.push(fp);
      continue;
    }

    // LLM comparison — iterative: read existing insight if any
    const eventsText = events.map((e, i) => {
      const parts = [
        `Event ${i + 1}: "${e.label}"`,
        `  Session: ${e.sessionId.slice(0, 12)}  Turns: ${e.turnFrom}-${e.turnTo}`,
        e.taskId ? `  Task: ${e.taskId}` : null,
        `  Summary: ${e.summary}`,
        `  Outcome: ${e.outcome || "unknown"}`,
      ].filter(Boolean);
      return parts.join("\n");
    }).join("\n\n");

    // Read existing insight for this category
    const existingPath = path.join(insightsDir, `${category}.md`);
    let existingSection = "";
    if (fs.existsSync(existingPath)) {
      const existingContent = fs.readFileSync(existingPath, "utf8");
      existingSection = COMPARE_EXISTING_SECTION + existingContent;
    }

    const langHint = getLanguageInstruction(ctx);
    const raw = await callLLM(ctx, modelInfo, COMPARE_PROMPT + eventsText + existingSection + COMPARE_SUFFIX + langHint, signal);
    let insight: CategoryInsight;
    if (raw) {
      try {
        const jsonStr = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        const obj = JSON.parse(jsonStr);
        insight = {
          category,
          eventCount: events.length,
          bestPractices: Array.isArray(obj.bestPractices) ? obj.bestPractices : [],
          antiPatterns: Array.isArray(obj.antiPatterns) ? obj.antiPatterns : [],
          toolUsage: Array.isArray(obj.toolUsage) ? obj.toolUsage : [],
          recommendations: String(obj.recommendations || ""),
        };
      } catch {
        insight = { category, eventCount: events.length, bestPractices: [], antiPatterns: [], toolUsage: [], recommendations: raw.slice(0, 500) };
      }
    } else {
      insight = { category, eventCount: events.length, bestPractices: [], antiPatterns: [], toolUsage: [], recommendations: "" };
    }

    const fp = writeInsight(insightsDir, insight);
    filesWritten.push(fp);
  }

  setProgress(userId, { step: "idle", current: 0, total: 0 });

  if (filesWritten.length > 0) {
    const harness2Dir = path.join(userHome, KB_DIR, HARNESS2_DIR);
    const lang = ctx.config.outputLanguage;
    const commitMsg = lang === "zh"
      ? `🔍 分析 ${allEvents.length} 个事件，更新 ${filesWritten.length} 个类别的经验`
      : `🔍 Analysed ${allEvents.length} events, updated ${filesWritten.length} category insights`;
    await gitCommit(harness2Dir, commitMsg);
    // Mark latest commit as active
    try {
      const [latest] = await git.log({ fs, dir: harness2Dir, depth: 1 });
      if (latest) fs.writeFileSync(path.join(harness2Dir, ".active"), latest.oid, "utf8");
    } catch { /* ignore */ }
  }

  log.info("analyse complete", { categories: categoryMap.size, events: allEvents.length, files: filesWritten.length });
  return { categoriesAnalysed: categoryMap.size, totalEvents: allEvents.length, filesWritten, skipped: false };
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
