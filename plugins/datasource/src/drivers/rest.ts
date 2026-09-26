// REST API driver — treats any HTTP endpoint as a data source.

import type { DataSourceDriver, QueryResult, ExecuteResult, SchemaInfo } from "./interface.js";

interface RestConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  timeout?: number; // ms, default 30000
}

interface OAuthConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}

interface OAuthToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

/**
 * Query string format:
 *   "GET /path?key=val"          → GET  baseUrl/path?key=val
 *   "/path"                      → GET  baseUrl/path  (GET is default)
 *   "POST /path"                 → POST baseUrl/path  (body from params)
 *   "PUT /path"                  → PUT  baseUrl/path
 *   "PATCH /path"                → PATCH baseUrl/path
 *   "DELETE /path"               → DELETE baseUrl/path
 *
 * `params` is sent as JSON body for POST/PUT/PATCH, or as extra
 * query-string entries for GET/DELETE.
 */

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function parseQuery(raw: string): { method: string; path: string } {
  const trimmed = raw.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx > 0) {
    const maybeMethod = trimmed.slice(0, spaceIdx).toUpperCase();
    if (METHODS.has(maybeMethod)) {
      return { method: maybeMethod, path: trimmed.slice(spaceIdx + 1).trim() };
    }
  }
  // No method prefix → default GET
  return { method: "GET", path: trimmed };
}

function buildUrl(base: string, path: string, queryParams?: Record<string, unknown>): string {
  // Strip trailing slash from base, leading slash from path to avoid double-slash
  const clean = base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
  const url = new URL(clean);
  if (queryParams) {
    for (const [k, v] of Object.entries(queryParams)) {
      if (v !== undefined && v !== null) url.searchParams.append(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Flatten a nested object into dot-notation keys.
 * { user: { name: "Yu", tags: [1,2] } }
 * → { "user.name": "Yu", "user.tags": [1,2] }
 *
 * Arrays are kept as-is (not further expanded into user.tags.0).
 * Max depth 4 to avoid runaway recursion on deep/circular structures.
 */
function flattenObj(
  obj: Record<string, unknown>,
  prefix = "",
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      depth < 4
    ) {
      Object.assign(out, flattenObj(v as Record<string, unknown>, key, depth + 1));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function flattenToRows(data: unknown): { columns: string[]; rows: Record<string, unknown>[] } {
  // If data is an array of objects → flatten each row then collect columns
  if (Array.isArray(data)) {
    if (data.length === 0) return { columns: [], rows: [] };
    if (typeof data[0] === "object" && data[0] !== null) {
      const flat = data.map((r) =>
        typeof r === "object" && r !== null && !Array.isArray(r)
          ? flattenObj(r as Record<string, unknown>)
          : { value: r },
      );
      const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
      return { columns, rows: flat };
    }
    // Array of primitives
    return { columns: ["value"], rows: data.map((v) => ({ value: v })) };
  }

  // If data is an object with a nested array (common pattern: { data: [...], results: [...] })
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of ["data", "results", "items", "records", "rows", "list", "entries"]) {
      if (Array.isArray(obj[key])) {
        return flattenToRows(obj[key]);
      }
    }
    // Single object → flatten then one-row table
    const flat = flattenObj(obj);
    return { columns: Object.keys(flat), rows: [flat] };
  }

  // Scalar
  return { columns: ["value"], rows: [{ value: data }] };
}

export class RestDriver implements DataSourceDriver {
  type = "rest";
  private cfg: RestConfig;
  private timeout: number;
  private oauth: OAuthConfig | null = null;
  private cachedToken: OAuthToken | null = null;

  constructor(raw: Record<string, unknown>) {
    const headers: Record<string, string> = {};
    const authType = String(raw.authType ?? "none");

    switch (authType) {
      case "bearer": {
        const token = String(raw.token ?? "").trim();
        if (token) headers["Authorization"] = `Bearer ${token}`;
        break;
      }
      case "apikey": {
        const name = String(raw.apiKeyName ?? "X-API-Key").trim();
        const value = String(raw.apiKeyValue ?? "").trim();
        if (name && value) headers[name] = value;
        break;
      }
      case "basic": {
        const user = String(raw.username ?? "");
        const pass = String(raw.password ?? "");
        if (user) {
          const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
          headers["Authorization"] = `Basic ${encoded}`;
        }
        break;
      }
      case "custom": {
        // Custom headers: JSON string or object
        if (typeof raw.headers === "string" && raw.headers.trim()) {
          try {
            const parsed = JSON.parse(raw.headers);
            if (typeof parsed === "object" && parsed !== null) {
              Object.assign(headers, parsed);
            }
          } catch { /* invalid JSON — skip */ }
        } else if (typeof raw.headers === "object" && raw.headers !== null) {
          Object.assign(headers, raw.headers);
        }
        break;
      }
      case "oauth2": {
        // OAuth2 Client Credentials — token fetched lazily
        const tokenUrl = String(raw.tokenUrl ?? "").trim();
        const clientId = String(raw.clientId ?? "").trim();
        const clientSecret = String(raw.clientSecret ?? "").trim();
        if (tokenUrl && clientId && clientSecret) {
          this.oauth = {
            tokenUrl,
            clientId,
            clientSecret,
            scope: raw.scope ? String(raw.scope).trim() : undefined,
          };
        }
        break;
      }
      // "none" — no auth headers
    }

    this.cfg = {
      baseUrl: String(raw.baseUrl ?? ""),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      timeout: raw.timeout ? Number(raw.timeout) : undefined,
    };
    this.timeout = this.cfg.timeout ?? 30_000;
  }

  /** Fetch or reuse a cached OAuth2 access token. */
  private async getOAuthToken(): Promise<string> {
    if (!this.oauth) throw new Error("OAuth2 not configured");
    // Reuse cached token if still valid (with 30s margin)
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 30_000) {
      return this.cachedToken.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.oauth.clientId,
      client_secret: this.oauth.clientSecret,
    });
    if (this.oauth.scope) body.set("scope", this.oauth.scope);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    const res = await fetch(this.oauth.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OAuth2 token request failed: HTTP ${res.status}${text ? " " + text.slice(0, 300) : ""}`);
    }
    const data = await res.json() as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new Error("OAuth2 response missing access_token");

    const expiresIn = data.expires_in ?? 3600; // default 1h
    this.cachedToken = {
      accessToken: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    return this.cachedToken.accessToken;
  }

  /** Build effective headers, injecting OAuth2 Bearer token if needed. */
  private async effectiveHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...this.cfg.headers, ...extra };
    if (this.oauth) {
      const token = await this.getOAuthToken();
      h["Authorization"] = `Bearer ${token}`;
    }
    return h;
  }

  async ping(): Promise<string | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      const headers = await this.effectiveHeaders();
      const res = await fetch(this.cfg.baseUrl, {
        method: "HEAD",
        headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return `HTTP ${res.status} ${res.statusText}`;
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async query(raw: string, params?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<QueryResult> {
    const { method, path } = parseQuery(raw);
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    const url = buildUrl(
      this.cfg.baseUrl,
      path,
      !hasBody ? params : undefined,
    );

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    const headers = await this.effectiveHeaders({
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    });
    const res = await fetch(url, {
      method,
      headers,
      ...(hasBody && params ? { body: JSON.stringify(params) } : {}),
      signal: ctrl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ": " + text.slice(0, 500) : ""}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown;
    if (contentType.includes("json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    const { columns, rows } = flattenToRows(data);
    return { columns, rows, rowCount: rows.length };
  }

  async execute(raw: string, params?: Record<string, unknown>, extraHeaders?: Record<string, string>): Promise<ExecuteResult> {
    // For REST, execute and query are effectively the same — the distinction
    // is semantic (write vs read). We call query() and summarise.
    const result = await this.query(raw, params, extraHeaders);
    return {
      affectedRows: result.rowCount,
      details: `${result.rowCount} row(s) returned`,
    };
  }

  async schema(): Promise<SchemaInfo> {
    // REST APIs don't have a universal schema. Return connection info.
    const lines = [
      `## REST API: ${this.cfg.baseUrl}`,
      "",
      "This is a REST API data source. Use the query tool with HTTP method + path:",
      "",
      "```",
      'ds_query(source, "GET /endpoint?param=value")',
      'ds_query(source, "POST /endpoint", { key: "value" })',
      "```",
      "",
      "Methods: GET (default), POST, PUT, PATCH, DELETE",
      "Params: query string for GET/DELETE, JSON body for POST/PUT/PATCH",
    ];
    if (this.cfg.headers) {
      const headerNames = Object.keys(this.cfg.headers).filter(
        (h) => !h.toLowerCase().includes("auth") && !h.toLowerCase().includes("token"),
      );
      if (headerNames.length > 0) {
        lines.push("", `Configured headers: ${headerNames.join(", ")}`);
      }
    }
    return { text: lines.join("\n") };
  }

  async close(): Promise<void> {
    // HTTP is stateless — nothing to close.
  }
}
