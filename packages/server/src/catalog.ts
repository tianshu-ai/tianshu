// Plugin Catalog client.
//
// Fetches the JSON catalog from a remote URL (default
// `tianshu-ai/plugin-registry`'s `main` branch) and validates the
// shape against the schema agreed in that repo's `schema.json`.
//
// v1 is intentionally minimal:
//   - GET only, no install yet (P2 will add /install)
//   - in-memory cache, refresh on TTL or explicit POST refresh
//   - 1 MB hard cap on the catalog body
//
// We do NOT trust the remote: every required field is type-checked
// before being handed to the API surface. Anything malformed is
// dropped from the response with an `entriesDropped` count surfaced
// to the client so the Plugin Manager UI can warn the user.

const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/tianshu-ai/plugin-registry/main/catalog.json";

const MAX_BODY_BYTES = 1_048_576; // 1 MB
const FETCH_TIMEOUT_MS = 10_000;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

export interface CatalogEntry {
  id: string;
  displayName: string;
  description: string;
  author: string;
  verified: boolean;
  repository: string;
  homepage?: string;
  license?: string;
  tags: string[];
  latestVersion: string;
  tarballUrl: string;
  tarballSha256: string;
  tarballSize?: number;
  tianshuRange: string;
}

export interface CatalogSnapshot {
  /** Source URL the snapshot was loaded from. */
  source: string;
  /** ISO timestamp when the host fetched the catalog (server clock). */
  fetchedAt: string;
  /** ISO timestamp the catalog itself reports it was last updated. */
  catalogUpdatedAt: string | null;
  /** Validated, ready-to-use entries. */
  entries: CatalogEntry[];
  /** Count of entries dropped because they failed schema checks. */
  entriesDropped: number;
}

export interface CatalogClientOpts {
  url?: string;
  ttlMs?: number;
  fetcher?: typeof fetch;
}

export class CatalogClient {
  private readonly url: string;
  private readonly ttlMs: number;
  private readonly fetcher: typeof fetch;
  private cache: { snapshot: CatalogSnapshot; expiresAt: number } | null = null;
  private inflight: Promise<CatalogSnapshot> | null = null;

  constructor(opts: CatalogClientOpts = {}) {
    this.url = opts.url ?? process.env.TIANSHU_CATALOG_URL ?? DEFAULT_CATALOG_URL;
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.fetcher = opts.fetcher ?? fetch;
  }

  /**
   * Returns the cached snapshot if still fresh; otherwise re-fetches.
   * Concurrent calls share the same in-flight promise.
   */
  async get(opts: { force?: boolean } = {}): Promise<CatalogSnapshot> {
    const now = Date.now();
    if (!opts.force && this.cache && this.cache.expiresAt > now) {
      return this.cache.snapshot;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchAndCache().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Discard the in-memory snapshot, forcing the next get() to re-fetch. */
  invalidate(): void {
    this.cache = null;
  }

  private async fetchAndCache(): Promise<CatalogSnapshot> {
    const fetchedAt = new Date().toISOString();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    let body: string;
    try {
      const r = await this.fetcher(this.url, {
        signal: ac.signal,
        headers: { accept: "application/json" },
      });
      if (!r.ok) {
        throw new Error(`catalog fetch ${this.url} → ${r.status}`);
      }
      const cl = Number.parseInt(r.headers.get("content-length") ?? "0", 10);
      if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
        throw new Error(`catalog body too large: declared ${cl} bytes`);
      }
      body = await r.text();
      if (body.length > MAX_BODY_BYTES) {
        throw new Error(`catalog body too large: ${body.length} bytes`);
      }
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      throw new Error(`catalog body is not valid JSON: ${describe(err)}`);
    }

    const snapshot = validateCatalog(parsed, this.url, fetchedAt);
    this.cache = { snapshot, expiresAt: Date.now() + this.ttlMs };
    return snapshot;
  }
}

function validateCatalog(raw: unknown, source: string, fetchedAt: string): CatalogSnapshot {
  if (!isObject(raw)) {
    throw new Error("catalog root is not an object");
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`unsupported catalog schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (!Array.isArray(raw.plugins)) {
    throw new Error("catalog.plugins is not an array");
  }

  const seenIds = new Set<string>();
  const entries: CatalogEntry[] = [];
  let dropped = 0;

  for (const item of raw.plugins) {
    const e = normaliseEntry(item);
    if (!e) {
      dropped++;
      continue;
    }
    if (seenIds.has(e.id)) {
      dropped++;
      continue;
    }
    seenIds.add(e.id);
    entries.push(e);
  }

  return {
    source,
    fetchedAt,
    catalogUpdatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    entries,
    entriesDropped: dropped,
  };
}

function normaliseEntry(raw: unknown): CatalogEntry | null {
  if (!isObject(raw)) return null;
  const {
    id,
    displayName,
    description,
    author,
    verified,
    repository,
    homepage,
    license,
    tags,
    latestVersion,
    tarballUrl,
    tarballSha256,
    tarballSize,
    tianshuRange,
  } = raw;

  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  if (!nonEmptyString(displayName) || displayName.length > 80) return null;
  if (!nonEmptyString(description) || description.length > 500) return null;
  if (!nonEmptyString(author)) return null;
  if (!isHttpUrl(repository)) return null;
  if (!nonEmptyString(latestVersion)) return null;
  if (!isHttpUrl(tarballUrl)) return null;
  if (typeof tarballSha256 !== "string" || !SHA256_RE.test(tarballSha256)) return null;
  if (!nonEmptyString(tianshuRange)) return null;

  const cleanedTags: string[] = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (typeof t === "string" && t.length > 0 && t.length <= 32 && cleanedTags.length < 10) {
        cleanedTags.push(t);
      }
    }
  }

  return {
    id,
    displayName,
    description,
    author,
    verified: verified === true,
    repository,
    homepage: typeof homepage === "string" && isHttpUrl(homepage) ? homepage : undefined,
    license: nonEmptyString(license) ? license : undefined,
    tags: cleanedTags,
    latestVersion,
    tarballUrl,
    tarballSha256,
    tarballSize:
      typeof tarballSize === "number" && Number.isInteger(tarballSize) && tarballSize > 0
        ? tarballSize
        : undefined,
    tianshuRange,
  };
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

function isHttpUrl(x: unknown): x is string {
  if (typeof x !== "string") return false;
  return x.startsWith("https://") || x.startsWith("http://");
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
