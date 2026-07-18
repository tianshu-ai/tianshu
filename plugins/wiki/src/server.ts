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
  markIngested,
  alreadyIngested,
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
  pruneIndex,
  type EmbeddingConfig,
} from "./embedding.js";
import {
  listUserSessions,
  listSessionMessages,
  listSessionTasks,
  messageToText,
  parseResultFiles,
  WIKI_WORKER_ROLE,
  type SessionRow,
} from "./sessions.js";

// The instruction the wiki-worker runs. Kept here so the recording
// strategy is easy to tweak. The worker walks the session timeline
// incrementally and distils each into pages across three dimensions.
const RECORD_WIKI_STEPS = [
  "You are updating the user's LLM Wiki from their conversation timeline. Work incrementally, session by session:",
  "1. Call wiki_next_session to fetch the next unprocessed session's RAW transcript (paginated). If the result's has_more is true, call wiki_next_session again with page:<nextPage> and keep going until you've read the whole session (has_more=false). Note the session's date.",
  "2. Read and understand it, then record across BOTH layers:",
  "   • THEMATIC (wiki_write_page): project → section=entities; reusable tech/knowledge points → section=concepts; a cross-time thread/undertaking (e.g. 'build the board plugin', which may span several days) → section=topics.",
  "   • TIME (wiki_journal_write): messages are timestamped [YYYY-MM-DD HH:MM] and a single session can span MANY days — write/update a SEPARATE daily entry PER DATE that appears (level=daily, period=that YYYY-MM-DD), not one per session. Each daily notes what was done that day, cross-linking the topics/entities/concepts it touched with [[section/slug]]. A day usually spans several topics; a topic usually spans several days — link both ways (also add the day to the topic page's timeline).",
  "3. Only after reading every page of the session, call wiki_session_done with that sessionId to advance the cursor.",
  "4. Repeat for a batch. When you've covered the sessions of a given ISO week / month / year, roll them up with wiki_journal_write: weekly (period YYYY-Www) from that week's dailies, monthly (YYYY-MM) from its weeks, yearly (YYYY) from its months. Roll-ups summarise and link down — don't repeat detail.",
  "5. Stop when wiki_next_session reports done:true, or after ~10 sessions this run (the cursor persists; the next run resumes). Then give a one-paragraph summary of what you recorded.",
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
  "wiki_next_session",
  "wiki_session_done",
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

// ─── session-driven ingest tools ────────────────────────────────
//
// The wiki is built by walking the user's session timeline oldest
// first: wiki_next_session hands the agent one unprocessed session's
// full material; the agent distils it into pages via wiki_write_page;
// wiki_session_done advances the cursor. Progress is persisted so a
// later run resumes from the cut-off point instead of redoing work.

// Paginate a session's raw transcript by character budget so a long
// conversation is handed over in full across several pages instead of
// being truncated. The agent reads page 0, 1, 2… until has_more=false,
// then marks the session done.
const PAGE_CHARS = 18000;

/** Slice rendered message blocks into a page starting at `startIndex`,
 *  packing whole messages until the char budget is hit (always at
 *  least one message so a huge single message still makes progress). */
function paginateBlocks(
  blocks: string[],
  startIndex: number,
): { text: string; nextIndex: number; hasMore: boolean } {
  let end = startIndex;
  let size = 0;
  while (end < blocks.length) {
    const len = blocks[end]!.length + 2;
    if (size > 0 && size + len > PAGE_CHARS) break;
    size += len;
    end++;
  }
  if (end === startIndex && startIndex < blocks.length) end = startIndex + 1;
  return {
    text: blocks.slice(startIndex, end).join("\n\n"),
    nextIndex: end,
    hasMore: end < blocks.length,
  };
}

function sessionLabel(s: SessionRow): string {
  // No date here on purpose: a session's messages can span many days,
  // so the session's own created_at is a misleading "date". Day
  // attribution comes from each message's timestamp instead.
  const short = s.id.replace(/^sess?_/, "").replace(/^session_/, "").slice(0, 8);
  return s.title?.trim() || short;
}

function buildNextSessionTool(ctx: PluginContext): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_next_session",
      description:
        "Fetch the next unprocessed conversation session (oldest first) for the wiki — the RAW original transcript (not a compaction summary), paginated. Read this page, distil it into wiki pages with wiki_write_page / wiki_journal_write (project / date / topic dimensions, [[wikilinked]]). If has_more is true, call wiki_next_session again with page:<nextPage> to get the rest of THIS session before moving on. Only call wiki_session_done once you've read every page (has_more=false). Returns done:true when the whole timeline is processed.",
      parameters: Type.Object({
        page: Type.Optional(
          Type.Number({ description: "0-based page of the current session's transcript (default 0). Use the nextPage from the previous call." }),
        ),
      }),
    },
    execute: (raw, tctx: AgentToolContext): ToolResult => {
      const rp = raw as { page?: number };
      const page = typeof rp.page === "number" && rp.page >= 0 ? Math.floor(rp.page) : 0;
      const userId = tctx.userId;
      const home = tctx.userHomeDir;
      const all = listUserSessions(ctx.db, userId);
      const processed = new Set(readCursor(home).ingestedSessionIds);
      const total = all.length;
      const doneCount = all.filter((s) => processed.has(s.id)).length;
      const next = all.find((s) => !processed.has(s.id));
      if (!next) {
        return {
          ok: true,
          text: `All ${total} sessions processed. Wiki is up to date. (done ${doneCount}/${total})`,
          data: { done: true, total, doneCount },
        };
      }

      // RAW original messages (not the compaction summary), paginated
      // by char budget so nothing is dropped from a long session.
      //
      // IMPORTANT: a rolling-window session can span many DAYS (its
      // messages carry their own created_at; session.created_at is just
      // when the row was forked). So we prefix each message with its
      // own date+time and report the day span — the agent must split
      // daily journals by MESSAGE date, not by the session's date.
      const msgs = listSessionMessages(ctx.db, next.id);
      const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const timeOf = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
      const blocks = msgs.map(
        (m) => `[${timeOf(m.created_at)}] ${messageToText(m.role, m.content)}`,
      );
      const msgDays = [...new Set(msgs.map((m) => dayOf(m.created_at)))].sort();
      const { text: transcript, nextIndex, hasMore } = paginateBlocks(blocks, page);
      const totalPages = (() => {
        // rough page count for display
        let pages = 0, i = 0;
        while (i < blocks.length) { i = paginateBlocks(blocks, i).nextIndex; pages++; }
        return Math.max(1, pages);
      })();
      const nextPage = page + 1;

      // Spawned tasks only on the LAST page (once the full transcript is
      // read), so they aren't repeated across pages.
      let tasksSection = "";
      if (!hasMore) {
        const tasks = listSessionTasks(ctx.db, next.id);
        if (tasks.length > 0) {
          const taskBlocks = tasks.map((t) => {
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
          tasksSection = `\n## Spawned tasks (${tasks.length})\n${taskBlocks.join("\n\n")}`;
        }
      }

      const footer = hasMore
        ? `\n---\nMore of this session remains. Call wiki_next_session({ page: ${nextPage} }) for the rest BEFORE wiki_session_done.`
        : `\n---\nThat's the full session. Distil it into wiki pages (project / date / topic, [[wikilinked]]), then call wiki_session_done({ sessionId: "${next.id}" }).`;

      const dayNote =
        msgDays.length > 1
          ? `\n⚠ This session spans ${msgDays.length} days: ${msgDays.join(", ")}. Each message below is timestamped — write a SEPARATE daily journal per date (wiki_journal_write level=daily period=<that date>), not one for the session.`
          : msgDays.length === 1
            ? `\nAll messages are from ${msgDays[0]}.`
            : "";

      const parts = [
        `Session ${next.id} (${sessionLabel(next)}) — raw transcript, page ${page + 1}/${totalPages}`,
        `status=${next.status}${next.project_slug ? ` project=${next.project_slug}` : ""} · sessions ${doneCount}/${total} done.${dayNote}`,
        `\n## Transcript (page ${page + 1}/${totalPages}) — each line prefixed with [YYYY-MM-DD HH:MM]\n${transcript || "(empty)"}`,
        tasksSection,
        footer,
      ].filter(Boolean);

      return {
        ok: true,
        text: parts.join("\n"),
        data: {
          done: false,
          sessionId: next.id,
          total,
          doneCount,
          page,
          nextPage: hasMore ? nextPage : null,
          hasMore,
          totalPages,
        },
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

function buildSessionDoneTool(): AgentTool {
  return {
    available: isWikiWorker,
    schema: {
      name: "wiki_session_done",
      description:
        "Mark a session as processed for the wiki (advance the progress cursor) after you've written its pages. Pass the sessionId from wiki_next_session.",
      parameters: Type.Object({
        sessionId: Type.String({ description: "Session id that was just distilled into the wiki." }),
      }),
    },
    execute: (raw, tctx: AgentToolContext): ToolResult => {
      const p = raw as { sessionId?: string };
      const sid = String(p.sessionId ?? "").trim();
      if (!sid) return { ok: false, text: "sessionId is required" };
      if (alreadyIngested(tctx.userHomeDir, sid)) {
        return { ok: true, text: `Session ${sid} was already marked done.` };
      }
      markIngested(tctx.userHomeDir, sid);
      return { ok: true, text: `Marked session ${sid} done. Call wiki_next_session for the next one.` };
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
    res.json({ running: running.has(runKey(ctx.tenantId, userId)) });
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
        WikiNextSessionTool: buildNextSessionTool(ctx),
        WikiSessionDoneTool: buildSessionDoneTool(),
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
