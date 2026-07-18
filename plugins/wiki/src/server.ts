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
} from "./vault.js";
import { ingestSource } from "./ingest.js";

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

  return { list, read, search };
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
