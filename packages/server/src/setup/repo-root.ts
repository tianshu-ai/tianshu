// Resolve the tianshu checkout the CLI is running from.
//
// Users typically run `tianshu` from their home dir (or
// anywhere — the `bin/tianshu.mjs` shim is global-installable),
// so process.cwd() is rarely the repo. We walk *up* from this
// module's filesystem location until we find a package.json
// named '@tianshu-ai/tianshu'. That's the dir we treat as the
// checkout root.
//
// Why this is a tiny module on its own:
//   - start-server.ts (wizard install) needs it
//   - service.ts (`tianshu start|stop|...`) needs it
//   - both must agree, otherwise they'd derive different
//     launchd labels and the wizard would install one agent
//     while `tianshu start` operates on another.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (isTianshuCheckout(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function isTianshuCheckout(repoRoot: string): boolean {
  const pkgPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      name?: string;
    };
    return pkg.name === "@tianshu-ai/tianshu";
  } catch {
    return false;
  }
}

/**
 * Whether the resolved `repoRoot` is a **development git
 * checkout** (has a .git directory and devDependencies on disk)
 * vs a **global npm install** (lives under `node_modules/`,
 * has only the published file set).
 *
 * The distinction matters at launchd-plist-render time: the
 * dev path runs `npm run dev` (watch + rebuild via tsc / vite),
 * which needs devDependencies on disk; the global-install path
 * doesn't have them and has to run `npm run serve` against the
 * pre-built dist instead. Mis-detecting is the difference
 * between a working service and a launchd crash loop with
 * `tsc: command not found` repeating every 30 seconds.
 *
 * Heuristic:
 *   - If `<repoRoot>/.git` exists → development checkout.
 *   - If `repoRoot` path contains `/node_modules/` → global
 *     install (npm puts global packages under
 *     `<prefix>/lib/node_modules/@tianshu-ai/tianshu/`).
 *   - Otherwise default to development (more permissive; a
 *     missing .git in a checkout is unusual but possible, e.g.
 *     someone unpacked a source tarball).
 */
export function isDevelopmentCheckout(repoRoot: string): boolean {
  if (fs.existsSync(path.join(repoRoot, ".git"))) return true;
  if (repoRoot.includes(`${path.sep}node_modules${path.sep}`)) return false;
  return true;
}
