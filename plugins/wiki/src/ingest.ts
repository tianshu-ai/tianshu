// Ingest: turn a compacted conversation segment into a wiki source page.
//
// A "segment" is one link in the rolling-window session chain: when the
// host compacts, it produces an LLM summary and forks a new session.
// That summary is already a structured distillation of the segment, so
// we file it verbatim as a source (the evidence layer). Topic-level
// synthesis (entities / concepts / topics) happens later, across many
// sources, via the wiki_synthesize tool.

import { resolvePage, renderPage, writePage, safeSlug } from "./vault.js";

export interface IngestSourceArgs {
  userHome: string;
  /** Session id of the segment that was just compacted. */
  sessionId: string;
  /** The compaction summary text (already LLM-distilled). */
  summary: string;
  /** Epoch ms the segment ended (compaction time). */
  endedAtMs?: number;
  /** Optional human title for the segment. */
  title?: string;
}

export interface IngestResult {
  ok: boolean;
  /** "<section>/<slug>" of the written page, when ok. */
  page?: string;
  reason?: string;
}

/** File one compacted segment as a source page. Best-effort: returns
 *  {ok:false, reason} instead of throwing so a compact hook never
 *  breaks the chat path. (Dormant: the compact→wiki auto-hook is
 *  disabled; kept behind the wiki.ingest capability for later.) */
export function ingestSource(args: IngestSourceArgs): IngestResult {
  const { userHome, sessionId, summary } = args;
  const text = (summary ?? "").trim();
  if (!text) return { ok: false, reason: "empty summary" };
  if (!sessionId) return { ok: false, reason: "no session id" };

  const endedAt = args.endedAtMs ? new Date(args.endedAtMs) : new Date();
  const iso = endedAt.toISOString();
  const datePart = iso.slice(0, 10);
  const shortSid = sessionId.replace(/^sess?_/, "").slice(0, 8);
  const slug = safeSlug(`${datePart}-${shortSid}`);
  const file = resolvePage(userHome, "sources", slug);
  if (!file) return { ok: false, reason: "unsafe slug" };

  const title = args.title?.trim() || `Session ${shortSid} (${datePart})`;
  const content = renderPage(
    {
      pageType: "source",
      title,
      sessionId,
      endedAt: iso,
      status: "active",
    },
    `> Compacted conversation segment (session \`${sessionId}\`).\n\n${text}\n`,
  );
  try {
    writePage(file, content);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, page: `sources/${slug}` };
}
