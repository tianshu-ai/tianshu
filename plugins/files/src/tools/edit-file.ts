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
import { loadPrompt } from "./load-prompt.js";
import { hasRead, markRead } from "./read-tracker.js";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";
import { applyShape, normaliseEnding, shapeOf } from "./text-shape.js";
import { findMatch } from "./replacers.js";

interface SingleEdit {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
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
    description: loadPrompt("edit-file.prompt.md"),
    parameters: Type.Object({
      path: Type.String({
        description:
          'Path relative to the workspace root, e.g. "/notes/today.md".',
      }),
      // `edits` is REQUIRED at the schema level so the host's
      // truncation detector fires when the model emits
      // `{path: "..."}` with the array dropped — a common stream
      // truncation pattern. The legacy `{old_text, new_text}`
      // shorthand is still accepted at runtime (executeEditFile
      // re-shapes it into a single-element edits array) for
      // back-compat with existing callers, but the schema only
      // documents the canonical form.
      edits: Type.Array(
        Type.Object({
          old_text: Type.String({
            description:
              "Exact text to find. Must appear exactly once at edit time " +
              "unless `replace_all` is set. Whitespace-only and indentation-only " +
              "differences are tolerated via fuzzy matching; if no match is " +
              "found at all the whole batch fails atomically.",
          }),
          new_text: Type.String({
            description: "Replacement text.",
          }),
          replace_all: Type.Optional(
            Type.Boolean({
              description:
                "Replace every occurrence of `old_text`. Use for renaming " +
                "a symbol across the file (the typical multi-occurrence case). " +
                "Default false: requires the match to be unique.",
            }),
          ),
        }),
        {
          minItems: 1,
          description:
            "List of edits to apply in order, atomic (all or nothing). " +
            "Each entry is one find/replace pair.",
        },
      ),
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
    replace_all?: boolean;
  },
  sessionId?: string,
): EditFileToolResult {
  // Normalise to a non-empty edits array. Single-edit shorthand
  // wins only if `edits` is missing — passing both is ambiguous,
  // we prefer the structured form.
  const edits: SingleEdit[] | null = args.edits
    ? args.edits
    : args.old_text !== undefined && args.new_text !== undefined
      ? [
          {
            old_text: args.old_text,
            new_text: args.new_text,
            replace_all: args.replace_all,
          },
        ]
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

  // Read-required: every edit_file call must follow a read_file
  // on the same path in the same session. Without that the agent
  // is matching against text it never actually saw, which is how
  // overconfident overwrites land. The error tells the agent
  // exactly what to do next.
  if (!hasRead(sessionId, resolved)) {
    return {
      ok: false,
      text:
        `edit_file: you must call read_file on ${args.path} first — ` +
        `exact-text matching needs the file's actual current contents in your context. ` +
        `Read the whole file (offset=0, no limit) and then retry the edit.`,
    };
  }

  // Read once, peel BOM, detect line ending. We work on the
  // BOM-less, already-text representation throughout the batch;
  // only re-prepend BOM at the final write step.
  const raw = fs.readFileSync(resolved, "utf8");
  const shape = shapeOf(raw);
  const applied: Array<{ ok: true; oldLen: number; newLen: number }> = [];
  let working = shape.text;

  for (let i = 0; i < edits.length; i++) {
    const e = edits[i]!;
    // Normalise the model's input to the file's actual line
    // ending so a CRLF file matches even when the model sent LF
    // (and vice-versa).
    const oldText = normaliseEnding(e.old_text, shape.ending);
    const newText = normaliseEnding(e.new_text, shape.ending);
    if (oldText.length === 0) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} has empty old_text`,
        failedEditIndex: i + 1,
      };
    }
    if (oldText === newText) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} old_text and new_text are identical`,
        failedEditIndex: i + 1,
      };
    }
    const match = findMatch(working, oldText);
    if (!match) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} old_text not found in ${args.path} (after ${i} prior edit${i === 1 ? "" : "s"} applied in memory). The match is whitespace- and indent-tolerant; if it still doesn't fit, re-read the file and pull a fresh, larger unique window.`,
        failedEditIndex: i + 1,
      };
    }
    if (e.replace_all) {
      // Global replace using the *matched* span, not the
      // original `oldText`. If a fuzzy replacer rewrote
      // whitespace, we want to keep replacing the file's
      // shape, not the model's.
      const before = working;
      working = working.split(match.matched).join(newText);
      const replaced = (before.length - working.length) / Math.max(1, match.matched.length - newText.length);
      void replaced;
      applied.push({
        ok: true,
        oldLen: oldText.length,
        newLen: newText.length,
      });
      continue;
    }
    // Uniqueness check on the *exact match span* — if a fuzzy
    // candidate appears more than once, we still want the agent
    // to disambiguate.
    const occ = countOccurrences(working, match.matched);
    if (occ > 1) {
      return {
        ok: false,
        text: `edit_file: edit #${i + 1} old_text matches ${occ} places in ${args.path} (after ${i} prior edit${i === 1 ? "" : "s"}); pull a wider unique window or set replace_all=true if you really mean every occurrence`,
        failedEditIndex: i + 1,
      };
    }
    working =
      working.slice(0, match.start) + newText + working.slice(match.end);
    applied.push({
      ok: true,
      oldLen: oldText.length,
      newLen: newText.length,
    });
  }

  // Atomic write: temp sibling then rename. Only if every edit ran.
  // Re-attach the BOM here — BOM-preservation is the contract; the
  // batch above never saw it.
  const finalText = applyShape(working, shape);
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, finalText);
  fs.renameSync(tmp, resolved);

  // After a successful edit the agent's mental model of the file
  // is now `working`, which is in its context (it just wrote
  // those edits). Treat that as equivalent to having read the new
  // bytes — otherwise a second edit_file in the same turn would
  // need a fresh read_file in between, which is wasteful.
  markRead(sessionId, resolved);

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
