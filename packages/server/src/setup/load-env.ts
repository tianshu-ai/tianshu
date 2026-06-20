// Load .env from the right place, regardless of CWD.
//
// Why this exists:
// `import "dotenv/config"` only looks at process.cwd()/.env. That
// works when you run `node packages/server/dist/index.js` from the
// repo root, but breaks the moment you do anything that shifts
// CWD — most importantly:
//   - `npm run dev -w packages/server` (npm sets CWD = packages/server)
//   - `npx tianshu doctor` from a checkout (CLI shim sits in bin/, but
//     CWD is wherever the user invoked it from)
//   - `tianshu start` after `npm install -g`
// In each of those, the canonical .env that the user filled in
// during `tianshu setup --wizard` lives at the *repo root* / install
// root, not at CWD.
//
// We find the .env by walking up from this module's own location
// (which is a stable anchor: it's always somewhere under the
// install / checkout root). First .env hit wins. We also still
// honour an explicit DOTENV_PATH or a CWD-local .env so the user
// can override per invocation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

let loaded = false;

/**
 * Load `.env` once per process. Idempotent.
 *
 * Search order:
 *   1. `DOTENV_PATH` env var (explicit override).
 *   2. `<cwd>/.env` (preserves the legacy behaviour for users
 *      who run from the repo root).
 *   3. Walking up from this file's directory until a `.env` is
 *      found or we hit the filesystem root.
 *
 * Whichever is found first is loaded with `override: false`, so
 * shell-level env vars still win over file values — that
 * matches dotenv's default and lets ops override a key for a
 * single run without editing the file.
 */
export function loadEnv(opts: { force?: boolean } = {}): {
  source: string | null;
} {
  if (loaded && !opts.force) return { source: null };
  loaded = true;

  const candidates: string[] = [];
  const explicit = process.env.DOTENV_PATH;
  if (explicit) candidates.push(explicit);
  candidates.push(path.resolve(process.cwd(), ".env"));

  // Walk up from this file. In dev that's
  //   <repo>/packages/server/src/setup/load-env.ts
  // In a published install it's
  //   <install>/packages/server/dist/setup/load-env.js
  // Either way, walking up will reach the repo / install root
  // before the filesystem root.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    candidates.push(path.join(dir, ".env"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      // override: true on force-reload so a key the wizard just
      // appended actually shows up in process.env (dotenv won't
      // overwrite an already-set var by default).
      dotenv.config({ path: cand, override: opts.force ?? false });
      return { source: cand };
    }
  }
  return { source: null };
}
