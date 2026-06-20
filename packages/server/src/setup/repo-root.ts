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
