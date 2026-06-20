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
//   - Label is derived from the checkout path (`ai.tianshu.dev`
//     for canonical-looking checkouts, `ai.tianshu.dev.<hash>`
//     for everything else). This lets a developer with multiple
//     clones run them side by side without label collisions —
//     which is exactly the situation that motivated this whole
//     refactor (yuyu had a `tianshu` clone and a
//     `tianshu_opensource` clone, both wanted the dev label).
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

export const CANONICAL_LABEL = "ai.tianshu.dev";

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
  /** Resolved npm path (output of `which npm`). Caller resolves
   *  this rather than us so wizard / service code can share the
   *  same fallback strategy and surface the same errors. */
  npmPath: string;
}

/**
 * Resolve the launchd label for a given tianshu checkout.
 *
 * Convention:
 *   - The "primary" checkout (the one whose canonical install
 *     path is `~/git/tianshu` or whatever the user picks first)
 *     gets the bare label `ai.tianshu.dev` — readable, easy.
 *   - Any other checkout gets `ai.tianshu.dev.<hash8>`, where
 *     hash8 is the first 8 hex chars of sha256(repoRoot). This
 *     guarantees:
 *       * stable label per checkout (idempotent re-installs),
 *       * no collision with another checkout (`tianshu_opensource`
 *         vs old closed-source `tianshu`),
 *       * predictable `tianshu status` output.
 *
 * "Primary" is whichever checkout claimed the bare label first —
 * we detect that by reading the existing plist (if any) and
 * comparing its WorkingDirectory to ours.
 */
export function resolveLabel(repoRoot: string): string {
  const home = os.homedir();
  const canonicalPlist = path.join(
    home,
    "Library",
    "LaunchAgents",
    `${CANONICAL_LABEL}.plist`,
  );

  // Case 1: no canonical plist exists yet → we claim it.
  if (!fs.existsSync(canonicalPlist)) return CANONICAL_LABEL;

  // Case 2: a canonical plist exists. If it's ours (same
  // WorkingDirectory), keep using it. Otherwise we're a
  // secondary checkout → derive a hashed label.
  try {
    const body = fs.readFileSync(canonicalPlist, "utf8");
    const match = body.match(
      /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/,
    );
    if (match && path.resolve(match[1]) === path.resolve(repoRoot)) {
      return CANONICAL_LABEL;
    }
  } catch {
    // unreadable plist — treat it as someone else's, fall through
  }
  const hash = createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return `${CANONICAL_LABEL}.${hash}`;
}

export function plistPathFor(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function logPathsFor(label: string): { out: string; err: string } {
  return {
    out: path.join(os.tmpdir(), `${label}.out.log`),
    err: path.join(os.tmpdir(), `${label}.err.log`),
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
        <string>dev</string>
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
 * Write the plist (creating ~/Library/LaunchAgents if needed).
 * Idempotent.
 */
export function writePlist(label: string, body: string): string {
  const plistPath = plistPathFor(label);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, body, { mode: 0o644 });
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
 */
export async function waitForHealth(
  serverPort: number,
  deadlineMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const r = await probeHealth(serverPort);
    if (r.ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
