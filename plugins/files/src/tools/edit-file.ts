// edit_file — exact text replacement, in-place, with optional
// batch updates per call.
//
// One call carries an `edits: Edit[]` array; the file is loaded
// once, every edit is applied in order in memory, and the
// composite result is written atomically (temp sibling + rename)
// only if every edit succeeds. Same uniqueness contract as before
// — each `old_text` must appear exactly once at the moment that
// edit runs (so cascading edits where one substring becomes
// non-unique mid-batch are caught and surfaced; the file on disk
// is unchanged in that case).
//
// Why batch: long-form synthesis (HTML reports, multi-section
// markdown) wants to fill several `<!-- TODO -->` placeholders or
// patch several function bodies in one round-trip. The non-batch
// API forced one tool call per patch, multiplying turns and tool
// result tokens.
//
// Backwards compat: a single `{ old_text, new_text }` at the top
// level still works — we re-shape it into `edits: [{...}]` before
// running. Old prompts and existing tests keep passing without
// edits to call sites.
//
// Modelled on OpenClaw / Claude Code's edit tool, where the
// `edits` array is the canonical shape.

import fs from "node:fs";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

interface SingleEdit {
  old_text: string;
  new_text: string;
}

export interface EditFileToolResult {
  ok: boolean;
  text: string;
  /** Per-edit outcomes when the call succeeds; empty when it fails
   *  before any edit applies. */
  edits?: Array<{ ok: true; oldLen: number; newLen: number }>;
  /** When the call fails on a specific edit, which one (1-indexed). */
  failedEditIndex?: number;
}

export function editFileSchema(): Tool {
  return {
    name: "edit_file",
    description:
      "Apply one or more exact-text replacements inside an existing file. " +
      "Pass `edits: [{old_text, new_text}, ...]` for a batch — the file is " +
      "read once, edits run in order in memory, and the result is written " +
      "atomically only if every edit succeeds (so a partial batch never lands " +
      "on disk). Each `old_text` must appear exactly once at the moment its " +
      "edit runs, otherwise the whole batch fails and reports which edit " +
      "tripped. Use `write_file` for new files or full rewrites; reach for " +
      "edit_file when you're patching specific regions.\n\n" +
      "Single-edit shorthand `{path, old_text, new_text}` is still accepted " +
      "for one-shot patches.",
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path relative to the workspace root, e.g. "/notes/today.md".',
      }),
      edits: Type.Optional(
        Type.Array(
          Type.Object({
            old_text: Type.String({
              description:
                "Exact text to find. Must appear exactly once at edit time.",
            }),
            new_text: Type.String({
              description: "Replacement text.",
            }),
          }),
          {
            description:
              "List of edits to apply in order. Use this for batch updates; " +
              "skip if you're using the legacy single-edit shorthand.",
          },
        ),
      ),
      // Backwards-compat single-edit shape; ignored when `edits` is set.
      old_text: Type.Optional(Type.String()),
      new_text: Type.Optional(Type.String()),
    }),
  };
}

export function executeEditFile(
  userHome: string,
  args: {
    path: string;
    edits?: SingleEdit[];
    old_text?: string;
    new_text?: string;
  },
): EditFileToolResult {
  // Normalise to a non-empty edits array. Single-edit shorthand
  // wins only if `edits` is missing — passing both is ambiguous,
  // we prefer the structured form.
  const edits: SingleEdit[] | null = args.edits
    ? args.edits
    : args.old_text !== undefined && args.new_text !== undefined
      ? [{ old_text: args.old_text, new_text: args.new_text }]
      : null;
  if (!edits) {
    return {
      ok: false,
      text: "edit_file: pass either `edits` array or both `old_text` + `new_text`",
    };
  }
  if (edits.length === 0) {
    return { ok: false, text: "edit_file: edits array is empty" };
  }

  let resolved: string;
  try {
    resolved = resolveInUserHome(userHome, args.path);
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: `path is outside the workspace: ${args.path}` };
    }
    throw err;
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, text: `not found: ${args.path}` };
  }
  if (fs.statSync(resolved).isDirectory()) {
    return { ok: false, text: `is a directory: ${args.path}` };
  }

  const original = fs.readFileSync(resolved, "utf8");
  const applied: Array<{ ok: true; oldLen: number; newLen: number }> = [];
  let working = original;

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    if (e.old_text.length === 0) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} has empty old_text`,
        failedEditIndex: i + 1,
      };
    }
    if (e.old_text === e.new_text) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} old_text and new_text are identical`,
        failedEditIndex: i + 1,
      };
    }
    const occ = countOccurrences(working, e.old_text);
    if (occ === 0) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} old_text not found in ${args.path} (after ${i} prior edit${i === 1 ? "" : "s"} applied in memory)`,
        failedEditIndex: i + 1,
      };
    }
    if (occ > 1) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} old_text appears ${occ} times in ${args.path} (after ${i} prior edit${i === 1 ? "" : "s"}); pull a wider unique window`,
        failedEditIndex: i + 1,
      };
    }
    working = working.replace(e.old_text, e.new_text);
    applied.push({
      ok: true,
      oldLen: e.old_text.length,
      newLen: e.new_text.length,
    });
  }

  // Atomic write: temp sibling then rename. Only if every edit ran.
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, working);
  fs.renameSync(tmp, resolved);

  const totalDelta = applied.reduce(
    (acc, a) => acc + (a.newLen - a.oldLen),
    0,
  );
  const summary =
    applied.length === 1
      ? `edited ${toWorkspaceUri(userHome, resolved)} (${applied[0]!.oldLen} → ${applied[0]!.newLen} chars)`
      : `edited ${toWorkspaceUri(userHome, resolved)} (${applied.length} edits, net ${totalDelta >= 0 ? "+" : ""}${totalDelta} chars)`;
  return { ok: true, text: summary, edits: applied };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}
