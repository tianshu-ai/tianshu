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
 * Search order (first hit wins):
 *   1. `DOTENV_PATH` env var (explicit override; ops escape hatch).
 *   2. `<TIANSHU_HOME>/.env` (~/.tianshu/.env by default). This
 *      is the canonical location the wizard writes to on a
 *      global install — it's user-writable, survives
 *      `npm install -g` upgrades (which would otherwise nuke a
 *      .env stored in the install dir), and isn't tied to any
 *      cwd / checkout location.
 *   3. `<cwd>/.env` (legacy: respects the developer's local
 *      override when running from a repo).
 *   4. Walking up from this file's directory until a `.env` is
 *      found or we hit the filesystem root. Covers the
 *      historical "wizard wrote .env to the checkout root" case
 *      so existing dev setups don't break.
 *
 * Loaded with `override: false`, so shell-level env vars still
 * win over file values — that matches dotenv's default and
 * lets ops override a key for a single run without editing
 * the file.
 */
export function loadEnv(opts: { force?: boolean } = {}): {
  source: string | null;
} {
  if (loaded && !opts.force) return { source: null };
  loaded = true;

  const candidates: string[] = [];
  const explicit = process.env.DOTENV_PATH;
  if (explicit) candidates.push(explicit);

  // TIANSHU_HOME/.env: the canonical location. Resolved the
  // same way getTianshuHome() does (TIANSHU_HOME env > ~/.tianshu).
  // We inline the resolution rather than importing
  // `getTianshuHome` from core/paths to keep load-env free of
  // cross-package deps — this module runs before everything
  // else and shouldn't pull in chunks of core.
  const tianshuHome =
    process.env.TIANSHU_HOME ??
    path.join(process.env.HOME ?? "", ".tianshu");
  if (tianshuHome && tianshuHome !== ".tianshu") {
    candidates.push(path.join(tianshuHome, ".env"));
  }

  candidates.push(path.resolve(process.cwd(), ".env"));

  // Walk up from this file. In dev that's
  //   <repo>/packages/server/src/setup/load-env.ts
  // In a published install it's
  //   <install>/packages/server/dist/setup/load-env.js
  // Either way, walking up will reach the repo / install root
  // before the filesystem root. This covers the historical
  // "wizard wrote .env to the checkout root" case so existing
  // dev setups keep working without migration.
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
      //
      // quiet: true suppresses dotenv v17's funding tip
      // ("◇ injected env (N) from .env // tip: ..."). The tip
      // is shown on every load by default — every
      // `tianshu status` / `tianshu logs` / `tianshu doctor`
      // invocation prints it, which is noisy enough to
      // obscure the actual CLI output. We're not interested
      // in the advertisement; the user already chose dotenv
      // by running tianshu.
      dotenv.config({
        path: cand,
        override: opts.force ?? false,
        quiet: true,
      });
      return { source: cand };
    }
  }
  return { source: null };
}
