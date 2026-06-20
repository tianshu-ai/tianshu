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

const HEALTH_DEADLINE_MS = 60_000;

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
    process.stdout.write(`Waiting for /api/health on :${port}...`);
    const ok = await launchd.waitForHealth(
      port,
      opts.waitMs ?? HEALTH_DEADLINE_MS,
    );
    process.stdout.write(ok ? " up.\n" : " timed out.\n");
    if (!ok) {
      console.error(
        `Server didn't respond within ${
          (opts.waitMs ?? HEALTH_DEADLINE_MS) / 1000
        }s. Check logs:`,
      );
      console.error(`  tail -f ${launchd.logPathsFor(label).err}`);
      return 1;
    }
  }
  return 0;
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
    process.stdout.write(`Waiting for /api/health on :${port}...`);
    const ok = await launchd.waitForHealth(
      port,
      opts.waitMs ?? HEALTH_DEADLINE_MS,
    );
    process.stdout.write(ok ? " up.\n" : " timed out.\n");
    if (!ok) return 1;
  }
  return 0;
}
