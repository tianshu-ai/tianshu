// Embedding-backed semantic search for the wiki.
//
// When the tenant has configured an embedding model (Settings →
// Plugins → Wiki, picking a model configured in Settings → Models), the
// wiki-worker embeds each page it writes and stores the vector in the
// tenant DB (sqlite-vec `vec0` table) alongside an FTS5 full-text row.
// wiki_search then embeds the query and fuses vector KNN + FTS5 BM25
// via Reciprocal Rank Fusion. With no embedding model configured,
// everything here no-ops and the caller falls back to plain keyword
// search over page files.
//
// Embedding endpoint: OpenAI-compatible `/embeddings` (OpenAI,
// llama.cpp, Ollama, LM Studio, proxies) OR Gemini native
// `:batchEmbedContents` when the provider api is google-generative-ai.
// Zero extra deps for the HTTP calls: plain fetch. Storage uses the
// host-loaded sqlite-vec extension + SQLite's built-in FTS5.

import type { TenantDbHandle } from "@tianshu-ai/plugin-sdk";

export interface EmbeddingConfig {
  baseUrl?: string;
  model?: string;
  /** Wire protocol. `google-generative-ai` → Gemini native
   *  `:batchEmbedContents`; anything else → OpenAI `/embeddings`. */
  api?: string;
  apiKey?: string;
  dimensions?: number;
}

export function embeddingEnabled(cfg?: EmbeddingConfig): cfg is EmbeddingConfig {
  return !!cfg && !!cfg.model && !!cfg.baseUrl;
}

/** Redacted key descriptor for error messages: distinguishes "no key
 *  sent" from "key present but rejected" without leaking the secret. */
function keyHint(key: string): string {
  if (!key) return "MISSING (none sent)";
  return `present, ${key.length} chars, …${key.slice(-4)}`;
}

// ─── embedding HTTP ─────────────────────────────────────────────────

/** Call the embeddings endpoint for one or more inputs, dispatching by
 *  provider protocol. Returns one vector per input, or throws. */
export async function embed(
  cfg: EmbeddingConfig,
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  if (cfg.api === "google-generative-ai") {
    return embedGemini(cfg, inputs, signal);
  }
  return embedOpenAI(cfg, inputs, signal);
}

/** OpenAI-compatible `/embeddings` (OpenAI, llama.cpp, Ollama /v1,
 *  LM Studio, and any proxy speaking the same shape). */
async function embedOpenAI(
  cfg: EmbeddingConfig,
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const base = (cfg.baseUrl ?? "").replace(/\/$/, "");
  const url = `${base}/embeddings`;
  const body: Record<string, unknown> = { model: cfg.model, input: inputs };
  if (cfg.dimensions) body.dimensions = cfg.dimensions;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `embeddings ${res.status} [apiKey: ${keyHint(cfg.apiKey ?? "")}]: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const data = json.data ?? [];
  if (data.length !== inputs.length) {
    throw new Error(`embeddings returned ${data.length} vectors for ${inputs.length} inputs`);
  }
  return data.map((d) => d.embedding);
}

/** Gemini embedding via a Vertex-style proxy interface:
 *    POST {baseUrl}/v1beta/models/<model>:embedContent
 *    Authorization: Bearer <key>
 *    { instances: [ { content: "<text>", task_type: "RETRIEVAL_DOCUMENT" } ] }
 *  and the response carries one embedding per instance. This matches
 *  the self-hosted `google-generative-ai` proxies people run (e.g. a
 *  local gateway on :6655/gemini) rather than Google's public API.
 *
 *  Response shape varies across proxies; we accept the common ones:
 *    { predictions: [ { embeddings: { values: [...] } } ] }   (Vertex)
 *    { embeddings: [ { values: [...] } ] }                    (native batch)
 *    { predictions: [ { embedding: { values } | number[] } ] }
 *    { embedding: { values: [...] } }                         (single) */
async function embedGemini(
  cfg: EmbeddingConfig,
  inputs: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  let base = (cfg.baseUrl ?? "").replace(/\/$/, "");
  // The proxy expects a version segment; add it if the configured
  // baseUrl stops at the mount (e.g. ".../gemini").
  if (!/\/v\d/.test(base)) base = `${base}/v1beta`;
  const modelId = cfg.model!.replace(/^models\//, "");
  const url = `${base}/models/${modelId}:embedContent`;
  const key = cfg.apiKey ?? "";
  const body = {
    instances: inputs.map((text) => ({
      content: text,
      task_type: "RETRIEVAL_DOCUMENT",
      ...(cfg.dimensions ? { output_dimensionality: cfg.dimensions } : {}),
    })),
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `embedContent ${res.status} [apiKey: ${keyHint(key)}]: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as Record<string, unknown>;
  const vectors = extractGeminiVectors(json);
  if (vectors.length !== inputs.length) {
    throw new Error(
      `embedContent returned ${vectors.length} vectors for ${inputs.length} inputs; response keys: ${Object.keys(json).join(",")}`,
    );
  }
  return vectors;
}

/** Pull embedding vectors out of the several response shapes proxies
 *  return for embedContent/predict. Returns [] if none recognised. */
function extractGeminiVectors(json: Record<string, unknown>): number[][] {
  const asValues = (o: unknown): number[] | null => {
    if (Array.isArray(o) && typeof o[0] === "number") return o as number[];
    if (o && typeof o === "object") {
      const v = (o as { values?: unknown }).values;
      if (Array.isArray(v) && typeof v[0] === "number") return v as number[];
      const e = (o as { embedding?: unknown }).embedding;
      if (e) return asValues(e);
    }
    return null;
  };
  const preds = (json as { predictions?: unknown[] }).predictions;
  if (Array.isArray(preds)) {
    const out = preds
      .map((pr) => asValues((pr as { embeddings?: unknown }).embeddings ?? pr))
      .filter((v): v is number[] => v !== null);
    if (out.length) return out;
  }
  const embs = (json as { embeddings?: unknown }).embeddings;
  if (Array.isArray(embs)) {
    const out = embs.map(asValues).filter((v): v is number[] => v !== null);
    if (out.length) return out;
  }
  const single = asValues((json as { embedding?: unknown }).embedding);
  if (single) return [single];
  return [];
}

// ─── SQLite-backed index (sqlite-vec + FTS5) ────────────────────────
//
// Vectors live in a `vec0` virtual table and page text in an FTS5
// table, BOTH in the tenant DB (per-tenant db.sqlite), partitioned by
// user_id. Search fuses vector KNN + FTS5 BM25 with Reciprocal Rank
// Fusion (RRF). Degrades gracefully when sqlite-vec isn't loaded
// (db.vecAvailable === false) → FTS5-only; and when FTS5 itself is
// unavailable → the caller's plain keyword file scan.

const VEC_TABLE = "wiki_vec";
const FTS_TABLE = "wiki_fts";
const META_TABLE = "wiki_index_meta";
const RRF_K = 60; // standard RRF damping constant

function f32blob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export interface SemanticHit {
  path: string;
  score: number;
}

/** Outcome of a semantic search attempt — discriminated so the caller
 *  can tell "not configured" (mode=semantic should error) apart from
 *  "configured but empty/failed" (fall back to keyword). */
export type SemanticOutcome =
  | { status: "disabled" } // no embedding model configured
  | { status: "empty" } // configured but nothing indexed yet
  | { status: "error"; reason: string } // embed call / index failed
  | { status: "ok"; hits: SemanticHit[] };

/** A per-(tenant-db, user) index handle. Constructed once per request
 *  from ctx.db + userId. Lazily ensures the schema exists. */
export class WikiIndex {
  constructor(
    private readonly db: TenantDbHandle,
    private readonly userId: string,
  ) {}

  get vecAvailable(): boolean {
    return this.db.vecAvailable === true;
  }

  private ftsReady(): boolean {
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
           user_id UNINDEXED, page_key UNINDEXED, body )`,
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Ensure FTS5 (+ vec0 when available) tables exist for the current
   *  model/dimension. If the model or dimension changed since last
   *  time, the vector table is dropped + recreated (old vectors are
   *  incomparable across models/dims). Returns false if setup failed. */
  prepare(model: string, dim: number): boolean {
    try {
      this.ftsReady();
      if (!this.vecAvailable) return true; // FTS-only mode
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
           scope TEXT PRIMARY KEY, model TEXT, dim INTEGER )`,
      );
      const meta = this.db
        .prepare<[], { model: string; dim: number }>(
          `SELECT model, dim FROM ${META_TABLE} WHERE scope='vec'`,
        )
        .get();
      if (!meta || meta.model !== model || meta.dim !== dim) {
        // Model/dim changed → old vectors can't be compared; rebuild.
        this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
        this.db.exec(
          `CREATE VIRTUAL TABLE ${VEC_TABLE} USING vec0(
             user_id TEXT partition key,
             page_key TEXT,
             embedding float[${dim}] )`,
        );
        this.db
          .prepare(
            `INSERT INTO ${META_TABLE}(scope,model,dim) VALUES('vec',?,?)
             ON CONFLICT(scope) DO UPDATE SET model=excluded.model, dim=excluded.dim`,
          )
          .run(model, dim);
      } else {
        this.db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
             user_id TEXT partition key,
             page_key TEXT,
             embedding float[${dim}] )`,
        );
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Upsert one page: replace its FTS row always, and its vector when a
   *  vector is provided + vec is available. */
  upsert(pageKey: string, text: string, vector?: number[], dim?: number): void {
    if (this.ftsReady()) {
      this.db
        .prepare(`DELETE FROM ${FTS_TABLE} WHERE user_id=? AND page_key=?`)
        .run(this.userId, pageKey);
      this.db
        .prepare(`INSERT INTO ${FTS_TABLE}(user_id,page_key,body) VALUES(?,?,?)`)
        .run(this.userId, pageKey, text);
    }
    if (vector && this.vecAvailable && dim) {
      this.db
        .prepare(`DELETE FROM ${VEC_TABLE} WHERE user_id=? AND page_key=?`)
        .run(this.userId, pageKey);
      this.db
        .prepare(
          `INSERT INTO ${VEC_TABLE}(user_id,page_key,embedding) VALUES(?,?,?)`,
        )
        .run(this.userId, pageKey, f32blob(vector));
    }
  }

  /** Vector KNN for the current user. */
  private vectorHits(qvec: number[], k: number): SemanticHit[] {
    if (!this.vecAvailable) return [];
    try {
      const rows = this.db
        .prepare<[string, Buffer, number], { page_key: string; distance: number }>(
          `SELECT page_key, distance FROM ${VEC_TABLE}
             WHERE user_id=? AND embedding MATCH ? AND k=?
             ORDER BY distance`,
        )
        .all(this.userId, f32blob(qvec), k);
      // closer distance → higher score (informational only; RRF uses rank).
      return rows.map((r) => ({ path: r.page_key, score: 1 / (1 + r.distance) }));
    } catch {
      return [];
    }
  }

  /** FTS5 BM25 keyword hits for the current user. */
  ftsHits(query: string, k: number): SemanticHit[] {
    try {
      const match = toFtsQuery(query);
      if (!match) return [];
      const rows = this.db
        .prepare<[string, string, number], { page_key: string; s: number }>(
          `SELECT page_key, bm25(${FTS_TABLE}) AS s FROM ${FTS_TABLE}
             WHERE ${FTS_TABLE} MATCH ? AND user_id=?
             ORDER BY s LIMIT ?`,
        )
        .all(match, this.userId, k);
      return rows.map((r) => ({ path: r.page_key, score: -r.s }));
    } catch {
      return [];
    }
  }

  removePage(pageKey: string): void {
    try {
      this.db
        .prepare(`DELETE FROM ${FTS_TABLE} WHERE user_id=? AND page_key=?`)
        .run(this.userId, pageKey);
      if (this.vecAvailable) {
        this.db
          .prepare(`DELETE FROM ${VEC_TABLE} WHERE user_id=? AND page_key=?`)
          .run(this.userId, pageKey);
      }
    } catch {
      /* best-effort */
    }
  }

  /** Wipe this user's rows from both tables (used by reset/reindex). */
  clear(): void {
    try {
      this.db.prepare(`DELETE FROM ${FTS_TABLE} WHERE user_id=?`).run(this.userId);
    } catch {
      /* table may not exist yet */
    }
    try {
      this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE user_id=?`).run(this.userId);
    } catch {
      /* table may not exist yet */
    }
  }

  count(): number {
    try {
      const r = this.db
        .prepare<[string], { n: number }>(
          `SELECT COUNT(*) AS n FROM ${FTS_TABLE} WHERE user_id=?`,
        )
        .get(this.userId);
      return r?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Hybrid search: vector KNN ⊕ FTS5 BM25, fused with RRF. */
  fuse(qvec: number[] | undefined, query: string, limit: number): SemanticHit[] {
    const pool = Math.max(limit * 4, 20);
    const vec = qvec ? this.vectorHits(qvec, pool) : [];
    const fts = this.ftsHits(query, pool);
    return rrf([vec, fts], limit);
  }
}

/** Reciprocal Rank Fusion over several ranked lists (each already
 *  sorted best-first). Robust to the two lists having incomparable
 *  raw scores — fusion is on RANK, not score. */
function rrf(lists: SemanticHit[][], limit: number): SemanticHit[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      acc.set(hit.path, (acc.get(hit.path) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...acc.entries()]
    .map(([path, score]) => ({ path, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Turn a free-text query into a safe FTS5 MATCH expression: keep word
 *  tokens as prefix terms, OR-joined. Strips FTS5 operators/punctuation
 *  so a natural-language query can't throw a syntax error. */
function toFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/["'\-*^:(){}\[\].,!?]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 12);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"*`).join(" OR ");
}

// ─── public API used by server.ts ───────────────────────────────────

/** Upsert one page's vector + FTS row. Best-effort; a failure (endpoint
 *  down, bad config) is returned (not thrown) so recording never breaks
 *  — the page is still written, just not yet searchable. */
export async function indexPage(
  index: WikiIndex,
  cfg: EmbeddingConfig,
  pagePath: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string }> {
  if (!embeddingEnabled(cfg)) return { ok: false, reason: "no embedding model" };
  const clipped = text.slice(0, 8000);
  try {
    const [vector] = await embed(cfg, [clipped], signal);
    if (!vector) return { ok: false, reason: "no vector returned" };
    if (!index.prepare(cfg.model!, vector.length)) {
      return { ok: false, reason: "index schema setup failed" };
    }
    index.upsert(pagePath, clipped, vector, vector.length);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Rebuild the WHOLE index from scratch: clear this user's rows, then
 *  embed every provided page. Used by the panel's "Rebuild index"
 *  button. Embeds sequentially (gentle on rate limits); stops on the
 *  FIRST failure and reports it. */
export async function reindexAll(
  index: WikiIndex,
  cfg: EmbeddingConfig,
  pages: Array<{ path: string; text: string }>,
  signal?: AbortSignal,
): Promise<{ ok: boolean; indexed: number; total: number; reason?: string }> {
  if (!embeddingEnabled(cfg)) {
    return { ok: false, indexed: 0, total: pages.length, reason: "no embedding model configured" };
  }
  index.clear();
  let indexed = 0;
  for (const p of pages) {
    const r = await indexPage(index, cfg, p.path, p.text, signal);
    if (!r.ok) {
      return { ok: false, indexed, total: pages.length, reason: r.reason };
    }
    indexed++;
  }
  return { ok: true, indexed, total: pages.length };
}

/** Hybrid semantic+keyword search (RRF). Embeds the query, runs vector
 *  KNN ⊕ FTS5, fuses. `minScore` filters weak fused matches. */
export async function semanticSearch(
  index: WikiIndex,
  cfg: EmbeddingConfig | undefined,
  query: string,
  limit: number,
  minScore: number,
  signal?: AbortSignal,
): Promise<SemanticOutcome> {
  if (!embeddingEnabled(cfg)) return { status: "disabled" };
  if (index.count() === 0) return { status: "empty" };
  try {
    const [qv] = await embed(cfg, [query], signal);
    if (!qv) return { status: "error", reason: "no query vector returned" };
    const hits = index.fuse(qv, query, limit).filter((h) => h.score >= minScore);
    return { status: "ok", hits };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}
