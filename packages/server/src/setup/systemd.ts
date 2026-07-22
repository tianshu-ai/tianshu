// Low-level systemd (user-scoped) helpers for tianshu's Linux
// dev / prod background service. This is the Linux counterpart to
// launchd.ts and mirrors its export surface so service.ts and the
// wizard (start-server.ts) can dispatch by platform without caring
// which init system is underneath.
//
// Design choices (kept parallel to launchd.ts):
//   - User-scoped units only (`systemctl --user`). We never touch
//     system-wide units — tianshu runs as the invoking user, needs
//     $HOME, and must not require root. This means the machine
//     needs a user systemd instance (standard on any desktop /
//     modern server login; for headless boxes the operator may need
//     `loginctl enable-linger <user>` to keep it running without an
//     active session — surfaced as a hint, not enforced here).
//   - Unit name is derived from install shape, not opaque hash:
//       * `npm install -g` install → `tianshu-prod.service`
//       * git checkout (dev mode)  → `tianshu-dev.service`
//       * a second checkout colliding with the dev name →
//         `tianshu-dev-<hash8>.service` so two clones coexist.
//   - Functions return structured results, never throw on
//     "unit isn't loaded" / "unit file doesn't exist".
//   - Args are quoted carefully — checkout paths can have spaces.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDevelopmentCheckout } from "./repo-root.js";
import type {
  ServiceStatus,
  LaunchdInstallOpts,
  LaunchctlResult,
} from "./launchd.js";

// Re-export the shared shapes so callers can import from whichever
// backend module they hold a reference to.
export type { ServiceStatus, LaunchctlResult } from "./launchd.js";
export {
  probeHealth,
  waitForHealth,
  resolveNpmPath,
  type HealthResult,
} from "./launchd.js";

export const CANONICAL_DEV_UNIT = "tianshu-dev.service";
export const PROD_UNIT = "tianshu-prod.service";
/** Back-compat alias mirroring launchd's CANONICAL_LABEL. */
export const CANONICAL_UNIT = CANONICAL_DEV_UNIT;

/** systemd install opts share launchd's shape (npmPath, ports, script). */
export type SystemdInstallOpts = LaunchdInstallOpts;

// ─── unit-name resolution (parallels launchd.resolveLabel) ─────────

/** Directory holding user-scoped systemd unit files. */
function userUnitDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user");
}

export function unitPathFor(unit: string): string {
  return path.join(userUnitDir(), unit);
}

/**
 * Resolve the systemd unit name for a given tianshu install.
 * Rules mirror launchd.resolveLabel:
 *   1. Not a git checkout (global npm install) → `tianshu-prod.service`.
 *   2. Git checkout → `tianshu-dev.service` if free/ours, else
 *      `tianshu-dev-<hash8>.service` to coexist with another clone.
 */
export function resolveLabel(repoRoot: string): string {
  if (!isDevelopmentCheckout(repoRoot)) {
    return PROD_UNIT;
  }
  const canonical = unitPathFor(CANONICAL_DEV_UNIT);
  if (!fs.existsSync(canonical)) return CANONICAL_DEV_UNIT;
  try {
    const body = fs.readFileSync(canonical, "utf8");
    const match = body.match(/^WorkingDirectory=(.+)$/m);
    if (match && path.resolve(match[1].trim()) === path.resolve(repoRoot)) {
      return CANONICAL_DEV_UNIT;
    }
  } catch {
    // unreadable — treat as someone else's, fall through to hash
  }
  const hash = createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return `tianshu-dev-${hash}.service`;
}

/**
 * Find stale unit files pointing at this same install path but
 * using a different unit name. Parallels launchd.findOrphanedLabels.
 */
export function findOrphanedLabels(
  currentUnit: string,
  installPath: string,
): Array<{ label: string; plistPath: string; workingDir: string }> {
  const dir = userUnitDir();
  if (!fs.existsSync(dir)) return [];
  const normalisedInstall = path.resolve(installPath);
  const orphans: Array<{
    label: string;
    plistPath: string;
    workingDir: string;
  }> = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith("tianshu-")) continue;
    if (!entry.endsWith(".service")) continue;
    if (entry === currentUnit) continue;
    const unitPath = path.join(dir, entry);
    let body: string;
    try {
      body = fs.readFileSync(unitPath, "utf8");
    } catch {
      continue;
    }
    const match = body.match(/^WorkingDirectory=(.+)$/m);
    if (!match) continue;
    const workingDir = path.resolve(match[1].trim());
    if (workingDir === normalisedInstall) {
      orphans.push({ label: entry, plistPath: unitPath, workingDir });
    }
  }
  return orphans;
}

// launchd callers say plistPathFor; keep the same name so the
// dispatcher can call it uniformly.
export const plistPathFor = unitPathFor;

// ─── logs ──────────────────────────────────────────────────────────
//
// systemd captures stdio to the journal by default. We ALSO tee to
// files under ~/.local/state/tianshu/log so `tianshu logs -f` works
// without depending on journald access (some minimal containers /
// non-systemd-journal setups). The unit uses StandardOutput=append:
// to those files.

function tianshuLogDir(): string {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, "tianshu", "log");
}

export function logPathsFor(unit: string): { out: string; err: string } {
  const dir = tianshuLogDir();
  const base = unit.replace(/\.service$/, "");
  return {
    out: path.join(dir, `${base}.out.log`),
    err: path.join(dir, `${base}.err.log`),
  };
}

// ─── status ──────────────────────────────────────────────────────

/**
 * Read current unit state via `systemctl --user show`. Never throws;
 * "unit not found" collapses to installed=false/loaded=false.
 */
export function readStatus(unit: string): ServiceStatus {
  const unitPath = unitPathFor(unit);
  const installed = fs.existsSync(unitPath);
  let loaded = false;
  let pid: number | null = null;
  let lastExitStatus: number | null = null;
  try {
    const out = execSync(
      `systemctl --user show ${shellQuote(unit)} --property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const props = new Map<string, string>();
    for (const line of out.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1).trim());
    }
    // LoadState=loaded means systemd knows the unit (file present +
    // parsed). ActiveState=active(running) means it's up.
    loaded = props.get("LoadState") === "loaded";
    const mainPid = Number.parseInt(props.get("MainPID") ?? "0", 10);
    const active = props.get("ActiveState");
    if (mainPid > 0 && active === "active") pid = mainPid;
    const exit = props.get("ExecMainStatus");
    if (exit !== undefined && exit !== "") {
      const n = Number.parseInt(exit, 10);
      if (!Number.isNaN(n)) lastExitStatus = n;
    }
  } catch {
    // systemctl missing / no user bus — leave defaults
  }
  return { label: unit, plistPath: unitPath, installed, loaded, pid, lastExitStatus };
}

// ─── unit file render ──────────────────────────────────────────────

/**
 * Render the systemd unit body. Pure — no side effects.
 * Parallels launchd.renderPlist.
 */
export function renderUnit(unit: string, opts: SystemdInstallOpts): string {
  const { out: logFile, err: errFile } = logPathsFor(unit);
  const npmBinDir = path.dirname(opts.npmPath);
  const pathEnv = `${npmBinDir}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `[Unit]
Description=Tianshu server (${unit})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.repoRoot}
ExecStart=${opts.npmPath} run ${opts.npmScript ?? "dev"}
Restart=on-failure
RestartSec=30
Environment=PATH=${pathEnv}
Environment=HOME=${os.homedir()}
Environment=NODE_OPTIONS=--no-warnings
StandardOutput=append:${logFile}
StandardError=append:${errFile}

[Install]
WantedBy=default.target
`;
}

/**
 * Write the unit file (creating the user unit dir + log dir).
 * Idempotent. Parallels launchd.writePlist.
 */
export function writePlist(unit: string, body: string): string {
  const unitPath = unitPathFor(unit);
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, body, { mode: 0o644 });
  fs.mkdirSync(tianshuLogDir(), { recursive: true });
  return unitPath;
}
// Alias so the dispatcher can call renderPlist uniformly.
export const renderPlist = renderUnit;

// ─── systemctl wrappers (parallel launchctl bootstrap/bootout/kickstart) ──

function runSystemctl(args: string): LaunchctlResult {
  try {
    execSync(`systemctl --user ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    return { ok: false, stderr: e.stderr ? e.stderr.toString() : e.message };
  }
}

function daemonReload(): void {
  try {
    execSync("systemctl --user daemon-reload", {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // best-effort; enable/start will surface the real error
  }
}

/**
 * `systemctl --user enable --now <unit>` — load + start.
 * The unit file path is written by writePlist; systemd resolves it
 * by name from the user unit dir, so we take the unit NAME here (the
 * plistPath is accepted for signature parity and its basename used).
 */
export function bootstrap(unitPathOrName: string): LaunchctlResult {
  const unit = path.basename(unitPathOrName);
  daemonReload();
  return runSystemctl(`enable --now ${shellQuote(unit)}`);
}

/** `systemctl --user disable --now <unit>` — stop + unload. */
export function bootout(unit: string): LaunchctlResult {
  const name = path.basename(unit);
  const r = runSystemctl(`disable --now ${shellQuote(name)}`);
  daemonReload();
  return r;
}

/** `systemctl --user restart <unit>` — restart. */
export function kickstart(unit: string): LaunchctlResult {
  return runSystemctl(`restart ${shellQuote(path.basename(unit))}`);
}

// ─── util ────────────────────────────────────────────────────────

/** Quote a single shell argument (paths can contain spaces). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Is a user systemd instance reachable? Used to give a precise
 * message instead of a raw systemctl error when running in a
 * container / minimal environment without a user bus.
 */
export function userBusAvailable(): boolean {
  // `systemctl --user is-system-running` prints a state word and
  // exits 0 only when "running". It exits non-zero for
  // degraded/starting/etc — but the bus still WORKS in those
  // cases, and the printed word proves it. The two ways it means
  // "no user systemd":
  //   - systemctl binary missing        → sh exits 127 (via execSync)
  //     or spawn ENOENT; either way stdout is empty.
  //   - no user bus (containers, no login session) → stderr says
  //     "Failed to connect to bus" and stdout is empty.
  // So: trust STDOUT. If we got a recognisable state word back,
  // the bus is reachable; otherwise it isn't.
  try {
    const out = execSync("systemctl --user is-system-running 2>/dev/null", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /\b(running|degraded|starting|stopping|maintenance|initializing)\b/.test(
      out,
    );
  } catch (err) {
    // Non-zero exit still gives us stdout on the error object.
    const e = err as { stdout?: Buffer | string };
    const out = e.stdout ? e.stdout.toString() : "";
    return /\b(running|degraded|starting|stopping|maintenance|initializing)\b/.test(
      out,
    );
  }
}
