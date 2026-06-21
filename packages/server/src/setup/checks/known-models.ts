// Parser for docs/known-models.md.
//
// We keep the source-of-truth as a human-readable markdown file so
// it's reviewable in PRs and useful to users even when reading it
// out of context. doctor calls into here to surface "your catalog
// has X but the table records Y" suggestions; the cli-agent reads
// the same file when seeding new catalog entries.
//
// Format expected per provider section:
//
//   ## <free-form heading>
//
//   | model id | ctx | max | lastVerified | source | note |
//   | --- | ---:| ---:| --- | --- | --- |
//   | `<id>` | NN | NN | YYYY-MM-DD | <url> | ... |
//
// We tolerate variations:
//   - Numbers may use `_` separators (`131_072`)
//   - Model id may be wrapped in backticks
//   - Section headings can be anything; we don't tie to provider id
//   - Extra columns are ignored
//
// We do NOT tie rows to provider keys (the user's `providers.qwen`
// can map to whatever model_id they want). Match is purely on the
// model id string — same string the user wrote in their catalog
// under `models.providers.<provId>.models[].id`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface KnownModelEntry {
  modelId: string;
  contextWindow: number;
  maxTokens: number;
  lastVerified: string;
  source: string;
  note?: string;
}

let cache: Map<string, KnownModelEntry> | null = null;

/**
 * Find docs/known-models.md relative to this module's runtime
 * location. We walk up from `dist/setup/checks/` (where this lands
 * in the built tree) to the repo root, then into `docs/`. Fail
 * silently — callers treat an empty table as "no opinion".
 */
function findKnownModelsFile(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "docs", "known-models.md");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface LoadOpts {
  /** Override path (test seam). */
  path?: string;
  /** Force-reload past the in-memory cache. */
  reload?: boolean;
}

export function loadKnownModels(opts: LoadOpts = {}): Map<string, KnownModelEntry> {
  if (cache && !opts.reload && !opts.path) return cache;
  const filepath = opts.path ?? findKnownModelsFile();
  const table = new Map<string, KnownModelEntry>();
  if (!filepath || !fs.existsSync(filepath)) {
    if (!opts.path) cache = table;
    return table;
  }
  let body: string;
  try {
    body = fs.readFileSync(filepath, "utf8");
  } catch {
    if (!opts.path) cache = table;
    return table;
  }
  for (const line of body.split(/\r?\n/)) {
    // Skip non-table lines (headers, separators, prose).
    if (!line.startsWith("|")) continue;
    if (line.match(/^\|\s*-/)) continue; // separator row
    const cells = line.split("|").map((c) => c.trim());
    // First and last cells are empty (leading/trailing `|`).
    // We expect at least 7 cells: ["", id, ctx, max, date, source, note?, ...]
    if (cells.length < 6) continue;
    const id = stripBackticks(cells[1] ?? "");
    if (!id || id === "model id") continue; // header row
    const ctx = parseTokens(cells[2] ?? "");
    const max = parseTokens(cells[3] ?? "");
    if (ctx === null || max === null) continue;
    const lastVerified = (cells[4] ?? "").trim();
    const source = (cells[5] ?? "").trim();
    const note = (cells[6] ?? "").trim() || undefined;
    table.set(id, {
      modelId: id,
      contextWindow: ctx,
      maxTokens: max,
      lastVerified,
      source,
      note,
    });
  }
  if (!opts.path) cache = table;
  return table;
}

function stripBackticks(s: string): string {
  return s.replace(/^`+|`+$/g, "").trim();
}

/** Parse `131_072`, `131072`, `131,072` → 131072. Returns null on failure. */
function parseTokens(s: string): number | null {
  const cleaned = s.replace(/[_,\s]/g, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number.parseInt(cleaned, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Test seam: drop the in-memory cache. */
export function _resetKnownModelsCache(): void {
  cache = null;
}
