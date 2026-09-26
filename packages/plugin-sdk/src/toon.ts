/**
 * TOON — Token-Optimised Object Notation.
 *
 * Compact human/LLM-readable serialisation that drops JSON's quotes,
 * braces, and brackets. Designed for agent tool results where the
 * consumer is an LLM, not a JSON parser.
 *
 *   toon({ id: 1, user: { name: "Yu" }, tags: [1,2] })
 *   → "id:1, user.name:Yu, tags:1, 2"
 *
 * Rules:
 *  - Plain objects → "key:value" pairs, comma-separated.
 *  - Nested objects → dot-notation keys (user.name:Yu).
 *  - Arrays → comma-separated values (no brackets).
 *  - Strings without commas/colons → unquoted.
 *  - Strings with commas/colons → double-quoted.
 *  - null/undefined → empty string.
 *  - Max depth 4 to prevent runaway recursion.
 */

const NEEDS_QUOTE = /[,:\n]/;

function formatValue(v: unknown, depth: number): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((item) => formatValue(item, depth)).join(", ");
  if (typeof v === "object") return toonPairs(v as Record<string, unknown>, "", depth);
  const s = String(v);
  return NEEDS_QUOTE.test(s) ? `"${s}"` : s;
}

function toonPairs(obj: Record<string, unknown>, prefix: string, depth: number): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && depth < 4) {
      parts.push(toonPairs(v as Record<string, unknown>, key, depth + 1));
    } else {
      parts.push(`${key}:${formatValue(v, depth + 1)}`);
    }
  }
  return parts.join(", ");
}

/**
 * Convert any value to TOON string for tool result text.
 *
 * For arrays of objects (table-like data), use `toonRows()` which
 * produces a more readable multi-line format.
 */
export function toon(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (Array.isArray(data)) {
    if (data.length === 0) return "[]";
    if (typeof data[0] === "object" && data[0] !== null) {
      // Array of objects → one line per item
      return data.map((item) => toon(item)).join("\n");
    }
    return data.map((item) => formatValue(item, 0)).join(", ");
  }
  if (typeof data === "object") {
    return toonPairs(data as Record<string, unknown>, "", 0);
  }
  return String(data);
}

/**
 * Format an array of objects as a compact multi-line table.
 * First line is column headers, rest are values.
 * Falls back to toon() for non-tabular data.
 *
 *   toonRows([{ name: "a", score: 1 }, { name: "b", score: 2 }])
 *   → "name | score\na | 1\nb | 2"
 */
export function toonRows(rows: unknown[], columns?: string[]): string {
  if (rows.length === 0) return "(empty)";
  if (typeof rows[0] !== "object" || rows[0] === null) return toon(rows);
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r as object)))];
  const header = cols.join(" | ");
  const body = rows.map((r) => {
    const obj = r as Record<string, unknown>;
    return cols.map((c) => formatValue(obj[c], 0)).join(" | ");
  });
  return [header, ...body].join("\n");
}
