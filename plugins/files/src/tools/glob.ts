// glob — match file paths against a shell-style pattern, scoped to
// the per-user workspace home.
//
// Backed by fast-glob so brace expansion, alternation, double-star,
// case sensitivity, and gitignore-shaped traversal all behave the way
// the LLM expects from prior training data.

import fs from "node:fs";
import fg from "fast-glob";
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import {
  resolveInUserHome,
  toWorkspaceUri,
  PathOutsideRootError,
} from "./path-helper.js";

const MAX_RESULTS = 1000;

export interface GlobToolResult {
  ok: boolean;
  text: string;
  matches?: string[];
  truncated?: boolean;
}

export function globSchema(): Tool {
  return {
    name: "glob",
    description:
      `Find files matching a shell-style glob pattern, rooted at the workspace.\n` +
      `Supports the usual glob syntax: \`*\`, \`**\`, \`?\`, \`{a,b}\`, character classes.\n` +
      `Returns up to ${MAX_RESULTS} matching paths, sorted alphabetically.`,
    parameters: Type.Object({
      pattern: Type.String({
        description:
          'Glob pattern relative to the workspace root, e.g. "**/*.md", "src/*.ts", "{notes,journal}/**/*.txt".',
      }),
    }),
  };
}

export async function executeGlob(
  userHome: string,
  args: { pattern: string },
): Promise<GlobToolResult> {
  if (!args.pattern || typeof args.pattern !== "string") {
    return { ok: false, text: "pattern is required" };
  }

  // Strip the optional `/workspace/` prefix or leading `/` so the
  // pattern is fast-glob-relative to userHome. We forbid `..` outright
  // to keep the search inside the user home regardless of any path
  // tricks fast-glob might otherwise resolve.
  let pat = args.pattern.replace(/\\/g, "/");
  if (pat.startsWith("/workspace/")) pat = pat.slice("/workspace/".length);
  else if (pat === "/workspace") pat = "";
  if (pat.startsWith("/")) pat = pat.slice(1);
  if (pat.includes("..")) {
    return { ok: false, text: `pattern cannot contain ".."` };
  }
  if (pat.length === 0) {
    return { ok: false, text: "pattern is empty" };
  }

  // Resolve root and auto-create on first call so a fresh tenant
  // doesn't blow up.
  let root: string;
  try {
    root = resolveInUserHome(userHome, "/");
  } catch (err) {
    if (err instanceof PathOutsideRootError) {
      return { ok: false, text: "could not resolve workspace root" };
    }
    throw err;
  }
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });

  // fast-glob honours `cwd`, returns paths relative to that cwd, and
  // we ask it for files only. `dot: true` so dotfiles surface (the
  // workspace deliberately uses .config/ etc.).
  const found = await fg(pat, {
    cwd: root,
    onlyFiles: true,
    dot: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  found.sort();
  const truncated = found.length > MAX_RESULTS;
  const slice = truncated ? found.slice(0, MAX_RESULTS) : found;
  const matches = slice.map((rel) =>
    toWorkspaceUri(root, `${root}/${rel}`),
  );

  const header = `${matches.length} match${matches.length === 1 ? "" : "es"}${truncated ? ` (truncated at ${MAX_RESULTS})` : ""}:`;
  return {
    ok: true,
    text: [header, ...matches].join("\n"),
    matches,
    truncated,
  };
}
