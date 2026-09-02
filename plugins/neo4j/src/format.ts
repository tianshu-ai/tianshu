// Format Neo4j query results into readable text.

import type { Record as Neo4jRecord, ResultSummary } from "neo4j-driver";
import neo4j from "neo4j-driver";

/** Convert a Neo4j value to a plain JS value for JSON serialization. */
function toPlain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (neo4j.isInt(v)) return (v as { toNumber(): number }).toNumber();
  if (neo4j.isDate(v) || neo4j.isDateTime(v) || neo4j.isTime(v) || neo4j.isLocalDateTime(v) || neo4j.isLocalTime(v)) {
    return (v as { toString(): string }).toString();
  }
  if (neo4j.isDuration(v)) return (v as { toString(): string }).toString();
  if (neo4j.isPoint(v)) {
    const p = v as { x: number; y: number; z?: number };
    return p.z !== undefined ? { x: p.x, y: p.y, z: p.z } : { x: p.x, y: p.y };
  }
  // Node
  if (typeof v === "object" && v !== null && "labels" in v && "properties" in v) {
    const node = v as { labels: string[]; properties: Record<string, unknown> };
    return { _labels: node.labels, ...mapValues(node.properties) };
  }
  // Relationship
  if (typeof v === "object" && v !== null && "type" in v && "properties" in v && "start" in v) {
    const rel = v as { type: string; properties: Record<string, unknown> };
    return { _type: rel.type, ...mapValues(rel.properties) };
  }
  // Path
  if (typeof v === "object" && v !== null && "segments" in v) {
    const path = v as { segments: Array<{ start: unknown; relationship: unknown; end: unknown }> };
    return path.segments.map(s => ({
      start: toPlain(s.start),
      rel: toPlain(s.relationship),
      end: toPlain(s.end),
    }));
  }
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object" && v !== null) return mapValues(v as Record<string, unknown>);
  return v;
}

function mapValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toPlain(v);
  return out;
}

/** Format query result records into a human-readable string. */
export function formatRecords(records: Neo4jRecord[], summary: ResultSummary): string {
  if (records.length === 0) return "No results.";

  const keys = records[0]!.keys as string[];
  const rows = records.map(r => {
    const obj: Record<string, unknown> = {};
    for (const k of keys) obj[k] = toPlain(r.get(k));
    return obj;
  });

  // Compact table for small result sets, JSON for larger.
  if (keys.length <= 6 && rows.length <= 50) {
    const header = `| ${keys.join(" | ")} |`;
    const sep = `| ${keys.map(() => "---").join(" | ")} |`;
    const body = rows.map(r =>
      `| ${keys.map(k => String(r[k] ?? "")).join(" | ")} |`
    );
    return [
      `${rows.length} row(s)`,
      "",
      header,
      sep,
      ...body,
    ].join("\n");
  }

  return `${rows.length} row(s)\n\n` + JSON.stringify(rows, null, 2);
}
