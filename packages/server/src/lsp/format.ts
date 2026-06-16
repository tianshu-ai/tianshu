// Format a list of LSP diagnostics into a human-readable block
// suitable for appending to an edit_file / write_file tool result.
//
// The shape mirrors what OpenCode emits in its tool output:
//
//   LSP errors detected in this file, please fix:
//   ERROR [12:5] TS2322: Type 'string' is not assignable to type 'number'.
//   WARN  [13:1] TS6133: 'foo' is declared but its value is never read.
//
// The model is supposed to read this and act on it on the next
// turn. Empty diagnostics => empty output (caller should skip
// the block entirely).

import type { Diagnostic } from "vscode-languageserver-types";

const SEVERITY: Record<number, string> = {
  1: "ERROR",
  2: "WARN ",
  3: "INFO ",
  4: "HINT ",
};

export interface FormatOptions {
  /** Skip warnings, info, hint — only ERROR. False by default
   *  (the model benefits from seeing warnings too, especially
   *  unused-variable hints right after an edit). */
  errorsOnly?: boolean;
  /** Cap on how many entries to list. We want the model to fix
   *  the most important things, not drown in 200 deprecations
   *  in a stale file. */
  maxEntries?: number;
}

const DEFAULT_MAX = 20;

export function formatDiagnostics(
  diags: readonly Diagnostic[],
  opts: FormatOptions = {},
): string {
  const filtered = opts.errorsOnly
    ? diags.filter((d) => (d.severity ?? 1) === 1)
    : diags.slice();
  if (filtered.length === 0) return "";

  // Stable sort: errors before warnings before info, then by line.
  filtered.sort((a, b) => {
    const sa = a.severity ?? 1;
    const sb = b.severity ?? 1;
    if (sa !== sb) return sa - sb;
    return a.range.start.line - b.range.start.line;
  });

  const max = opts.maxEntries ?? DEFAULT_MAX;
  const shown = filtered.slice(0, max);
  const lines = shown.map((d) => {
    const sev = SEVERITY[d.severity ?? 1] ?? "??   ";
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const code = d.code !== undefined ? ` ${d.code}:` : ":";
    const source = d.source ? ` [${d.source}]` : "";
    // Squash newlines in messages so the output stays one-line-
    // per-diagnostic — easier for the model to scan.
    // d.message is `string | MarkupContent` per LSP types; almost
    // every server sends a plain string, but coerce defensively.
    const rawMsg =
      typeof d.message === "string" ? d.message : d.message.value;
    const msg = rawMsg.replace(/\s*\n\s*/g, " ");
    return `${sev} [${line}:${col}]${source}${code} ${msg}`;
  });
  if (filtered.length > max) {
    lines.push(`(... ${filtered.length - max} more)`);
  }
  return lines.join("\n");
}
