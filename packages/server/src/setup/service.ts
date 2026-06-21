// `tianshu start|stop|restart|status` — service lifecycle on
// the host's process supervisor.
//
// macOS: backed by launchd via launchd.ts.
// Linux / Windows: graceful "not implemented yet — here's the
//   command you'd run by hand" message. The wizard's
//   start-server.ts already has the same fallback for install;
//   we keep parity here so users get a consistent experience.
//
// Why these as separate commands rather than baking them into
// `tianshu setup --wizard`:
//   - day 2 you want `tianshu restart` after editing config; you
//     don't want to walk through the whole wizard
//   - `tianshu status` is the cheap "is it up?" check; doctor
//     does the deep version
//   - keeps the wizard focused on first-time install
//
// Note: install (writing the plist + bootstrapping the first
// time) lives in start-server.ts because it needs to interact
// with port selection, .env writes, and the wizard's prompt UI.
// `tianshu start` here only operates on an *already installed*
// agent — if the plist doesn't exist, we tell the user to run
// the wizard.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import * as launchd from "./launchd.js";
import { findRepoRoot } from "./repo-root.js";
import { loadGlobalConfig } from "../core/config.js";

const DEFAULT_SERVER_PORT = 3110;

interface ServiceCmdOpts {
  /** Override repo root (used by tests). */
  repoRoot?: string;
  /** Wait for /api/health after start/restart. */
  wait?: boolean;
  /** Health-check deadline in ms. Default 60s. */
  waitMs?: number;
  /** When set, emit machine-readable JSON instead of human text. */
  json?: boolean;
}

export interface LogsCmdOpts extends ServiceCmdOpts {
  /** stream: follow new lines (`tail -f`) until Ctrl-C. */
  follow?: boolean;
  /** how many trailing lines to print up front. Default 50. */
  lines?: number;
  /** which stream(s) to read. Default "both" (interleaved by
   *  modification — we just print err then out). */
  stream?: "out" | "err" | "both";
}

// 120 seconds. Cold-start the dev server has to: npm-build
// plugin-sdk, build 4 plugins, sync builtin configs, run
// dev-builtins migration, tsx watch + compile server src,
// then plugins activate. Observed: 90-110s on M3 Ultra (faster)
// and 60-90s on i070219 Intel mac. The previous 60s deadline
// hit `timed out` regularly even though the server came up
// 30s later. Match the wizard's deadline (start-server.ts) to
// stay consistent.
const HEALTH_DEADLINE_MS = 120_000;

/**
 * Resolve the server port the same way the wizard / network
 * doctor does — env first, then global config, then default.
 * Used by `tianshu status` to know where to probe health.
 */
function resolveServerPort(repoRoot?: string): number {
  const env = Number.parseInt(process.env.PORT ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  try {
    const cfg = loadGlobalConfig();
    if (cfg.server?.port) return cfg.server.port;
  } catch {
    // no global config yet
  }
  // We don't read .env here — the doctor's checkNetwork is the
  // authoritative source for that, and it runs in a different
  // process. For the CLI, env + global config + default is
  // good enough.
  void repoRoot;
  return DEFAULT_SERVER_PORT;
}

/**
 * `tianshu status` — print whether the service is installed,
 * loaded, running, and responding to /api/health.
 *
 * Exit codes:
 *   0 → installed AND loaded AND health OK
 *   1 → installed but not loaded / not responding
 *   2 → not installed
 */
export async function runStatus(
  opts: ServiceCmdOpts = {},
): Promise<number> {
  if (os.platform() !== "darwin") {
    console.log(
      "tianshu status: service management isn't implemented on this OS yet.",
    );
    return 1;
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const label = launchd.resolveLabel(repoRoot);
  const status = launchd.readStatus(label);
  const port = resolveServerPort(repoRoot);
  const health = status.loaded
    ? await launchd.probeHealth(port)
    : { ok: false, reason: "service not loaded" };

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          label,
          plistPath: status.plistPath,
          installed: status.installed,
          loaded: status.loaded,
          pid: status.pid,
          lastExitStatus: status.lastExitStatus,
          serverPort: port,
          health,
        },
        null,
        2,
      ),
    );
  } else {
    const lines: string[] = [];
    lines.push(`label:        ${label}`);
    lines.push(`plist:        ${status.plistPath}`);
    lines.push(`installed:    ${status.installed ? "yes" : "no"}`);
    lines.push(`loaded:       ${status.loaded ? "yes" : "no"}`);
    if (status.pid !== null) lines.push(`pid:          ${status.pid}`);
    if (status.lastExitStatus !== null)
      lines.push(`last exit:    ${status.lastExitStatus}`);
    lines.push(`server port:  ${port}`);
    if (health.ok) {
      lines.push(
        `health:       ok (status=${health.status}, uptime=${
          health.uptimeSec ?? "?"
        }s, tenants=${health.tenants ?? "?"})`,
      );
    } else {
      lines.push(`health:       not responding (${health.reason ?? "?"})`);
    }
    if (!status.installed) {
      lines.push("");
      lines.push(
        "Service isn't installed. Run `tianshu setup --wizard` to install.",
      );
    } else if (!status.loaded) {
      lines.push("");
      lines.push("Service is installed but not loaded. Start it with:");
      lines.push("  tianshu start");
    }
    console.log(lines.join("\n"));
  }

  if (!status.installed) return 2;
  if (!status.loaded || !health.ok) return 1;
  return 0;
}

/**
 * `tianshu start` — bootstrap the launchd agent.
 * No-op (with friendly message) if already loaded.
 */
export async function runStart(
  opts: ServiceCmdOpts = {},
): Promise<number> {
  if (os.platform() !== "darwin") {
    console.log(
      "tianshu start: not implemented on this OS yet. Run `npm run dev` from the checkout.",
    );
    return 1;
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const label = launchd.resolveLabel(repoRoot);
  const status = launchd.readStatus(label);
  if (!status.installed) {
    console.error(
      `Service '${label}' isn't installed (no plist at ${status.plistPath}).`,
    );
    console.error("Run `tianshu setup --wizard` to install.");
    return 2;
  }
  if (status.loaded) {
    console.log(
      `Service '${label}' is already loaded (pid ${status.pid ?? "?"}). ` +
        "Use `tianshu restart` to bounce it.",
    );
    return 0;
  }
  const r = launchd.bootstrap(status.plistPath);
  if (!r.ok) {
    console.error(`launchctl bootstrap failed: ${r.stderr ?? "(unknown)"}`);
    return 1;
  }
  console.log(`Loaded ${label}.`);
  if (opts.wait !== false) {
    const port = resolveServerPort(repoRoot);
    const deadlineMs = opts.waitMs ?? HEALTH_DEADLINE_MS;
    const ok = await waitWithProgress(port, deadlineMs);
    if (!ok) {
      console.error(
        `\nServer didn't respond within ${deadlineMs / 1000}s. Check logs:`,
      );
      console.error(`  tianshu logs --stream=err`);
      console.error(`  tail -f ${launchd.logPathsFor(label).err}`);
      return 1;
    }
  }
  return 0;
}

/**
 * Render "Waiting for /api/health on :3110... [12s elapsed]"
 * with the elapsed counter overwriting itself each second.
 * Users / agents watching the wait can see we're alive and how
 * long they've waited — first-time installs commonly take
 * 90+s, easy to think things wedged otherwise.
 */
async function waitWithProgress(
  port: number,
  deadlineMs: number,
): Promise<boolean> {
  const prefix = `Waiting for /api/health on :${port}...`;
  process.stdout.write(prefix);
  let lastLine = prefix.length;
  const ok = await launchd.waitForHealth(port, deadlineMs, (elapsedMs) => {
    const elapsedSec = Math.floor(elapsedMs / 1000);
    const totalSec = Math.floor(deadlineMs / 1000);
    const next = ` ${elapsedSec}s / ${totalSec}s`;
    // Carriage return + overwrite. Pad to last width to clear
    // older digits if the new line is shorter.
    process.stdout.write(`\r${prefix}${next}`);
    lastLine = prefix.length + next.length;
    void lastLine;
  });
  process.stdout.write(ok ? " up.\n" : " timed out.\n");
  return ok;
}

/**
 * `tianshu stop` — bootout the launchd agent. Plist stays put;
 * use the wizard's uninstall path (TODO) to fully remove.
 */
export async function runStop(opts: ServiceCmdOpts = {}): Promise<number> {
  if (os.platform() !== "darwin") {
    console.log(
      "tianshu stop: not implemented on this OS yet. Stop your `npm run dev` process manually.",
    );
    return 1;
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const label = launchd.resolveLabel(repoRoot);
  const status = launchd.readStatus(label);
  if (!status.loaded) {
    console.log(`Service '${label}' is not loaded — nothing to stop.`);
    return 0;
  }
  const r = launchd.bootout(label);
  if (!r.ok) {
    console.error(`launchctl bootout failed: ${r.stderr ?? "(unknown)"}`);
    return 1;
  }
  console.log(`Stopped ${label}.`);
  return 0;
}

/**
 * `tianshu restart` — `launchctl kickstart -k`. Faster than
 * stop-then-start because it doesn't rebootstrap the plist.
 */
/**
 * `tianshu logs` — print the launchd agent's stdout / stderr
 * logs. Default: last 50 lines from both streams. With
 * `--follow`, we exec `tail -f` so the user gets streaming
 * output (and Ctrl-C falls through naturally).
 *
 * Why this command exists: when `tianshu start` says "Server
 * didn't respond within 120s", the next thing both the user
 * and a debugging agent want is the actual error from the
 * failed boot. Without `tianshu logs`, you have to know the
 * label *and* the convention that logs live in $TMPDIR. Now
 * it's just `tianshu logs` (or `tianshu logs --follow`).
 */
export async function runLogs(opts: LogsCmdOpts = {}): Promise<number> {
  if (os.platform() !== "darwin") {
    console.log(
      "tianshu logs: not implemented on this OS yet. Read the dev server's stdout directly.",
    );
    return 1;
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const label = launchd.resolveLabel(repoRoot);
  const { out, err } = launchd.logPathsFor(label);
  const stream = opts.stream ?? "both";
  const lines = opts.lines ?? 50;

  // Pick which files we care about, in print order.
  const files: string[] = [];
  if (stream === "both" || stream === "err") files.push(err);
  if (stream === "both" || stream === "out") files.push(out);

  // Friendly preflight — if neither file exists, give the user
  // an actionable message rather than letting `tail` print
  // "No such file". Most common reason: service was never
  // installed on this machine.
  const present = files.filter((f) => fs.existsSync(f));
  if (present.length === 0) {
    console.error(`No log files found for service '${label}'.`);
    console.error(`  expected: ${err}`);
    console.error(`            ${out}`);
    const status = launchd.readStatus(label);
    if (!status.installed) {
      console.error(
        "\nService isn't installed. Run `tianshu setup --wizard` first.",
      );
    } else if (!status.loaded) {
      console.error(
        "\nService is installed but never started. Try `tianshu start`.",
      );
    } else {
      console.error(
        "\nService is loaded but hasn't written any logs yet. Wait a few seconds and retry.",
      );
    }
    return 1;
  }

  if (opts.follow) {
    // Hand off to `tail -f`. We use spawn (not exec) so the
    // user's Ctrl-C kills tail directly; `tail` then exits and
    // we propagate its code. -F (capital) re-opens on rotation,
    // which matters when KeepAlive bounces the agent and
    // launchd truncates / replaces the log file.
    return new Promise<number>((resolve) => {
      const args = ["-n", String(lines), "-F", ...present];
      const child = spawn("tail", args, { stdio: "inherit" });
      child.on("error", (e) => {
        console.error(`tail failed: ${e.message}`);
        resolve(1);
      });
      child.on("exit", (code) => resolve(code ?? 0));
    });
  }

  // Non-follow: print the last N lines from each file with a
  // header so the user can tell which stream they're reading.
  for (const f of present) {
    const label = f === err ? "stderr" : "stdout";
    console.log(`==> ${label} (${f}) <==`);
    console.log(tailFile(f, lines));
    console.log("");
  }
  return 0;
}

function tailFile(filepath: string, n: number): string {
  try {
    const body = fs.readFileSync(filepath, "utf8");
    return body.split(/\r?\n/).slice(-n).join("\n");
  } catch (e) {
    return `(unreadable: ${(e as Error).message})`;
  }
}

export async function runRestart(
  opts: ServiceCmdOpts = {},
): Promise<number> {
  if (os.platform() !== "darwin") {
    console.log("tianshu restart: not implemented on this OS yet.");
    return 1;
  }
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const label = launchd.resolveLabel(repoRoot);
  const status = launchd.readStatus(label);
  if (!status.installed) {
    console.error(`Service '${label}' isn't installed.`);
    console.error("Run `tianshu setup --wizard` to install.");
    return 2;
  }
  if (!status.loaded) {
    // kickstart on a not-loaded service errors. Prefer the
    // start path (which bootstraps).
    return runStart(opts);
  }
  const r = launchd.kickstart(label);
  if (!r.ok) {
    console.error(`launchctl kickstart failed: ${r.stderr ?? "(unknown)"}`);
    return 1;
  }
  console.log(`Restarted ${label}.`);
  if (opts.wait !== false) {
    const port = resolveServerPort(repoRoot);
    const deadlineMs = opts.waitMs ?? HEALTH_DEADLINE_MS;
    const ok = await waitWithProgress(port, deadlineMs);
    if (!ok) {
      console.error(`\nIf this is a fresh build the cold start can exceed ${deadlineMs / 1000}s.`);
      console.error(`Check logs:  tianshu logs --stream=err`);
      return 1;
    }
  }
  return 0;
}
