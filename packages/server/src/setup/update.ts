// `tianshu update` — self-updater for the global install.
//
// Default behaviour:
//   1. Read the local package.json's version (the version that
//      shipped with this `tianshu` binary).
//   2. Fetch `latest` from the npm registry.
//   3. If equal → noop, print "already on latest".
//   4. If different → run `npm install -g @tianshu-ai/tianshu@latest`
//      and print a nudge to restart the service.
//
// Modes:
//   --check       Just compare versions; never invoke npm install.
//                 Exit code 0 when up to date, 1 when an update is
//                 available, 2 on error. Useful for scripts /
//                 health monitors.
//   --tag <name>  Install a non-`latest` dist-tag (e.g. `next`,
//                 `hotfix`). Defaults to `latest`.
//   --dry-run     Print the command we'd execute, but don't run it.
//
// Anti-features:
//   - Does NOT auto-restart the dev server. Restart is destructive
//     (in-flight chats, sandbox state). We surface a one-line
//     suggestion (`tianshu restart`) and stop.
//   - Does NOT run from a checkout. If we detect the binary is
//     coming out of a git working tree rather than a global npm
//     install, refuse with a helpful message — `git pull` is the
//     right path for that audience.
//   - Does NOT touch local config / tenants / data. npm install -g
//     only replaces the package files.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export const PACKAGE_NAME = "@tianshu-ai/tianshu";
const REGISTRY_BASE = "https://registry.npmjs.org";

export interface UpdateCmdOpts {
  /** Just check; don't install. */
  check?: boolean;
  /** npm dist-tag to target. Defaults to "latest". */
  tag?: string;
  /** Print the command but don't execute it. */
  dryRun?: boolean;
  /** Override timeout for the registry fetch (ms). Test seam. */
  fetchTimeoutMs?: number;
}

/**
 * `tianshu update [--check] [--tag <name>] [--dry-run]`
 *
 * Exit codes:
 *   0  → up to date OR update successful OR --check found nothing
 *   1  → --check found an update (script-friendly signal)
 *   2  → error (network, npm install failed, etc.)
 */
export async function runUpdate(opts: UpdateCmdOpts = {}): Promise<number> {
  const tag = opts.tag ?? "latest";

  // Step 1: where did THIS binary come from?
  // Refuse to update if it looks like a git checkout — `git pull`
  // is the right answer for that audience and `npm i -g` would
  // confusingly install a parallel global copy.
  const sourceKind = detectInstallSource();
  if (sourceKind === "checkout") {
    console.log(
      [
        "It looks like this `tianshu` binary is running from a git checkout, not a global npm install.",
        "Use `git pull` (and `npm install` if dependencies changed) to update.",
        "If you want to switch to the published npm package: `npm install -g @tianshu-ai/tianshu@latest`",
      ].join("\n"),
    );
    return 0;
  }

  // Step 2: current version (from the package.json shipped with
  // this binary).
  const currentVersion = readLocalVersion();
  console.log(`Current version: ${currentVersion}`);

  // Step 3: ask the registry for the dist-tagged latest.
  const remote = await fetchDistTag(tag, opts.fetchTimeoutMs ?? 10_000);
  if (!remote.ok) {
    console.error(`Couldn't reach npm registry: ${remote.error}`);
    console.error(
      "Check your network / VPN / corporate proxy and retry. If you're offline, skip the update.",
    );
    return 2;
  }
  const remoteVersion = remote.version;
  console.log(`Latest on \`${tag}\`: ${remoteVersion}`);

  if (currentVersion === remoteVersion) {
    console.log("Already up to date.");
    return 0;
  }

  // Step 4: report + maybe install.
  if (opts.check) {
    console.log(
      `Update available: ${currentVersion} → ${remoteVersion}. ` +
        "Run `tianshu update` to install.",
    );
    return 1;
  }

  const cmd = `npm install -g ${PACKAGE_NAME}@${remoteVersion}`;
  if (opts.dryRun) {
    console.log(`Would run: ${cmd}`);
    return 0;
  }

  console.log(`Installing ${remoteVersion}...`);
  try {
    // We spawn `npm` rather than fetching the tarball ourselves
    // because npm handles a bunch of edge cases (registry config,
    // proxy support, .npmrc credentials, bin shim relinking) we
    // don't want to reimplement. Inherit stdio so progress shows
    // up in the user's terminal.
    await new Promise<void>((resolve, reject) => {
      const child = (async () => {
        const { spawn } = await import("node:child_process");
        const c = spawn(
          "npm",
          ["install", "-g", `${PACKAGE_NAME}@${remoteVersion}`],
          { stdio: "inherit" },
        );
        c.on("error", reject);
        c.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`npm exited with code ${code}`));
        });
      })();
      void child;
    });
  } catch (err) {
    console.error(
      `npm install failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "If this is a permissions error (EACCES on a system Node install), " +
        "either re-run with sudo, or move to a Node manager (nvm / volta / asdf) " +
        "where global installs don't need root.",
    );
    return 2;
  }

  // Reaching here means npm exited 0; the global bin shim now
  // points at the new dist. Nudge the user to bounce the service
  // so the dev server runs the new code too.
  console.log("");
  console.log(`Installed ${PACKAGE_NAME}@${remoteVersion}.`);

  // Post-install health check (Yu 2026-06-29 follow-up to the
  // 0.4.0 upgrade incident where openshell's `openshell-gateway`
  // PATH prereq tripped up an upgraded host that had never
  // hosted openshell before). We re-import doctor *after* npm
  // has refreshed the global install so the report reflects
  // the new dist's plugin set, not the version we booted from.
  //
  // This is a best-effort signal, NOT a gate: a failed probe
  // (offline registry, broken sqlite, transient docker hiccup)
  // shouldn't block a successful update. We swallow errors and
  // surface a generic nudge if anything goes sideways. Skip the
  // npm-registry version probe because we just installed and
  // it would be redundant.
  let blockerCount = 0;
  const blockerTitles: string[] = [];
  try {
    const { collectDoctorReport } = await import("./doctor.js");
    const report = await collectDoctorReport({ skipVersionCheck: true });
    blockerCount = report.blocker;
    if (blockerCount > 0) {
      for (const g of report.groups) {
        if (g.lines.some((l) => l.severity === "blocker")) {
          blockerTitles.push(g.title);
        }
      }
    }
  } catch (err) {
    // Don't punish a successful upgrade for a noisy doctor.
    // The dedicated `tianshu doctor` command stays available
    // if the user wants the full output.
    console.log(
      `(Could not run post-install health check: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  console.log("Next steps:");
  console.log("  tianshu restart       # bounce the dev server");
  console.log("  tianshu version       # confirm the new version is live");
  if (blockerCount > 0) {
    // List the offending groups so the user knows where to
    // look. The setup agent (`tianshu setup`) reads the same
    // doctor groups and can drive the fix interactively, so
    // point them there rather than dumping the full report.
    console.log("");
    console.log(
      `⚠️  Post-install doctor found ${blockerCount} blocker(s) that may stop the server from starting:`,
    );
    const shown = blockerTitles.slice(0, 5);
    for (const t of shown) {
      console.log(`     • ${t}`);
    }
    if (blockerTitles.length > shown.length) {
      console.log(
        `     … and ${blockerTitles.length - shown.length} more`,
      );
    }
    console.log("");
    console.log("   Suggested actions (run either of these):");
    console.log(
      "     tianshu setup --wizard   # interactive setup agent fixes prereqs",
    );
    console.log(
      "     tianshu doctor           # full diagnostic report",
    );
  }
  return 0;
}

// ─── helpers ───────────────────────────────────────────────────────

export type InstallSource = "npm-global" | "checkout" | "unknown";

/**
 * Best-effort: are we running out of a global npm install or a
 * git working tree?
 *
 * Heuristics:
 *   - If a `.git` directory exists above our module path → checkout
 *   - If our module path contains `/node_modules/` AND that
 *     `node_modules/` lives directly under what looks like an
 *     npm prefix (e.g. `/opt/homebrew/lib/node_modules/` or
 *     `~/.nvm/versions/node/v22.x.x/lib/node_modules/`) → npm-global
 *   - Otherwise → unknown (treated like npm-global; conservative)
 */
export function detectInstallSource(): InstallSource {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));

  // Walk up looking for a sibling `.git` dir — that's the
  // git-checkout signal.
  let dir = moduleDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return "checkout";
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Inside a node_modules tree → npm install.
  if (moduleDir.includes(`${path.sep}node_modules${path.sep}`)) {
    return "npm-global";
  }

  return "unknown";
}

export function readLocalVersion(): string {
  try {
    const url = new URL("../../../../package.json", import.meta.url);
    const json = JSON.parse(fs.readFileSync(url, "utf8")) as {
      version?: string;
    };
    return json.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface RemoteResult {
  ok: true;
  version: string;
}
export interface RemoteError {
  ok: false;
  error: string;
}

/**
 * Fetch a specific dist-tag's version from the npm registry.
 *
 * We hit the lightweight `/-/package/<name>/dist-tags` endpoint
 * rather than `/<name>` (full metadata, can be MBs). The former
 * is ~50 bytes and serves the same purpose for "what's the latest
 * version under this tag".
 */
export async function fetchDistTag(
  tag: string,
  timeoutMs: number,
): Promise<RemoteResult | RemoteError> {
  const url = `${REGISTRY_BASE}/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) {
      return {
        ok: false,
        error: `registry returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as Record<string, string>;
    const version = body[tag];
    if (!version) {
      const known = Object.keys(body).join(", ") || "(none)";
      return {
        ok: false,
        error: `dist-tag '${tag}' not found. Known tags: ${known}`,
      };
    }
    return { ok: true, version };
  } catch (err) {
    clearTimeout(t);
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Silence the unused-binding lint on exec while keeping it as
// documented future-use (the spawn fallback above doesn't use
// promisify because we want streaming stdio).
void exec;
