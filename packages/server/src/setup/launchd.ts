// Low-level launchd helpers for tianshu's macOS dev / prod
// background service.
//
// Why this module exists separately from start-server.ts:
//   - `tianshu start|stop|restart|status` (in service.ts) needs
//     to *operate* on an existing launchd agent without going
//     through the wizard's prompts.
//   - The wizard itself (start-server.ts) needs to *install*
//     and bootstrap the agent.
// Both paths must produce/operate on the same plist, with the
// same label, in the same place. Centralizing the plist render
// and the launchctl invocations here is how we keep them
// in sync.
//
// Design choices:
//   - Label is derived from install shape, not opaque hash:
//       * `npm install -g` install      → `ai.tianshu.prod`
//       * git checkout (dev mode)       → `ai.tianshu.dev`
//       * a *second* checkout colliding with the dev label →
//         fallback `ai.tianshu.dev.<hash8>` so two clones can
//         coexist without forcing the user to pick. This is
//         the same hash logic we used before, just narrowed
//         to the rare collision case rather than the default.
//     The old behaviour stamped every install with a hash
//     suffix (`ai.tianshu.dev.f71469f0`) which made labels
//     unmemorable and meant every nvm version bump changed the
//     id because the install path changed.
//   - Operators reading `tianshu status` should see
//     `ai.tianshu.prod` and immediately know what kind of
//     install this is.
//   - Functions return structured results, never throw on
//     "service isn't loaded" / "plist doesn't exist" type
//     conditions; callers want to render those as user-facing
//     status, not crashes.
//   - launchctl invocations are quoted carefully — checkout
//     paths can have spaces.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDevelopmentCheckout } from "./repo-root.js";

export const CANONICAL_DEV_LABEL = "ai.tianshu.dev";
export const PROD_LABEL = "ai.tianshu.prod";
/** Back-compat alias — some callers imported the old name. */
export const CANONICAL_LABEL = CANONICAL_DEV_LABEL;

/** What we know (or don't) about a launchd agent at any moment. */
export interface ServiceStatus {
  /** The label we resolved for this checkout. */
  label: string;
  /** Path the plist would live at, whether or not it exists. */
  plistPath: string;
  /** True if the plist file is on disk. */
  installed: boolean;
  /** True if launchctl knows about it (loaded). */
  loaded: boolean;
  /** PID of the running service, or null if not running. */
  pid: number | null;
  /** LastExitStatus reported by launchctl, when present. */
  lastExitStatus: number | null;
}

export interface LaunchdInstallOpts {
  repoRoot: string;
  serverPort: number;
  webPort: number;
  /**
   * Which npm script to invoke from the launchd plist.
   * - `dev` (default): full watch + rebuild pipeline. Only works
   *   from a git checkout with devDependencies installed (tsc,
   *   vite, etc.).
   * - `serve`: pre-built dist + static-host the web UI in the
   *   server process. The right choice when running from a
   *   global npm install where devDependencies aren't on disk.
   * Resolve at the wizard layer (we have isTianshuCheckout()
   *   there) and pass through here.
   */
  npmScript?: "dev" | "serve";
  /** Resolved npm path (output of `which npm`). Caller resolves
   *  this rather than us so wizard / service code can share the
   *  same fallback strategy and surface the same errors. */
  npmPath: string;
}

/**
 * Resolve the launchd label for a given tianshu install.
 *
 * Rules (matches the new docstring in the module header):
 *   1. Install path is NOT a git checkout (i.e. coming from
 *      `npm install -g @tianshu-ai/tianshu`) → `ai.tianshu.prod`.
 *      One install of the published package per machine; no
 *      hash. nvm version bumps don't change this any more.
 *   2. Install path IS a git checkout → try `ai.tianshu.dev`.
 *      If no `.plist` with that name exists, or the existing one
 *      already points at the same WorkingDirectory, we own it.
 *      If another checkout already claimed it, fall through to
 *      `ai.tianshu.dev.<hash8>` to coexist without collision.
 *
 * This is a behaviour change from earlier versions, which
 * stamped every install with a hash (so `npm install -g`
 * upgrades that moved the path — e.g. nvm version bumps —
 * looked like "the id changed". After this rewrite, the prod
 * id is constant.
 */
export function resolveLabel(repoRoot: string): string {
  const home = os.homedir();
  if (!isDevelopmentCheckout(repoRoot)) {
    return PROD_LABEL;
  }
  const canonicalPlist = path.join(
    home,
    "Library",
    "LaunchAgents",
    `${CANONICAL_DEV_LABEL}.plist`,
  );

  // Case 1: no canonical dev plist exists yet → claim it.
  if (!fs.existsSync(canonicalPlist)) return CANONICAL_DEV_LABEL;

  // Case 2: a canonical dev plist exists. If it's ours (same
  // WorkingDirectory), keep using it. Otherwise we're a
  // secondary checkout → fall back to the hashed label so two
  // clones can coexist.
  try {
    const body = fs.readFileSync(canonicalPlist, "utf8");
    const match = body.match(
      /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/,
    );
    if (match && path.resolve(match[1]) === path.resolve(repoRoot)) {
      return CANONICAL_DEV_LABEL;
    }
  } catch {
    // unreadable plist — treat it as someone else's, fall through
  }
  const hash = createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return `${CANONICAL_DEV_LABEL}.${hash}`;
}

/**
 * Find stale plist files in ~/Library/LaunchAgents/ that
 * point at this same install path but use an older label
 * scheme. Returns the list of labels to clean up.
 *
 * Background: before this version, every install got a
 * hash-suffixed label (ai.tianshu.dev.<8hex>). The hash was
 * computed over the install's absolute path, so:
 *   - nvm upgrades that changed the node version directory
 *     produced a new hash → a new orphan plist on every node
 *     bump.
 *   - the new prod / dev label scheme (this version) would
 *     leave the old hash plist behind even when nothing else
 *     changed.
 * The migration: when `tianshu start` resolves a new label for
 * a given install path, scan for any other plist whose
 * WorkingDirectory matches the SAME install path. Those are
 * orphans by definition (one install, one plist). Bootout and
 * unlink them so we don't leave duplicates fighting over the
 * same port.
 *
 * Returns `[]` when there's nothing to clean. Best-effort: a
 * plist we can't read is skipped, not treated as an orphan.
 */
export function findOrphanedLabels(
  currentLabel: string,
  installPath: string,
): Array<{ label: string; plistPath: string; workingDir: string }> {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  if (!fs.existsSync(dir)) return [];
  const normalisedInstall = path.resolve(installPath);
  const orphans: Array<{
    label: string;
    plistPath: string;
    workingDir: string;
  }> = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith("ai.tianshu.")) continue;
    if (!entry.endsWith(".plist")) continue;
    const label = entry.slice(0, -".plist".length);
    if (label === currentLabel) continue;
    const plistPath = path.join(dir, entry);
    let body: string;
    try {
      body = fs.readFileSync(plistPath, "utf8");
    } catch {
      continue;
    }
    const match = body.match(
      /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/,
    );
    if (!match) continue;
    const workingDir = path.resolve(match[1]);
    if (workingDir === normalisedInstall) {
      orphans.push({ label, plistPath, workingDir });
    }
  }
  return orphans;
}

export function plistPathFor(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * Stable, user-scoped log directory. We deliberately do *not*
 * use os.tmpdir() here:
 *   - macOS gives each process its own per-user tmp
 *     (`/var/folders/...`), but launchd renders the plist
 *     literally and the *running* process needs the same
 *     path the *agent* (running outside any sandbox) uses
 *     when redirecting stdio.
 *   - Worse, sandboxed runtimes (e.g. OpenClaw) override
 *     `os.tmpdir()` to point inside the sandbox, so the
 *     wizard would write a plist with `~/.openclaw/tmp/...`
 *     that the user can't read from a normal shell.
 * `~/Library/Logs/tianshu/` is the macOS-conventional spot
 * (Console.app surfaces it under "User Reports"), is stable
 * across processes, and survives reboots.
 */
function tianshuLogDir(): string {
  return path.join(os.homedir(), "Library", "Logs", "tianshu");
}

export function logPathsFor(label: string): { out: string; err: string } {
  const dir = tianshuLogDir();
  return {
    out: path.join(dir, `${label}.out.log`),
    err: path.join(dir, `${label}.err.log`),
  };
}

/**
 * Read the current state of the agent. Never throws — every
 * "thing isn't there" condition becomes a `false` / `null`
 * field so callers can render a useful summary.
 */
export function readStatus(label: string): ServiceStatus {
  const plistPath = plistPathFor(label);
  const installed = fs.existsSync(plistPath);
  let loaded = false;
  let pid: number | null = null;
  let lastExitStatus: number | null = null;
  try {
    const out = execSync(`launchctl list ${shellQuote(label)}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    loaded = true;
    const pidLine = out.match(/"PID"\s*=\s*(\d+);/);
    if (pidLine) pid = Number.parseInt(pidLine[1], 10);
    const exitLine = out.match(/"LastExitStatus"\s*=\s*(-?\d+);/);
    if (exitLine) lastExitStatus = Number.parseInt(exitLine[1], 10);
  } catch {
    // not loaded — that's fine
  }
  return { label, plistPath, installed, loaded, pid, lastExitStatus };
}

/**
 * Render the plist body. Pure — no side effects.
 */
export function renderPlist(
  label: string,
  opts: LaunchdInstallOpts,
): string {
  const { out: logFile, err: errFile } = logPathsFor(label);
  const npmBinDir = path.dirname(opts.npmPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${opts.npmPath}</string>
        <string>run</string>
        <string>${opts.npmScript ?? "dev"}</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${opts.repoRoot}</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${logFile}</string>
    <key>StandardErrorPath</key>
    <string>${errFile}</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${npmBinDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin</string>
        <key>HOME</key>
        <string>${os.homedir()}</string>
        <key>NODE_OPTIONS</key>
        <string>--no-warnings</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`;
}

/**
 * Write the plist (creating ~/Library/LaunchAgents and the
 * shared log dir if needed). Idempotent.
 */
export function writePlist(label: string, body: string): string {
  const plistPath = plistPathFor(label);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, body, { mode: 0o644 });
  // Pre-create the log directory so launchd doesn't fail to
  // open StandardOutPath / StandardErrorPath on the very first
  // boot. (launchd will happily create the file, but not the
  // parent directory.)
  fs.mkdirSync(tianshuLogDir(), { recursive: true });
  return plistPath;
}

/**
 * Resolve `which npm`, with a sane fallback. Shared between
 * wizard install and `tianshu restart` (which has to re-render
 * the plist if WorkingDirectory or npm path changed).
 */
export function resolveNpmPath(): string {
  try {
    return execSync("which npm", { encoding: "utf8" }).trim();
  } catch {
    return "/usr/bin/env npm";
  }
}

// ─── launchctl wrappers ────────────────────────────────────────────
//
// These intentionally don't try to be clever. They run launchctl,
// throw on failure (with the captured stderr), and let callers
// decide what to do. `readStatus` is the swallow-errors helper;
// these are the action verbs.

function shellQuote(s: string): string {
  // launchctl arguments are POSIX-shell-parsed by execSync. We
  // avoid spaces & metacharacters in our own outputs, but
  // checkout paths from users can have anything.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function uid(): string {
  return String(os.userInfo().uid);
}

export interface LaunchctlResult {
  ok: boolean;
  stderr?: string;
}

/** `launchctl bootstrap gui/<uid> <plist>` — load + start. */
export function bootstrap(plistPath: string): LaunchctlResult {
  return runLaunchctl(`bootstrap gui/${uid()} ${shellQuote(plistPath)}`);
}

/** `launchctl bootout gui/<uid>/<label>` — stop + unload. */
export function bootout(label: string): LaunchctlResult {
  return runLaunchctl(`bootout gui/${uid()}/${shellQuote(label)}`);
}

/** `launchctl kickstart -k gui/<uid>/<label>` — restart. */
export function kickstart(label: string): LaunchctlResult {
  return runLaunchctl(`kickstart -k gui/${uid()}/${shellQuote(label)}`);
}

function runLaunchctl(args: string): LaunchctlResult {
  try {
    execSync(`launchctl ${args}`, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    return {
      ok: false,
      stderr: e.stderr ? e.stderr.toString() : e.message,
    };
  }
}

/**
 * Lightweight HTTP probe of /api/health, used by `tianshu status`
 * and `start --wait`. Times out fast (default 2s) so the CLI
 * stays snappy when the server is wedged.
 */
export interface HealthResult {
  ok: boolean;
  status?: string;
  uptimeSec?: number;
  tenants?: number;
  /** Why we couldn't tell — populated when ok=false. */
  reason?: string;
}

export async function probeHealth(
  serverPort: number,
  timeoutMs = 2000,
): Promise<HealthResult> {
  const url = `http://localhost:${serverPort}/api/health`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      status: typeof body.status === "string" ? body.status : undefined,
      uptimeSec:
        typeof body.uptimeSec === "number" ? body.uptimeSec : undefined,
      tenants: typeof body.tenants === "number" ? body.tenants : undefined,
    };
  } catch (err) {
    clearTimeout(t);
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Block until /api/health responds OK (or deadline hits).
 * Returns true on success. Used by `tianshu start --wait` and
 * the wizard.
 *
 * Optional `onProgress` fires once a second with the elapsed
 * deadline. The CLI uses it to update its spinner so users
 * watching the wait know we're still alive (cold builds take
 * ~90s, agent / user otherwise panics around 30-40s).
 */
export async function waitForHealth(
  serverPort: number,
  deadlineMs: number,
  onProgress?: (elapsedMs: number, deadlineMs: number) => void,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = await probeHealth(serverPort);
    if (r.ok) return true;
    onProgress?.(Date.now() - start, deadlineMs);
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
