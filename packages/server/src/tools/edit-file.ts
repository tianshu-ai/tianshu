// edit_file — exact text replacement (the agent's bread-and-butter
// surgical edit tool, modelled on Anthropic's `str_replace_editor`).
//
// We require `oldText` to occur **exactly once** in the file so an
// LLM can't accidentally clobber a similarly-named variable in three
// places when it meant one. Multi-occurrence cases force the agent
// to either pull a wider unique window or fall back to write_file.
//
// Atomic on disk via temp sibling + rename (same as write_file).

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import { resolveInUserHome, PathOutsideRootError } from "./path-helper.js";

export interface EditFileToolResult {
  ok: boolean;
  text: string;
  occurrences?: number;
}

export function editFileSchema(): Tool {
  return {
    name: "edit_file",
    description:
      "Replace one exact substring with another inside an existing file. The " +
      "`old_text` must appear EXACTLY ONCE in the file — if it appears multiple " +
      "times the call fails and you should pull a wider unique window. Use this " +
      "for surgical edits; for new files or full rewrites use `write_file`.",
    parameters: Type.Object({
      path: Type.String({
        description: 'Path relative to the workspace root, e.g. "/notes/today.md".',
      }),
      old_text: Type.String({
        description:
          "The exact text to find and replace. Must appear exactly once in the file.",
      }),
      new_text: Type.String({
        description: "The replacement text.",
      }),
    }),
  };
}

export function executeEditFile(
  userHome: string,
  args: { path: string; old_text: string; new_text: string },
): EditFileToolResult {
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
  if (args.old_text.length === 0) {
    return { ok: false, text: "old_text must be non-empty" };
  }
  if (args.old_text === args.new_text) {
    return { ok: false, text: "old_text and new_text are identical" };
  }

  const original = fs.readFileSync(resolved, "utf8");
  const occurrences = countOccurrences(original, args.old_text);
  if (occurrences === 0) {
    return { ok: false, text: `old_text not found in ${args.path}` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      text: `old_text appears ${occurrences} times in ${args.path}; pull a wider unique window`,
      occurrences,
    };
  }

  const updated = original.replace(args.old_text, args.new_text);
  const tmp = `${resolved}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, updated);
  fs.renameSync(tmp, resolved);

  return {
    ok: true,
    text: `edited ${args.path} (${args.old_text.length} → ${args.new_text.length} chars)`,
    occurrences: 1,
  };
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
