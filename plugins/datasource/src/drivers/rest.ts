// REST API driver — treats any HTTP endpoint as a data source.

import type { DataSourceDriver, QueryResult, ExecuteResult, SchemaInfo } from "./interface.js";

interface RestConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  timeout?: number; // ms, default 30000
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

function flattenToRows(data: unknown): { columns: string[]; rows: Record<string, unknown>[] } {
  // If data is an array of objects → direct table
  if (Array.isArray(data)) {
    if (data.length === 0) return { columns: [], rows: [] };
    if (typeof data[0] === "object" && data[0] !== null) {
      const columns = [...new Set(data.flatMap((r) => Object.keys(r as object)))];
      return {
        columns,
        rows: data.map((r) =>
          typeof r === "object" && r !== null ? (r as Record<string, unknown>) : { value: r },
        ),
      };
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
    // Single object → one-row table
    const columns = Object.keys(obj);
    return { columns, rows: [obj] };
  }

  // Scalar
  return { columns: ["value"], rows: [{ value: data }] };
}

export class RestDriver implements DataSourceDriver {
  type = "rest";
  private cfg: RestConfig;
  private timeout: number;

  constructor(raw: Record<string, unknown>) {
    // headers may arrive as a JSON string from the config form
    let headers: Record<string, string> | undefined;
    if (typeof raw.headers === "string" && raw.headers.trim()) {
      try { headers = JSON.parse(raw.headers); } catch { headers = undefined; }
    } else if (typeof raw.headers === "object" && raw.headers !== null) {
      headers = raw.headers as Record<string, string>;
    }
    this.cfg = {
      baseUrl: String(raw.baseUrl ?? ""),
      headers,
      timeout: raw.timeout ? Number(raw.timeout) : undefined,
    };
    this.timeout = this.cfg.timeout ?? 30_000;
  }

  async ping(): Promise<string | null> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeout);
      const res = await fetch(this.cfg.baseUrl, {
        method: "HEAD",
        headers: this.cfg.headers,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return `HTTP ${res.status} ${res.statusText}`;
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  async query(raw: string, params?: Record<string, unknown>): Promise<QueryResult> {
    const { method, path } = parseQuery(raw);
    const hasBody = method === "POST" || method === "PUT" || method === "PATCH";
    const url = buildUrl(
      this.cfg.baseUrl,
      path,
      !hasBody ? params : undefined,
    );

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    const res = await fetch(url, {
      method,
      headers: {
        ...this.cfg.headers,
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
      },
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

  async execute(raw: string, params?: Record<string, unknown>): Promise<ExecuteResult> {
    // For REST, execute and query are effectively the same — the distinction
    // is semantic (write vs read). We call query() and summarise.
    const result = await this.query(raw, params);
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
