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
} from "./vault.js";
import { ingestSource } from "./ingest.js";
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
const RECORD_WIKI_PROMPT = [
  "You are updating the user's LLM Wiki from their conversation timeline. Work incrementally, session by session:",
  "1. Call wiki_next_session to fetch the next unprocessed session (its transcript, spawned tasks, and produced files) plus progress.",
  "2. Read and understand it, then distil it into wiki pages via wiki_write_page across three dimensions: project (section=entities), date/timeline (section=topics), and technology/knowledge points (section=concepts). Cross-link related pages with Obsidian [[section/slug]] wikilinks. Reuse wiki_search / wiki_list_pages / wiki_read first so you extend existing pages instead of duplicating them.",
  "3. Call wiki_session_done with that sessionId to advance the cursor.",
  "4. Repeat. Stop when wiki_next_session reports done:true, or after ~10 sessions this run (the cursor persists, so the next run resumes where you left off). Then give a one-paragraph summary of what you recorded.",
].join("\n");

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
];

// Per-user run lock: only one wiki-worker in flight at a time so two
// clicks (or two channels) don't double-process the same sessions.
const running = new Set<string>();

function runKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
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
      if (parts.length !== 2) {
        return { ok: false, text: `Invalid path "${p.path}". Use <section>/<slug>.` };
      }
      const md = readPage(ctx.userHomeDir, parts[0]!, parts[1]!);
      if (md === null) return { ok: false, text: `Page not found: ${p.path}` };
      return { ok: true, text: md.slice(0, 16000) };
    },
  };
}

function buildSearchTool(): AgentTool {
  return {
    schema: {
      name: "wiki_search",
      description:
        "Full-text search the user's wiki (titles + bodies). Returns matching page paths with a snippet. Use to recall prior work, decisions, people, or facts distilled from past conversations.",
      parameters: Type.Object({
        query: Type.String({ description: "Search text." }),
        limit: Type.Optional(Type.Number({ description: "Max results (default 20)." })),
      }),
    },
    execute: (raw, ctx: AgentToolContext): ToolResult => {
      const p = raw as { query?: string; limit?: number };
      const q = String(p.query ?? "").trim();
      if (!q) return { ok: false, text: "query is required" };
      const hits = searchPages(ctx.userHomeDir, q, typeof p.limit === "number" ? p.limit : 20);
      if (hits.length === 0) return { ok: true, text: `No wiki hits for "${q}".` };
      const lines = hits.map((h) => `- ${h.path} — ${h.title}\n    …${h.snippet}…`);
      return { ok: true, text: `Wiki hits for "${q}" (${hits.length}):\n${lines.join("\n")}` };
    },
  };
}

function buildWritePageTool(): AgentTool {
  return {
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
    execute: (raw, ctx: AgentToolContext): ToolResult => {
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
        `# ${title}\n\n${body}\n`,
      );
      try {
        writePage(file, content);
      } catch (err) {
        return { ok: false, text: `write failed: ${err instanceof Error ? err.message : String(err)}` };
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

const MAX_TRANSCRIPT_CHARS = 24000;

function sessionLabel(s: SessionRow): string {
  const date = new Date(s.created_at).toISOString().slice(0, 10);
  const short = s.id.replace(/^sess?_/, "").replace(/^session_/, "").slice(0, 8);
  return `${date} · ${s.title?.trim() || short}`;
}

function buildNextSessionTool(ctx: PluginContext): AgentTool {
  return {
    schema: {
      name: "wiki_next_session",
      description:
        "Fetch the next unprocessed conversation session (oldest first) for the wiki, with its full transcript, the worker tasks it spawned (their summaries + produced files), and progress info (how many sessions are done / remaining). Read this, distil it into wiki pages with wiki_write_page across the project / date / topic dimensions (link related pages with [[wikilinks]]), then call wiki_session_done to advance. Returns done:true when the whole timeline is processed.",
      parameters: Type.Object({}),
    },
    execute: (_raw, tctx: AgentToolContext): ToolResult => {
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

      const msgs = listSessionMessages(ctx.db, next.id);
      const transcriptFull = msgs.map((m) => messageToText(m.role, m.content)).join("\n\n");
      const transcript =
        transcriptFull.length > MAX_TRANSCRIPT_CHARS
          ? transcriptFull.slice(-MAX_TRANSCRIPT_CHARS) + "\n\n…[older turns truncated]"
          : transcriptFull;

      const tasks = listSessionTasks(ctx.db, next.id);
      const taskBlocks: string[] = [];
      for (const t of tasks) {
        const files = parseResultFiles(t.result_files);
        const lines = [
          `### Task: ${t.title} [${t.status}]`,
          t.description ? `- brief: ${t.description}` : "",
          t.result_summary ? `- result: ${t.result_summary}` : "",
          files.length ? `- files: ${files.join(", ")}` : "",
        ].filter(Boolean);
        // Pull the worker session's transcript too (short) if present.
        if (t.session_id) {
          const wmsgs = listSessionMessages(ctx.db, t.session_id);
          if (wmsgs.length > 0) {
            const wt = wmsgs.map((m) => messageToText(m.role, m.content)).join("\n");
            lines.push(`- worker transcript:\n${wt.slice(0, 6000)}`);
          }
        }
        taskBlocks.push(lines.join("\n"));
      }

      const parts = [
        `Session ${next.id} (${sessionLabel(next)})`,
        `status=${next.status}${next.project_slug ? ` project=${next.project_slug}` : ""} · progress ${doneCount}/${total} done, this is the next one.`,
        next.compacted_summary ? `\n## Prior compaction summary\n${next.compacted_summary}` : "",
        `\n## Transcript\n${transcript || "(empty)"}`,
        tasks.length ? `\n## Spawned tasks (${tasks.length})\n${taskBlocks.join("\n\n")}` : "",
        `\n---\nNow distil this into wiki pages (project / date / topic dimensions, [[wikilinked]]), then call wiki_session_done({ sessionId: "${next.id}" }).`,
      ].filter(Boolean);

      return {
        ok: true,
        text: parts.join("\n"),
        data: { done: false, sessionId: next.id, total, doneCount },
      };
    },
  };
}

function buildSessionDoneTool(): AgentTool {
  return {
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
          initialUserMessage: RECORD_WIKI_PROMPT,
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

  return { list, read, search, status, record };
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
    ctx.log.info("wiki activated");
    return {
      tools: {
        WikiNextSessionTool: buildNextSessionTool(ctx),
        WikiSessionDoneTool: buildSessionDoneTool(),
        WikiListSourcesTool: buildListSourcesTool(),
        WikiListPagesTool: buildListPagesTool(),
        WikiReadTool: buildReadTool(),
        WikiSearchTool: buildSearchTool(),
        WikiWritePageTool: buildWritePageTool(),
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
