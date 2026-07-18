// Wiki plugin server entry.
//
// The LLM Wiki distils the rolling conversation into an Obsidian-style
// knowledge vault under users/<userId>/wiki/. Two layers:
//
//   1. sources/ — evidence. One page per compacted conversation
//      segment, filed automatically by the host's compaction path via
//      the `wiki.ingest` capability this plugin provides (best-effort,
//      fire-and-forget). Each source is the LLM-distilled compaction
//      summary, verbatim.
//   2. entities/ concepts/ topics/ — synthesis. Written by the agent
//      itself: it reads the raw sources (wiki_list_sources / wiki_read)
//      and files structured, wikilinked pages via wiki_write_page. The
//      synthesis intelligence is the agent's; the tools are just I/O +
//      raw material (plugins can't run their own LLM completions).
//
// Read + browse in the WikiPanel side panel (served over the plugin's
// REST routes). Path-safe + per-user isolated by construction
// (everything lives under the caller's userHomeDir).

import type {
  PluginContext,
  PluginServerExports,
  PluginServerModule,
  PluginRouteHandler,
  AgentTool,
  AgentToolContext,
  ToolResult,
  WikiIngestCapability,
  WikiIngestInput,
  WikiIngestResult,
  AgentLoopRunner,
  SessionInboxCapability,
} from "@tianshu-ai/plugin-sdk";
import { Type } from "typebox";
import type { Request, Response } from "express";
import {
  SECTIONS,
  JOURNAL_LEVELS,
  listPages,
  readPage,
  searchPages,
  resolvePage,
  renderPage,
  writePage,
  safeSlug,
  readCursor,
  setCursor,
  isValidPeriod,
  isoWeekRange,
  resetVault,
  buildGraph,
  pageSnippet,
  type JournalLevel,
} from "./vault.js";
import { ingestSource } from "./ingest.js";
import {
  embeddingEnabled,
  indexPage,
  semanticSearch,
  type EmbeddingConfig,
} from "./embedding.js";
import {
  listSessionMessages,
  messageToText,
  parseResultFiles,
  listMessagesAfter,
  messageTimeSpan,
  tasksInRange,
  localDay,
  WIKI_WORKER_ROLE,
} from "./sessions.js";

// The instruction the wiki-worker runs. Kept here so the recording
// strategy is easy to tweak. The worker walks the session timeline
// incrementally and distils each into pages across three dimensions.
const RECORD_WIKI_STEPS = [
  "You are updating the user's LLM Wiki from their conversation timeline. Work one DAY at a time, chronologically:",
  "1. Call wiki_next_day to fetch the next unrecorded day's raw transcript (timestamped messages, merged across all sessions) + that day's tasks + progress.",
  "2. Read it, then record across BOTH layers for that day:",
  "   • TIME (wiki_journal_write): write the daily entry — level=daily, period=<that YYYY-MM-DD> — noting what was done that day, cross-linking the topics/entities/concepts it touched with [[section/slug]].",
  "   • THEMATIC (wiki_write_page): project → section=entities; reusable tech/knowledge points → section=concepts; a cross-day thread/undertaking (e.g. 'build the board plugin') → section=topics. A topic usually spans several days — add this day to the topic page's timeline and link both ways.",
  "3. Call wiki_day_done({ throughMs }) with the throughMs from wiki_next_day to advance the cursor past that day.",
  "4. Repeat. When you've recorded all days of an ISO week / month / year, roll them up with wiki_journal_write: weekly (YYYY-Www) from its dailies, monthly (YYYY-MM) from its weeks, yearly (YYYY) from its months. Roll-ups summarise and link down — don't repeat detail.",
  "5. Stop when wiki_next_day reports done:true, or after ~10 days this run (the cursor persists; the next run resumes). Then give a one-paragraph summary of what you recorded.",
  "Reuse wiki_search / wiki_list_pages / wiki_read first so you extend existing pages instead of duplicating them.",
];

/** Build the record prompt, prefixing the configured output language
 *  so wiki pages are written in it (not just the session's language). */
function recordWikiPrompt(lang: "auto" | "en" | "zh" | undefined): string {
  const langLine =
    lang === "en"
      ? "Write ALL wiki pages in English, regardless of the language used in the conversations you're reading."
      : lang === "zh"
        ? "\u7528\u4e2d\u6587\u5199\u6240\u6709 wiki \u9875\u9762\uff0c\u65e0\u8bba\u4f60\u9605\u8bfb\u7684\u5bf9\u8bdd\u662f\u4ec0\u4e48\u8bed\u8a00\u3002(Write all wiki pages in Chinese regardless of the conversation language.)"
        : "Write each wiki page in the dominant language of the conversation it summarises.";
  return [langLine, "", ...RECORD_WIKI_STEPS].join("\n");
}

// Wiki tools the worker is allowed to use (nothing else — it's a
// focused background job, not a general agent).
const WIKI_WORKER_TOOLS = [
  "wiki_next_day",
  "wiki_day_done",
  "wiki_list_sources",
  "wiki_list_pages",
  "wiki_read",
  "wiki_search",
  "wiki_write_page",
  "wiki_journal_write",
];

// Per-user run lock: only one wiki-worker in flight at a time so two
// clicks (or two channels) don't double-process the same sessions.
const running = new Set<string>();

function runKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

// Write / flow tools are ONLY offered to the wiki background worker
// (the session spawned with workerRole='wiki'), not to the main agent.
// The main agent should only see the read/query tools day-to-day; the
// ability to WRITE the wiki exists solely during a record run. Gated
// per-turn via AgentTool.available so a stray config can't expose them.
function isWikiWorker(ctx: AgentToolContext): boolean {
  const scope = ctx.agentScope;
  return scope?.kind === "worker" && scope.workerKind === WIKI_WORKER_ROLE;
}

// ─── agent tools ────────────────────────────────────────────────

function buildListSourcesTool(): AgentTool {
  return {
    schema: {
      name: "wiki_list_sources",
      description:
        "List the raw source pages in the user's wiki (one per compacted conversation segment). Use this to see what history has accrued before synthesising entities/concepts/topics.",
      parameters: Type.Object({}),
    },
    execute: (_raw, ctx: AgentToolContext): ToolResult => {
      const pages = listPages(ctx.userHomeDir).filter((p) => p.section === "sources");
      if (pages.length === 0) {
        return { ok: true, text: "No wiki sources yet. They accrue as the conversation is compacted." };
      }
      const lines = pages
        .sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""))
        .map((p) => `- ${p.path} — ${p.title}`);
      return { ok: true, text: `Wiki sources (${pages.length}):\n${lines.join("\n")}` };
    },
  };
}

function buildListPagesTool(): AgentTool {
  return {
    schema: {
      name: "wiki_list_pages",
      description:
        "List all wiki pages across sections (sources / entities / concepts / topics) with their titles.",
      parameters: Type.Object({
        section: Type.Optional(
          Type.String({ description: "Limit to one section: sources | entities | concepts | topics." }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolResult => {
      const p = raw as { section?: string };
      let pages = listPages(ctx.userHomeDir);
      if (p.section) pages = pages.filter((x) => x.section === p.section);
      if (pages.length === 0) return { ok: true, text: "No wiki pages found." };
      const byS: Record<string, string[]> = {};
      for (const pg of pages) (byS[pg.section] ??= []).push(`  - ${pg.path} — ${pg.title}`);
      const out = Object.entries(byS)
        .map(([s, ls]) => `${s} (${ls.length}):\n${ls.join("\n")}`)
        .join("\n\n");
      return { ok: true, text: out };
    },
  };
}

function buildReadTool(): AgentTool {
  return {
    schema: {
      name: "wiki_read",
      description:
        "Read one wiki page's full markdown by its path, e.g. \"sources/2026-07-18-ab12cd34\" or \"entities/tianshu-project\".",
      parameters: Type.Object({
        path: Type.String({ description: "Page path: <section>/<slug> (no .md)." }),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolResult => {
      const p = raw as { path?: string };
      const parts = String(p.path ?? "").split("/");
      if (parts.length < 2) {
        return { ok: false, text: `Invalid path "${p.path}". Use <section>/<slug> (journal: journal/<level>/<period>).` };
      }
      // Last segment is the slug; everything before is the section
      // (so journal/daily/2026-07-18 splits into section=journal/daily,
      // slug=2026-07-18).
      const slug = parts[parts.length - 1]!;
      const section = parts.slice(0, -1).join("/");
      const md = readPage(ctx.userHomeDir, section, slug);
      if (md === null) return { ok: false, text: `Page not found: ${p.path}` };
      return { ok: true, text: md.slice(0, 16000) };
    },
  };
}

function buildSearchTool(cfg?: EmbeddingConfig): AgentTool {
  // The right way to phrase a query differs by backend, so the tool
  // description tells the agent which one is active and how to query it.
  const semantic = embeddingEnabled(cfg);
  const DEFAULT_LIMIT = 8;
  const DEFAULT_MIN_SCORE = 0.15;
  const description = semantic
    ? "Search the user's wiki (recall prior work, decisions, people, facts). Active mode: SEMANTIC (embedding/RAG). Phrase the query as a natural-language description of the MEANING you're after (e.g. \"how the graph visualisation library was chosen\"); exact keywords are NOT required. If results miss, rephrase the concept rather than swapping single words. `mode` defaults to auto (semantic here); pass mode:\"keyword\" to force literal matching."
    : "Search the user's wiki (recall prior work, decisions, people, facts). Active mode: KEYWORD (literal full-text — NO embedding model is configured, so semantic/RAG search is unavailable). Query with the SPECIFIC terms / names / identifiers you expect on the page (e.g. \"react-force-graph\", \"board_act\"); this is literal substring matching. Do NOT expect meaning-based retrieval. (Passing mode:\"semantic\" will error until an embedding model is configured in the plugin settings.)";
  return {
    schema: {
      name: "wiki_search",
      description,
      parameters: Type.Object({
        query: Type.String({
          description: semantic
            ? "Natural-language description of the meaning you're looking for (semantic), or specific terms (keyword)."
            : "Specific keywords / names / identifiers expected on the page (literal keyword match).",
        }),
        mode: Type.Optional(
          Type.String({
            description:
              "auto (default: semantic if configured, else keyword) | semantic (RAG; errors if no embedding model) | keyword (literal full-text).",
          }),
        ),
        limit: Type.Optional(Type.Number({ description: `Max results (default ${DEFAULT_LIMIT}).` })),
        minScore: Type.Optional(
          Type.Number({
            description: `Semantic-only: min cosine similarity [0..1] to include a hit (default ${DEFAULT_MIN_SCORE}). Lower to widen, raise to tighten.`,
          }),
        ),
      }),
    },
    execute: async (raw, ctx: AgentToolContext): Promise<ToolResult> => {
      const p = raw as { query?: string; mode?: string; limit?: number; minScore?: number };
      const q = String(p.query ?? "").trim();
      if (!q) return { ok: false, text: "query is required" };
      const mode = p.mode === "semantic" || p.mode === "keyword" ? p.mode : "auto";
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 50) : DEFAULT_LIMIT;
      const minScore = typeof p.minScore === "number" ? p.minScore : DEFAULT_MIN_SCORE;
      const home = ctx.userHomeDir;
      const titleOf = () => new Map(listPages(home).map((pg) => [pg.path, pg.title]));

      // Explicit semantic requested but no embedding model — error (A).
      if (mode === "semantic" && !semantic) {
        return {
          ok: false,
          text:
            "Semantic search is unavailable: no embedding model is configured for the wiki. " +
            "Either configure one in the plugin settings (Settings → Plugins → Wiki → Semantic search), " +
            "or call wiki_search again with mode:\"keyword\" using specific terms/identifiers.",
        };
      }

      // ── semantic path (mode=semantic, or auto with embedding on) ──
      if (mode === "semantic" || (mode === "auto" && semantic)) {
        const out = await semanticSearch(home, cfg, q, limit, minScore);
        if (out.status === "ok" && out.hits.length > 0) {
          const titles = titleOf();
          const lines = out.hits.map(
            (h) =>
              `- ${h.path} — ${titles.get(h.path) ?? h.path} (score ${h.score.toFixed(2)})\n    ${pageSnippet(home, h.path)}`,
          );
          return {
            ok: true,
            text:
              `[semantic/RAG — ranked by meaning; min score ${minScore}] "${q}" (${lines.length}):\n` +
              `${lines.join("\n")}\n` +
              `Miss? Rephrase the concept, or lower minScore, or try mode:"keyword" with exact terms.`,
          };
        }
        // mode=semantic: report honestly, do NOT silently fall back.
        if (mode === "semantic") {
          const why =
            out.status === "empty"
              ? "the semantic index is empty (nothing recorded into the wiki yet, or the embedding model changed)."
              : out.status === "error"
                ? `the embedding call failed: ${(out as { reason: string }).reason}.`
                : `no page scored ≥ ${minScore}.`;
          return {
            ok: true,
            text: `[semantic/RAG] "${q}": no results — ${why} Try lowering minScore, rephrasing, or mode:"keyword".`,
          };
        }
        // auto: semantic yielded nothing → fall through to keyword below.
      }

      // ── keyword path ──
      const hits = searchPages(home, q, limit);
      const fellBack = mode === "auto" && semantic;
      const header = fellBack
        ? `[keyword — semantic found nothing, fell back to literal] "${q}"`
        : `[keyword — literal substring match] "${q}"`;
      if (hits.length === 0) {
        return {
          ok: true,
          text: `${header}: no hits. Try synonyms / the exact term used at the time, or wiki_list_pages to browse.`,
        };
      }
      const lines = hits.map((h) => `- ${h.path} — ${h.title}\n    …${h.snippet}…`);
      return { ok: true, text: `${header} (${hits.length}):\n${lines.join("\n")}` };
    },
  };
}

function buildWritePageTool(cfg?: EmbeddingConfig): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_write_page",
      description:
        "Create or overwrite a synthesised wiki page (entity / concept / topic). Use this after reading sources to distil cross-segment knowledge into a stable, wikilinked page. Link related pages with Obsidian wikilinks like [[entities/tianshu-project]]. Do NOT write to the sources section — those are filed automatically.",
      parameters: Type.Object({
        section: Type.String({
          description: "One of: entities | concepts | topics. (sources is written automatically; not allowed here.)",
        }),
        slug: Type.String({ description: "Stable slug (kebab-case), e.g. \"tianshu-project\"." }),
        title: Type.String({ description: "Human title." }),
        body: Type.String({ description: "Markdown body (headings, bullets, [[wikilinks]])." }),
        links: Type.Optional(
          Type.Array(Type.String(), {
            description: "Related page paths to record as links, e.g. [\"entities/board-plugin\"].",
          }),
        ),
      }),
    },
    execute: async (raw, ctx: AgentToolContext): Promise<ToolResult> => {
      const p = raw as { section?: string; slug?: string; title?: string; body?: string; links?: string[] };
      const section = String(p.section ?? "");
      if (section === "sources") {
        return { ok: false, text: "Cannot write to sources — those are filed automatically from compaction. Use entities / concepts / topics." };
      }
      if (!["entities", "concepts", "topics"].includes(section)) {
        return { ok: false, text: `Invalid section "${section}". Use entities | concepts | topics.` };
      }
      const slug = safeSlug(String(p.slug ?? ""));
      const file = resolvePage(ctx.userHomeDir, section, slug);
      if (!file) return { ok: false, text: `Unsafe section/slug: ${section}/${p.slug}` };
      const title = String(p.title ?? slug).trim();
      const body = String(p.body ?? "").trim();
      if (!body) return { ok: false, text: "body is required" };
      const links = Array.isArray(p.links) ? p.links.filter((l) => typeof l === "string") : undefined;
      const content = renderPage(
        {
          pageType: section === "entities" ? "entity" : section === "concepts" ? "concept" : "topic",
          title,
          updatedAt: new Date().toISOString(),
          status: "active",
          links,
        },
        `${body}\n`,
      );
      try {
        writePage(file, content);
      } catch (err) {
        return { ok: false, text: `write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      // Embed for semantic search (best-effort; no-op without a model).
      if (embeddingEnabled(cfg)) {
        await indexPage(ctx.userHomeDir, cfg, `${section}/${slug}`, `${title}\n\n${body}`);
      }
      return { ok: true, text: `wrote ${section}/${slug}` };
    },
  };
}

// ─── time-driven ingest tools (one DAY at a time) ──────────────
//
// The wiki walks the user's whole message timeline chronologically,
// one LOCAL-TIMEZONE DAY at a time, across all sessions merged into a
// single stream. Progress is a timestamp cursor (last recorded
// message's created_at): wiki_next_day returns the next day's messages
// (+ that day's tasks) after the cursor; wiki_day_done advances the
// cursor past that day. Session boundaries are irrelevant — a day is a
// day, which is exactly what the daily journal wants.

// Per-day transcript char cap so a very busy day still fits the tool
// result (we never split a day — the agent gets the whole day).
const DAY_MAX_CHARS = 40000;

// Host local timezone — the "current timezone" days are bucketed by.
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildNextDayTool(ctx: PluginContext): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_next_day",
      description:
        "Fetch the next unrecorded DAY of the user's conversation timeline (chronological, merged across all sessions), after the progress cursor. Returns that day's full raw transcript (timestamped messages) + the tasks created that day + progress. Distil it into wiki pages: a daily journal for that date (wiki_journal_write level=daily period=<that date>) plus any project/topic/concept pages (wiki_write_page), all [[wikilinked]]. Then call wiki_day_done to advance the cursor past that day. Returns done:true when the timeline is fully recorded.",
      parameters: Type.Object({}),
    },
    execute: (_raw, tctx: AgentToolContext): ToolResult => {
      const userId = tctx.userId;
      const home = tctx.userHomeDir;
      const cursor = readCursor(home).cursorMs;
      const span = messageTimeSpan(ctx.db, userId);
      if (span.max === 0) {
        return { ok: true, text: "No conversation messages to record yet.", data: { done: true } };
      }
      // Pull a chunk of messages after the cursor, then keep only the
      // FIRST local-day present — that's "the next day" to record.
      const batch = listMessagesAfter(ctx.db, userId, cursor, 2000);
      if (batch.length === 0) {
        return {
          ok: true,
          text: `All caught up — every message up to ${new Date(cursor).toISOString()} is recorded.`,
          data: { done: true, cursorMs: cursor },
        };
      }
      const firstDay = localDay(batch[0]!.created_at, LOCAL_TZ);
      const dayMsgs = batch.filter((m) => localDay(m.created_at, LOCAL_TZ) === firstDay);
      // If the 2000-row batch was ALL the same day and there may be
      // more of that day beyond it, pull the rest of that day too so we
      // never split a day across runs.
      if (dayMsgs.length === batch.length && batch.length === 2000) {
        let more = listMessagesAfter(ctx.db, userId, batch[batch.length - 1]!.created_at, 4000);
        more = more.filter((m) => localDay(m.created_at, LOCAL_TZ) === firstDay);
        dayMsgs.push(...more);
      }
      const dayStartMs = dayMsgs[0]!.created_at;
      const dayEndMs = dayMsgs[dayMsgs.length - 1]!.created_at;

      const timeOf = (ms: number) =>
        new Intl.DateTimeFormat("en-CA", {
          timeZone: LOCAL_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(new Date(ms));
      let transcript = dayMsgs
        .map((m) => `[${timeOf(m.created_at)}] ${messageToText(m.role, m.content)}`)
        .join("\n\n");
      let truncatedNote = "";
      if (transcript.length > DAY_MAX_CHARS) {
        transcript = transcript.slice(0, DAY_MAX_CHARS) + "\n\n…[day transcript truncated]";
        truncatedNote = " (transcript truncated — very busy day)";
      }

      // Tasks created within this day.
      const tasks = tasksInRange(ctx.db, userId, dayStartMs, dayEndMs);
      let tasksSection = "";
      if (tasks.length > 0) {
        const blocks = tasks.map((t) => {
          const files = parseResultFiles(t.result_files);
          const lines = [
            `### Task: ${t.title} [${t.status}]`,
            t.description ? `- brief: ${t.description}` : "",
            t.result_summary ? `- result: ${t.result_summary}` : "",
            files.length ? `- files: ${files.join(", ")}` : "",
          ].filter(Boolean);
          if (t.session_id) {
            const wmsgs = listSessionMessages(ctx.db, t.session_id);
            if (wmsgs.length > 0) {
              const wt = wmsgs.map((m) => messageToText(m.role, m.content)).join("\n");
              lines.push(`- worker transcript:\n${wt.slice(0, 6000)}`);
            }
          }
          return lines.join("\n");
        });
        tasksSection = `\n## Tasks created on ${firstDay} (${tasks.length})\n${blocks.join("\n\n")}`;
      }

      // Rough progress: cursor position within the message time span.
      const denom = span.max - span.min || 1;
      const progress = Math.max(0, Math.min(1, (dayEndMs - span.min) / denom));

      const parts = [
        `Day ${firstDay} (${LOCAL_TZ}) — ${dayMsgs.length} messages${truncatedNote}`,
        `Timeline progress ~${Math.round(progress * 100)}%.`,
        `\n## Transcript for ${firstDay} — each line prefixed with [HH:MM]\n${transcript || "(empty)"}`,
        tasksSection,
        `\n---\nRecord this day: write journal/daily/${firstDay} (wiki_journal_write level=daily period=${firstDay}) + any topic/entity/concept pages, [[wikilinked]]. Then call wiki_day_done({ throughMs: ${dayEndMs} }).`,
      ].filter(Boolean);

      return {
        ok: true,
        text: parts.join("\n"),
        data: { done: false, day: firstDay, throughMs: dayEndMs, messageCount: dayMsgs.length, progress },
      };
    },
  };
}

function buildResetTool(): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_reset",
      description:
        "Wipe the ENTIRE wiki vault (all pages + the ingest progress cursor) so it can be rebuilt from scratch. Destructive and irreversible — only use when the user explicitly asks to clear/reset the wiki. Requires confirm:true.",
      parameters: Type.Object({
        confirm: Type.Boolean({ description: "Must be true to actually wipe the vault." }),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolResult => {
      const p = raw as { confirm?: boolean };
      if (p.confirm !== true) {
        return { ok: false, text: "wiki_reset needs confirm:true — this wipes the whole wiki." };
      }
      const r = resetVault(ctx.userHomeDir);
      if (!r.ok) return { ok: false, text: `reset failed: ${r.reason}` };
      return { ok: true, text: `Wiki reset: removed ${r.removedPages} page(s) and cleared the progress cursor. Next update rebuilds from scratch.` };
    },
  };
}

function buildDayDoneTool(): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_day_done",
      description:
        "Advance the wiki progress cursor past a day you've finished recording. Pass throughMs from the wiki_next_day result. After this, wiki_next_day returns the following day.",
      parameters: Type.Object({
        throughMs: Type.Number({ description: "The throughMs value from wiki_next_day (last message time of the day just recorded)." }),
      }),
    },
    execute: (raw, tctx: AgentToolContext): ToolResult => {
      const p = raw as { throughMs?: number };
      const ms = typeof p.throughMs === "number" ? p.throughMs : 0;
      if (!ms) return { ok: false, text: "throughMs is required (use the value from wiki_next_day)." };
      setCursor(tctx.userHomeDir, ms);
      return { ok: true, text: `Cursor advanced to ${new Date(ms).toISOString()}. Call wiki_next_day for the next day.` };
    },
  };
}

// ─── journal tool (time dimension: daily → weekly → monthly → yearly) ─
//
// A/幂等: each level is written/rewritten in place. daily is filled as
// the agent processes a day's sessions; weekly/monthly/yearly are
// recomputed by reading their child level after a batch. Journals link
// to the topics/entities/concepts they touch, and topics link back to
// the days they span — the time layer and the thematic layer cross-
// reference each other.

function periodLabel(level: JournalLevel, period: string): string {
  if (level === "weekly") {
    const r = isoWeekRange(period);
    if (r) return `${period} (${r.start} ~ ${r.end})`;
  }
  return period;
}

function buildJournalWriteTool(cfg?: EmbeddingConfig): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_journal_write",
      description:
        "Create or overwrite a time-journal entry. Levels: daily (period YYYY-MM-DD), weekly (YYYY-Www, ISO week), monthly (YYYY-MM), yearly (YYYY). Fill `daily` as you process each day's sessions — note what was done that day and cross-link the topics/projects/concepts it touched with [[wikilinks]] (a day can span several topics; a topic can span several days). Recompute `weekly` by reading that week's dailies, `monthly` from its weeks, `yearly` from its months (roll-ups summarise, don't repeat detail; link down to the child entries). Writing is idempotent — safe to rewrite.",
      parameters: Type.Object({
        level: Type.String({ description: "daily | weekly | monthly | yearly" }),
        period: Type.String({
          description: "Period key: daily=YYYY-MM-DD, weekly=YYYY-Www, monthly=YYYY-MM, yearly=YYYY.",
        }),
        title: Type.Optional(Type.String({ description: "Optional title; defaults to a labelled period." })),
        body: Type.String({ description: "Markdown body. Use [[wikilinks]] to topics/entities/concepts and child journal entries." }),
        links: Type.Optional(
          Type.Array(Type.String(), { description: "Related page paths, e.g. [\"topics/board-plugin\"]." }),
        ),
      }),
    },
    execute: async (raw, ctx: AgentToolContext): Promise<ToolResult> => {
      const p = raw as { level?: string; period?: string; title?: string; body?: string; links?: string[] };
      const level = String(p.level ?? "") as JournalLevel;
      if (!JOURNAL_LEVELS.includes(level)) {
        return { ok: false, text: `Invalid level "${p.level}". Use daily | weekly | monthly | yearly.` };
      }
      const period = String(p.period ?? "").trim();
      if (!isValidPeriod(level, period)) {
        return {
          ok: false,
          text: `Invalid ${level} period "${period}". Expected ${level === "daily" ? "YYYY-MM-DD" : level === "weekly" ? "YYYY-Www" : level === "monthly" ? "YYYY-MM" : "YYYY"}.`,
        };
      }
      const section = `journal/${level}`;
      const file = resolvePage(ctx.userHomeDir, section, period);
      if (!file) return { ok: false, text: `Unsafe journal path: ${section}/${period}` };
      const body = String(p.body ?? "").trim();
      if (!body) return { ok: false, text: "body is required" };
      const label = periodLabel(level, period);
      const title = String(p.title ?? "").trim() || `${level[0]!.toUpperCase()}${level.slice(1)} · ${label}`;
      const links = Array.isArray(p.links) ? p.links.filter((l) => typeof l === "string") : undefined;
      const content = renderPage(
        {
          pageType: "journal",
          level,
          period,
          periodLabel: label,
          title,
          updatedAt: new Date().toISOString(),
          status: "active",
          links,
        },
        `${body}\n`,
      );
      try {
        writePage(file, content);
      } catch (err) {
        return { ok: false, text: `write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (embeddingEnabled(cfg)) {
        await indexPage(ctx.userHomeDir, cfg, `${section}/${period}`, `${title}\n\n${body}`);
      }
      return { ok: true, text: `wrote ${section}/${period}` };
    },
  };
}

// ─── REST routes (mounted under /api/p/wiki/*) ──────────────────

function userIdFromReq(req: Request): string {
  const ctx = (req as { ctx?: { userId?: string } }).ctx;
  return ctx?.userId ?? "";
}

function buildRoutes(ctx: PluginContext): Record<string, PluginRouteHandler> {
  const list: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    res.json({ pages: listPages(ctx.userHomeDir(userId)), sections: SECTIONS });
  };

  const read: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    const section = String(req.query.section ?? "");
    const slug = String(req.query.slug ?? "");
    const md = readPage(ctx.userHomeDir(userId), section, slug);
    if (md === null) return void res.status(404).json({ error: "not found" });
    res.json({ markdown: md });
  };

  const search: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    const q = String(req.query.q ?? "");
    res.json({ hits: searchPages(ctx.userHomeDir(userId), q) });
  };

  const status: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    // Progress = where the time cursor sits within the message time
    // span. Drives the ring on the record button.
    let progress = 0;
    try {
      const cursor = readCursor(ctx.userHomeDir(userId)).cursorMs;
      const span = messageTimeSpan(ctx.db, userId);
      if (span.max > span.min) {
        progress = Math.max(0, Math.min(1, (cursor - span.min) / (span.max - span.min)));
      } else if (span.max > 0 && cursor >= span.max) {
        progress = 1;
      }
    } catch {
      /* best-effort */
    }
    res.json({
      running: running.has(runKey(ctx.tenantId, userId)),
      progress,
    });
  };

  const graph: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    res.json(buildGraph(ctx.userHomeDir(userId)));
  };

  const reset: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    if (running.has(runKey(ctx.tenantId, userId))) {
      return void res.status(409).json({ error: "a wiki update is running; wait for it to finish" });
    }
    const r = resetVault(ctx.userHomeDir(userId));
    if (!r.ok) return void res.status(500).json({ error: r.reason });
    res.json({ ok: true, removedPages: r.removedPages });
  };

  // Kick off the background wiki-worker (host.agentLoop). Runs in its
  // OWN session (kind='worker', worker_role='wiki') so the analysis
  // never pollutes the user's conversation and can't recurse on
  // itself (listUserSessions excludes worker_role='wiki'). Returns
  // immediately; the worker notifies the requesting session via
  // host.sessionInbox when it's done.
  const record: PluginRouteHandler = (req: Request, res: Response) => {
    const userId = userIdFromReq(req);
    if (!userId) return void res.status(401).json({ error: "no user context" });
    const key = runKey(ctx.tenantId, userId);
    if (running.has(key)) {
      return void res.json({ started: false, reason: "a wiki update is already running" });
    }
    const runner = ctx.capabilities.get<AgentLoopRunner>("host.agentLoop");
    if (!runner) {
      return void res.status(503).json({ error: "host.agentLoop unavailable" });
    }
    const parentSessionId =
      typeof (req.body as { sessionId?: unknown })?.sessionId === "string"
        ? (req.body as { sessionId: string }).sessionId
        : null;

    running.add(key);
    void (async () => {
      let summary = "";
      let status: string = "error";
      try {
        const result = await runner.run({
          userId,
          initialUserMessage: recordWikiPrompt(
            (ctx.tenantConfig as { outputLanguage?: "auto" | "en" | "zh" })?.outputLanguage,
          ),
          workerRole: WIKI_WORKER_ROLE,
          workerSlug: WIKI_WORKER_ROLE,
          sessionTitle: "Wiki update",
          toolsAllow: WIKI_WORKER_TOOLS,
          parentSessionId,
          timeouts: { firstResponseMs: 0, idleMs: 0, maxRunMs: 30 * 60_000 },
        });
        summary = result.summary;
        status = result.status;
      } catch (err) {
        summary = err instanceof Error ? err.message : String(err);
        status = "error";
      } finally {
        running.delete(key);
      }
      // Notify the requesting session (best-effort).
      if (parentSessionId) {
        try {
          const inbox = ctx.capabilities.get<SessionInboxCapability>("host.sessionInbox");
          await inbox?.enqueue(parentSessionId, {
            kind: "system_note",
            text:
              status === "done"
                ? `📓 Wiki updated. ${summary}`
                : `📓 Wiki update finished (${status}). ${summary}`,
          });
        } catch {
          /* inbox is best-effort */
        }
      }
    })();

    res.json({ started: true });
  };

  return { list, read, search, status, record, reset, graph };
}

// ─── wiki.ingest capability (host compaction hook calls this) ────

function buildIngestCapability(ctx: PluginContext): WikiIngestCapability {
  return {
    async ingestSource(input: WikiIngestInput): Promise<WikiIngestResult> {
      try {
        return ingestSource({
          userHome: ctx.userHomeDir(input.userId),
          sessionId: input.sessionId,
          summary: input.summary,
          endedAtMs: input.endedAtMs,
          title: input.title,
        });
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    // Embedding config is plugin-scoped (Settings → Plugins → Wiki),
    // stored under plugins.wiki.config.embedding and delivered here via
    // pluginConfig (the apiKey secret is merged in from secrets/).
    const embRaw = (ctx.pluginConfig as { embedding?: unknown })?.embedding;
    const cfg =
      embRaw && typeof embRaw === "object" ? (embRaw as EmbeddingConfig) : undefined;
    ctx.log.info(`wiki activated (embedding: ${embeddingEnabled(cfg) ? cfg!.model : "off, keyword search"})`);
    return {
      tools: {
        WikiNextDayTool: buildNextDayTool(ctx),
        WikiDayDoneTool: buildDayDoneTool(),
        WikiListSourcesTool: buildListSourcesTool(),
        WikiListPagesTool: buildListPagesTool(),
        WikiReadTool: buildReadTool(),
        WikiSearchTool: buildSearchTool(cfg),
        WikiWritePageTool: buildWritePageTool(cfg),
        WikiJournalWriteTool: buildJournalWriteTool(cfg),
        WikiResetTool: buildResetTool(),
      },
      routes: buildRoutes(ctx),
      capabilityProviders: { "wiki.ingest": buildIngestCapability(ctx) },
    };
  },
  async deactivate() {
    /* nothing to tear down */
  },
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
