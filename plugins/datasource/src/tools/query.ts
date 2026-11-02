import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import { toonRows } from "@tianshu-ai/plugin-sdk";
import { getDriver } from "../connection-pool.js";
import path from "node:path";
import fs from "node:fs";

const MAX_ROWS = 200;
const MAX_EXPORT_ROWS = 50_000;

export const DsQueryTool: AgentTool = {
  schema: {
    name: "ds_query",
    description:
      "Execute a read-only query against a data source. " +
      "Use SQL for MySQL, Cypher for Neo4j, HTTP method + path for REST (e.g. 'GET /users?limit=10'). Returns up to 200 rows. " +
      "Call ds_list first to see available sources.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Data source name (from ds_list)" },
        query: { type: "string", description: "Query string (SQL for MySQL, Cypher for Neo4j)" },
        params: {
          type: "object",
          description: "Query parameters. MySQL: {:name} style. Neo4j: {$name} style. REST: JSON body for POST/PUT/PATCH, query string for GET/DELETE.",
          additionalProperties: true,
        },
        filename: {
          type: "string",
          description: "If provided, export results to a CSV file in workspace/exports/ instead of returning data in context. Saves tokens for large results. E.g. 'sales-report.csv'.",
        },
        headers: {
          type: "object",
          description: "Extra HTTP headers for this request (REST only). Merged with connection-level headers.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["source", "query"],
    },
  },

  async execute(args: Record<string, unknown>, ctx: AgentToolContext, signal?: AbortSignal) {
    const source = String(args.source ?? "");
    const query = String(args.query ?? "");
    if (!source || !query) {
      return { content: [{ type: "text", text: "source and query are required" }], isError: true };
    }
    try {
      const driver = await getDriver(ctx.tenantId, source);
      const hdrs = args.headers && typeof args.headers === "object" ? args.headers as Record<string, string> : undefined;
      const filename = typeof args.filename === "string" ? args.filename.trim() : "";
      const limit = filename ? MAX_EXPORT_ROWS : MAX_ROWS;
      const result = await driver.query(query, (args.params ?? {}) as Record<string, unknown>, hdrs, signal);
      const rows = result.rows.slice(0, limit);

      // Export to CSV file
      if (filename) {
        if (rows.length === 0) {
          return { content: [{ type: "text", text: "Query returned no results — nothing to export." }] };
        }
        const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, "_");
        const csvName = safeName.endsWith(".csv") ? safeName : safeName + ".csv";
        const exportDir = path.join(ctx.userHomeDir, "exports");
        fs.mkdirSync(exportDir, { recursive: true });
        const filePath = path.join(exportDir, csvName);
        const columns = result.columns;
        const lines: string[] = [columns.map(escapeCsv).join(",")];
        for (const row of rows) {
          lines.push(columns.map((c) => escapeCsv(toCsvValue(row[c]))).join(","));
        }
        fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
        const rel = `exports/${csvName}`;
        const truncated = result.rowCount > MAX_EXPORT_ROWS;
        const summary = [
          `✅ Exported ${rows.length} row(s), ${columns.length} column(s) to [${rel}](workspace:///${rel})`,
          truncated ? `⚠️ Query returned ${result.rowCount} rows, truncated to ${MAX_EXPORT_ROWS}.` : "",
          `Columns: ${columns.join(", ")}`,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text: summary }] };
      }

      // Return in context
      const text = formatResult(result.columns, rows, result.rowCount);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Query error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
};

function formatResult(columns: string[], rows: Record<string, unknown>[], totalCount: number): string {
  if (rows.length === 0) return "No results.";
  if (columns.length <= 8 && rows.length <= 50) {
    const header = `| ${columns.join(" | ")} |`;
    const sep = `| ${columns.map(() => "---").join(" | ")} |`;
    const body = rows.map((r) =>
      `| ${columns.map((k) => formatCell(r[k])).join(" | ")} |`
    );
    return [`${totalCount} row(s)`, "", header, sep, ...body].join("\n");
  }
  return `${totalCount} row(s)\n\n` + toonRows(rows, columns);
}

/** Compact cell rendering — avoids JSON quotes/braces to save tokens. */
function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(formatCell).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${k}:${formatCell(val)}`)
      .join(", ");
  }
  return String(v);
}

function escapeCsv(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(toCsvValue).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
