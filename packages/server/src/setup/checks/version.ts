// Version freshness check: compare the running tianshu version
// against the `latest` dist-tag on the npm registry.
//
// Three outcomes:
//   - up to date → ok
//   - update available → warning (with the npm command to apply)
//   - registry unreachable / dev checkout → ok (informational only)
//
// Why warning, not blocker: an old version is rarely actually
// broken; the user might be deliberately pinned. We surface the
// gap so they know it's there, but `tianshu doctor` should still
// exit 0 — that exit code is for "things are wrong RIGHT NOW",
// not "things could be newer".
//
// Dev checkouts (running from `git clone` rather than
// `npm install -g`) get a different message — we don't compare
// version numbers because the checkout might intentionally be
// ahead of npm. `git status` is the right tool there.
//
// Offline / firewalled installs degrade gracefully: registry
// fetch failure is logged as a single ok line ("couldn't check
// for updates"), never blocks doctor.

import { CheckGroup } from "../render.js";
import {
  detectInstallSource,
  fetchDistTag,
  PACKAGE_NAME,
  readLocalVersion,
} from "../update.js";

export interface VersionCheckOpts {
  /** Override timeout for the registry probe (ms). Test seam. */
  fetchTimeoutMs?: number;
  /** When true, skip the network call entirely. */
  skipRemote?: boolean;
}

export async function checkVersion(
  opts: VersionCheckOpts = {},
): Promise<CheckGroup> {
  const lines: CheckGroup["lines"] = [];
  const current = readLocalVersion();
  const source = detectInstallSource();

  // Dev checkouts: don't claim "out of date" — the checkout may
  // be ahead of npm or pinned by intent. Just report the local
  // version + how to update.
  if (source === "checkout") {
    lines.push({
      severity: "ok",
      text: `Tianshu ${current} (git checkout)`,
      detail:
        "Running from a source tree. Use `git pull` to update; npm-registry comparison skipped.",
    });
    return { title: "Tianshu version", lines };
  }

  lines.push({
    severity: "ok",
    text: `Tianshu ${current}`,
    detail: source === "npm-global"
      ? `Installed via npm (${PACKAGE_NAME}).`
      : `Install source: ${source}.`,
  });

  if (opts.skipRemote) {
    return { title: "Tianshu version", lines };
  }

  const remote = await fetchDistTag("latest", opts.fetchTimeoutMs ?? 5_000);
  if (!remote.ok) {
    // Conservative: don't escalate. Reachability problems are
    // somebody else's domain (corporate proxy, offline). We've
    // already shown the current version above — that's enough.
    lines.push({
      severity: "ok",
      text: "Couldn't reach npm registry to check for updates",
      detail: `${remote.error}. Skipped update check; existing install is unaffected.`,
    });
    return { title: "Tianshu version", lines };
  }

  if (remote.version === current) {
    lines.push({
      severity: "ok",
      text: `Up to date with npm \`latest\` (${remote.version})`,
    });
    return { title: "Tianshu version", lines };
  }

  // Different version on npm. Could be newer OR (rare, but
  // possible if the user installed a pre-release) older. Either
  // way the user should know.
  const direction = isNewer(remote.version, current) ? "newer" : "different";
  lines.push({
    severity: "warning",
    text:
      direction === "newer"
        ? `Update available: ${current} → ${remote.version}`
        : `npm \`latest\` is ${remote.version} (different from ${current})`,
    detail:
      "Run `tianshu update` to install. The install replaces only the package files; tenants, config, and data stay untouched. After updating, run `tianshu restart` to bounce the server.",
  });
  return { title: "Tianshu version", lines };
}

/**
 * Naive semver-ish comparison: returns true when `candidate` looks
 * newer than `base`. Doesn't handle prerelease tags
 * (`-alpha.1`) — for those we fall back to a string compare,
 * which is good enough for "is this different?" purposes; the
 * caller's actual fix advice is the same either way (run
 * `tianshu update`).
 */
export function isNewer(candidate: string, base: string): boolean {
  const a = parsePart(candidate);
  const b = parsePart(base);
  if (a === null || b === null) return candidate !== base;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function parsePart(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/, "").split("-")[0];
  const parts = clean.split(".").map((s) => Number.parseInt(s, 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0], parts[1], parts[2]];
}
