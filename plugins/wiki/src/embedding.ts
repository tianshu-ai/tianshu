// Embedding-backed semantic search for the wiki.
//
// When the tenant has configured an embedding model (Settings →
// Models → Embedding), the wiki-worker embeds each page it writes and
// stores the vectors in wiki/.wiki/embeddings.json. wiki_search then
// embeds the query and ranks pages by cosine similarity. With no
// embedding model configured, everything here no-ops and the caller
// falls back to keyword search.
//
// OpenAI-compatible `/embeddings` endpoint — works with OpenAI, and
// local servers (llama.cpp, Ollama, LM Studio) that expose the same
// shape. Zero extra deps: plain fetch.

import fs from "node:fs";
import path from "node:path";
import { wikiRoot } from "./vault.js";

export interface EmbeddingConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  dimensions?: number;
}

export function embeddingEnabled(cfg?: EmbeddingConfig): cfg is EmbeddingConfig {
  return !!cfg && !!cfg.model && !!cfg.baseUrl;
}

interface IndexEntry {
  path: string; // "<section>/<slug>"
  vector: number[];
  /** hash-ish of the text we embedded, to skip re-embedding unchanged pages */
  len: number;
  updatedAt: string;
}

interface IndexFile {
  model: string;
  entries: IndexEntry[];
}

function indexPath(userHome: string): string {
  return path.join(wikiRoot(userHome), ".wiki", "embeddings.json");
}

function readIndex(userHome: string): IndexFile | null {
  try {
    return JSON.parse(fs.readFileSync(indexPath(userHome), "utf8")) as IndexFile;
  } catch {
    return null;
  }
}

function writeIndex(userHome: string, idx: IndexFile): void {
  const file = indexPath(userHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(idx), "utf8");
  fs.renameSync(tmp, file);
}

/** Call the OpenAI-compatible embeddings endpoint for one or more
 *  inputs. Returns one vector per input, or throws. */
export async function embed(
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
    throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[] }> };
  const data = json.data ?? [];
  if (data.length !== inputs.length) {
    throw new Error(`embeddings returned ${data.length} vectors for ${inputs.length} inputs`);
  }
  return data.map((d) => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Upsert one page's embedding into the index. Best-effort; a failure
 *  (endpoint down, bad config) is swallowed so recording never breaks
 *  — the page still gets written, it just won't be semantically
 *  searchable until a later successful embed. */
export async function indexPage(
  userHome: string,
  cfg: EmbeddingConfig,
  pagePath: string,
  text: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string }> {
  if (!embeddingEnabled(cfg)) return { ok: false, reason: "no embedding model" };
  const clipped = text.slice(0, 8000);
  try {
    const [vector] = await embed(cfg, [clipped], signal);
    if (!vector) return { ok: false, reason: "no vector" };
    const idx = readIndex(userHome) ?? { model: cfg.model!, entries: [] };
    // Model changed → the old vectors are incomparable; start fresh.
    if (idx.model !== cfg.model) {
      idx.model = cfg.model!;
      idx.entries = [];
    }
    const entry: IndexEntry = {
      path: pagePath,
      vector,
      len: clipped.length,
      updatedAt: new Date().toISOString(),
    };
    const at = idx.entries.findIndex((e) => e.path === pagePath);
    if (at >= 0) idx.entries[at] = entry;
    else idx.entries.push(entry);
    writeIndex(userHome, idx);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Remove pages from the index that no longer exist (called after a
 *  reset or when pages are pruned). Best-effort. */
export function pruneIndex(userHome: string, keepPaths: Set<string>): void {
  const idx = readIndex(userHome);
  if (!idx) return;
  const before = idx.entries.length;
  idx.entries = idx.entries.filter((e) => keepPaths.has(e.path));
  if (idx.entries.length !== before) writeIndex(userHome, idx);
}

export interface SemanticHit {
  path: string;
  score: number;
}

/** Embed the query and rank indexed pages by cosine similarity.
 *  Returns null when semantic search isn't available (no model, empty
 *  index, or the embed call failed) so the caller can fall back to
 *  keyword search. */
export async function semanticSearch(
  userHome: string,
  cfg: EmbeddingConfig | undefined,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SemanticHit[] | null> {
  if (!embeddingEnabled(cfg)) return null;
  const idx = readIndex(userHome);
  if (!idx || idx.entries.length === 0) return null;
  if (idx.model !== cfg.model) return null; // stale index vs current model
  try {
    const [qv] = await embed(cfg, [query], signal);
    if (!qv) return null;
    const scored = idx.entries
      .map((e) => ({ path: e.path, score: cosine(qv, e.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored;
  } catch {
    return null;
  }
}
