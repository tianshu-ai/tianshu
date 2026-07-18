// `wiki.ingest` capability contract.
//
// Provided by the `wiki` plugin; consumed by the host's compaction
// path. After the host compacts a conversation segment (summarise →
// fork), it hands the segment's distilled summary here so the wiki
// plugin can file it as a source page in the user's Obsidian-style
// vault. The call is best-effort and fire-and-forget: the host must
// never let a wiki failure affect the chat/compaction path.

export interface WikiIngestInput {
  /** Tenant-scoped user whose wiki should receive the source. */
  userId: string;
  /** Session id of the segment that was just compacted. */
  sessionId: string;
  /** The compaction summary (already LLM-distilled by the host). */
  summary: string;
  /** Epoch ms the segment ended (compaction time). Optional. */
  endedAtMs?: number;
  /** Optional human title for the segment. */
  title?: string;
}

export interface WikiIngestResult {
  ok: boolean;
  /** "<section>/<slug>" of the written page when ok. */
  page?: string;
  /** Reason when skipped/failed (e.g. "already ingested"). */
  reason?: string;
}

/** The shape registered at `wiki.ingest`. */
export interface WikiIngestCapability {
  /** File one compacted segment as a wiki source. Always resolves;
   *  never throws (returns {ok:false, reason} instead). */
  ingestSource(input: WikiIngestInput): Promise<WikiIngestResult>;
}
