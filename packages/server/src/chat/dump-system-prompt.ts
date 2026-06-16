// Optional dump of the assembled system prompt for debugging.
//
// Off by default. Enabled by setting
//   `logging.dumpSystemPrompt: true`
// in the global config (NOT tenant config — see config.ts comment).
// When on, every assembled prompt is overwritten to
//   <tenantHomeDir>/logs/system-prompt-<role>-<userId>.txt
// at the moment we hand it to the harness.
//
// This is the simplest possible "what does the agent actually see"
// inspector. It exists because pi-ai itself doesn't expose a
// post-render system-prompt hook, and we keep regretting having to
// stand up tracing every time someone asks "wait, did the
// `prefer-delegation` fragment make it into the worker prompt?".
//
// Failure mode: silent. If the dump write fails (read-only fs,
// disk full, race), we log a warning to stderr and let the agent
// continue. Whatever's wrong with the disk shouldn't block real
// work.

import * as fs from "node:fs";
import * as path from "node:path";

import type { TenantContext } from "../core/index.js";

export interface DumpSystemPromptArgs {
  ctx: TenantContext;
  /** "main" for the chat handler, or "worker:<slug>" for a worker
   *  agent. Used in the filename so concurrent agents don't
   *  trample each other. */
  role: string;
  userId: string;
  systemPrompt: string;
}

/** Returns true iff the dump is enabled in this tenant's resolved
 *  config. Cheap to call per-turn. */
export function dumpSystemPromptEnabled(ctx: TenantContext): boolean {
  return ctx.config.logging?.dumpSystemPrompt === true;
}

/** Overwrite the dump file for this (tenant, role, user). Best
 *  effort — never throws. */
export function dumpSystemPrompt(args: DumpSystemPromptArgs): void {
  if (!dumpSystemPromptEnabled(args.ctx)) return;
  try {
    const dir = args.ctx.logsDir;
    fs.mkdirSync(dir, { recursive: true });
    // Sanitise role + userId for the filename. We keep alphanum,
    // dash, underscore, colon (the worker:<slug> separator), and
    // dot — anything else becomes `_`. The full unsanitised pair
    // is also included as a header inside the file so a human
    // reading the dump still knows which agent it was.
    const safeRole = sanitise(args.role);
    const safeUser = sanitise(args.userId);
    const file = path.join(
      dir,
      `system-prompt-${safeRole}-${safeUser}.txt`,
    );
    const header =
      `# tenant=${args.ctx.tenantId} role=${args.role} user=${args.userId}\n` +
      `# written-at=${new Date().toISOString()}\n` +
      `# bytes=${Buffer.byteLength(args.systemPrompt, "utf8")}\n` +
      `# ----- begin prompt -----\n`;
    fs.writeFileSync(file, header + args.systemPrompt + "\n");
  } catch (err) {
    // Best-effort: don't break the agent if dumping fails.
    // eslint-disable-next-line no-console
    console.warn(
      `[dump-system-prompt] write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function sanitise(s: string): string {
  return s.replace(/[^A-Za-z0-9._:-]/gu, "_");
}
