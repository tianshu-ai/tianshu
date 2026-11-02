import type { AgentTool, AgentToolContext } from "@tianshu-ai/plugin-sdk";
import { getDriver } from "../connection-pool.js";
import path from "node:path";
import fs from "node:fs";

const MAX_EXPORT_ROWS = 50_000;

export const DsExportTool: AgentTool = {
  schema: {
    name: "ds_export",
    description:
      "Export query results directly to a CSV file in the workspace. " +
      "Runs the query server-side and streams rows to disk — no data passes through the model context, saving tokens. " +
      "Returns the workspace-relative file path. Use for large result sets or when the user wants a downloadable file. " +
      "Max 50,000 rows.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Data source name (from ds_list)" },
        query: { type: "string", description: "SQL / Cypher / REST query" },
        params: {
          type: "object",
          description: "Query parameters",
          additionalProperties: true,
        },
        filename: {
          type: "string",
          description: "Output filename (e.g. 'sales-report.csv'). Placed under exports/ in workspace. Defaults to export-<timestamp>.csv",
        },
        headers: {
          type: "object",
          description: "Extra HTTP headers (REST only)",
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

    const rawFilename = typeof args.filename === "string" && args.filename.trim()
      ? args.filename.trim()
      : `export-${Date.now()}.csv`;
    // Sanitize: only allow simple filenames, no path traversal
    const safeName = path.basename(rawFilename).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, "_");
    const filename = safeName.endsWith(".csv") ? safeName : safeName + ".csv";

    try {
      const driver = await getDriver(ctx.tenantId, source);
      const hdrs = args.headers && typeof args.headers === "object" ? args.headers as Record<string, string> : undefined;
      const result = await driver.query(query, (args.params ?? {}) as Record<string, unknown>, hdrs, signal);

      const rows = result.rows.slice(0, MAX_EXPORT_ROWS);
      const columns = result.columns;

      if (rows.length === 0) {
        return { content: [{ type: "text", text: "Query returned no results — nothing to export." }] };
      }

      // Build CSV content
      const csvLines: string[] = [];
      csvLines.push(columns.map(escapeCsvField).join(","));
      for (const row of rows) {
        csvLines.push(columns.map((col) => escapeCsvField(formatValue(row[col]))).join(","));
      }
      const csvContent = csvLines.join("\n") + "\n";

      // Write to workspace/exports/
      const exportDir = path.join(ctx.userHomeDir, "exports");
      fs.mkdirSync(exportDir, { recursive: true });
      const filePath = path.join(exportDir, filename);
      fs.writeFileSync(filePath, csvContent, "utf-8");

      const relativePath = `exports/${filename}`;
      const truncated = result.rowCount > MAX_EXPORT_ROWS;
      const summary = [
        `✅ Exported ${rows.length} row(s), ${columns.length} column(s) to [${relativePath}](workspace:///${relativePath})`,
        truncated ? `⚠️ Query returned ${result.rowCount} rows, truncated to ${MAX_EXPORT_ROWS}.` : "",
        `Columns: ${columns.join(", ")}`,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: summary }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Export error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
};

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(formatValue).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
