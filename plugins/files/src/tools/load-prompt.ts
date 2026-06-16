// Tiny helper that loads a `*.prompt.md` sibling file at module-
// load time and returns its UTF-8 contents.
//
// Why a helper instead of inlining `readFileSync` at every call
// site: each tool has its own prompt and we want the tool file to
// just say `description: loadPrompt("edit-file.prompt.md")`. The
// helper resolves relative to the calling file's compiled
// location (dist/tools/), where copy-prompts.mjs has placed the
// markdown sibling — see scripts/copy-prompts.mjs for the build-
// time half of this contract.
//
// Loaded lazily and memoised: same prompt name only hits the
// disk once per process even if the schema function gets called
// many times (currently it's called once at activate(), but
// memoisation keeps the helper safe for hot paths too).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string>();

/** Loads a prompt file from the same directory as the compiled
 *  caller (dist/tools/<name>.prompt.md). The argument is the
 *  filename only, no path separators. */
export function loadPrompt(name: string): string {
  if (name.includes("/") || name.includes("\\") || !name.endsWith(".prompt.md")) {
    throw new Error(`loadPrompt: bad prompt name ${JSON.stringify(name)}`);
  }
  const hit = cache.get(name);
  if (hit !== undefined) return hit;

  // dist/tools/<name>.prompt.md, resolved relative to this file's
  // compiled location. import.meta.url points at dist/tools/load-prompt.js
  // at runtime, so dirname() gives us dist/tools/.
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, name);
  const text = readFileSync(path, "utf8");
  cache.set(name, text);
  return text;
}
