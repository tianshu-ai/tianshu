// Rendering helpers for the doctor + setup CLI commands.
//
// These wrap @clack/prompts' note/log helpers so each check group
// renders consistently across the suite. The doctor and wizard
// surfaces stay free of @clack imports beyond *.intro/outro/cancel
// — this file owns the visual style.

import * as p from "@clack/prompts";

export type CheckSeverity = "ok" | "warning" | "blocker";

export interface CheckLine {
  severity: CheckSeverity;
  /** One-line summary, rendered as the bullet's headline. */
  text: string;
  /** Optional dim sub-line for paths, durations, version numbers. */
  detail?: string;
}

export interface CheckGroup {
  /** Section heading shown in the rendered note (e.g. "Runtime"). */
  title: string;
  lines: CheckLine[];
}

const SYMBOLS: Record<CheckSeverity, string> = {
  ok: "✓",
  warning: "⚠",
  blocker: "✗",
};

/** Render one CheckGroup as a clack note. */
export function renderGroup(group: CheckGroup): void {
  if (group.lines.length === 0) {
    p.note("(nothing to report)", group.title);
    return;
  }
  const body = group.lines
    .map((l) => {
      const head = `${SYMBOLS[l.severity]} ${l.text}`;
      return l.detail ? `${head}\n  ${l.detail}` : head;
    })
    .join("\n");
  p.note(body, group.title);
}

/** Summary helpers used by `tianshu doctor` and the startup hook. */
export interface CheckTally {
  ok: number;
  warning: number;
  blocker: number;
}

export function tallyGroups(groups: readonly CheckGroup[]): CheckTally {
  const tally: CheckTally = { ok: 0, warning: 0, blocker: 0 };
  for (const g of groups) {
    for (const l of g.lines) {
      tally[l.severity] += 1;
    }
  }
  return tally;
}

export function summaryLine(tally: CheckTally): string {
  const parts: string[] = [];
  if (tally.blocker > 0) parts.push(`${tally.blocker} blocker(s)`);
  if (tally.warning > 0) parts.push(`${tally.warning} warning(s)`);
  if (tally.ok > 0) parts.push(`${tally.ok} ok`);
  return parts.length === 0 ? "no checks ran" : parts.join(", ");
}

/** Render the "checks complete" outro line. Tally is appended in
 *  parens so an operator skimming the trailing line of the report
 *  immediately knows whether action is required. */
export function renderOutro(tally: CheckTally, suggestion?: string): void {
  const verdict =
    tally.blocker > 0
      ? "Setup is incomplete"
      : tally.warning > 0
        ? "Setup is usable, with caveats"
        : "Setup looks healthy";
  const lines = [`${verdict} (${summaryLine(tally)}).`];
  if (suggestion) lines.push(suggestion);
  p.outro(lines.join("\n"));
}
