// Final setup step: pick ports, install + load a launchd agent
// (macOS) or fall back to a manual command (other platforms),
// verify /api/health responds.
//
// Why launchd rather than a foreground spawn:
//   - it survives terminal close, reboot, crashes (KeepAlive)
//   - it's the documented permanent-install path on macOS (see
//     docs/running.md), so the wizard producing the same plist
//     means there's only one way to run tianshu in dev/prod
//   - cross-platform we still fall back to telling the user the
//     command to run; only macOS gets auto-install
//
// What this module does NOT do:
//   - install on Linux (systemd --user is a separate task; we
//     emit a hint and skip)
//   - generate a *production* plist (workspace path is hard-coded
//     to the current checkout, server runs `npm run dev` not a
//     bundled `npm start` — fine for the dev wizard, will revisit
//     when 0.x publishes to npm)

import * as p from "@clack/prompts";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as launchd from "./launchd.js";
import {
  findRepoRoot,
  isTianshuCheckout,
  isDevelopmentCheckout,
} from "./repo-root.js";

interface StartServerOpts {
  /** Repo root (used as cwd for `npm run dev`). Defaults to process.cwd(). */
  repoRoot?: string;
  /** Path to the .env file we write PORT / WEB_PORT into. */
  envPath?: string;
}

const DEFAULT_SERVER_PORT = 3110;
const DEFAULT_WEB_PORT = 5183;
const HEALTH_CHECK_DEADLINE_MS = 120_000;

/**
 * Run the start-server step. Idempotent: bails out cleanly if
 * the user says "no, I'll start it myself", and detects an
 * existing launchd agent so re-running the wizard doesn't
 * create duplicates.
 */
export interface StartServerResult {
  /** http://localhost:<port> when the server is up, null when skipped. */
  serverUrl: string | null;
  /** Web UI URL (vite). null when skipped. */
  webUrl: string | null;
  /** True when the user accepted auto-start AND health-check passed. */
  started: boolean;
}

const SKIPPED: StartServerResult = {
  serverUrl: null,
  webUrl: null,
  started: false,
};

export async function runStartServer(
  opts: StartServerOpts = {},
): Promise<StartServerResult> {
  // Find the tianshu checkout the CLI is running from. Users
  // typically run `tianshu setup` from their home dir, so
  // process.cwd() won't be the repo. Walk up from this module's
  // location until we hit a package.json named
  // '@tianshu-ai/tianshu' (or run out of parents).
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const envPath = opts.envPath ?? path.join(repoRoot, ".env");

  if (!isTianshuCheckout(repoRoot)) {
    p.log.info(
      [
        "Server auto-start skipped: this CLI isn't running from a tianshu checkout.",
        `(Looked for a tianshu package.json at ${repoRoot}.)`,
        "",
        "Once 0.x publishes to npm, `tianshu start` will spawn the server",
        "directly. For now, clone the repo and run `npm run dev` there.",
      ].join("\n"),
    );
    return SKIPPED;
  }

  // Detect existing service before asking. The original wizard
  // always asked "Start the dev server now?" even when launchd
  // already had one running and /api/health was returning 200.
  // Three buckets:
  //
  //   A. plist installed + loaded + /api/health ok
  //      → do nothing, tell the user where it is, return started=true
  //   B. plist installed + not loaded (or unhealthy)
  //      → offer `tianshu start` / `tianshu restart`, don't reinstall
  //   C. nothing installed
  //      → the original flow: pick ports, install plist, bootstrap
  //
  // Only bucket C is the "new install" path; A and B should not
  // pretend the user is starting fresh.
  const existing = await detectExistingService(repoRoot);
  if (existing.kind === "healthy") {
    const linesOut: string[] = [
      `Tianshu is already running under launchd as '${existing.label}'.`,
    ];
    if (existing.webPort !== undefined) {
      linesOut.push(`  Web UI:  http://localhost:${existing.webPort}`);
    }
    linesOut.push(`  API:     ${existing.serverUrl}`);
    linesOut.push(
      ``,
      `Manage with: tianshu start | stop | restart | status | logs`,
    );
    p.log.success(linesOut.join("\n"));
    return {
      serverUrl: existing.serverUrl,
      webUrl:
        existing.webPort !== undefined
          ? `http://localhost:${existing.webPort}`
          : null,
      started: true,
    };
  }

  if (existing.kind === "installed-not-running") {
    p.log.info(
      [
        `A launchd plist already exists at ${existing.plistPath}, but the service isn't responding.`,
        existing.statusDetail ? `  status: ${existing.statusDetail}` : null,
        ``,
        `Likely your existing install just needs a (re)start, not a fresh setup.`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const action = await p.select({
      message: "What do you want to do?",
      options: [
        {
          value: "restart",
          label: "Restart the existing service (recommended)",
        },
        {
          value: "reinstall",
          label: "Reinstall (pick new ports + overwrite plist)",
        },
        { value: "skip", label: "Skip — I'll manage it myself" },
      ],
      initialValue: "restart",
    });
    if (p.isCancel(action) || action === "skip") {
      p.log.info(
        [
          "Leaving the existing plist in place. Useful commands:",
          `  tianshu status   # what does launchd think?`,
          `  tianshu logs     # why isn't it responding?`,
          `  tianshu restart  # bounce it`,
        ].join("\n"),
      );
      return SKIPPED;
    }
    if (action === "restart") {
      const r = launchd.kickstart(existing.label);
      if (!r.ok) {
        p.log.error(
          `launchctl kickstart failed: ${r.stderr ?? "(unknown)"}`,
        );
        return SKIPPED;
      }
      const port = existing.serverPort ?? DEFAULT_SERVER_PORT;
      const spinner = p.spinner();
      spinner.start(`Waiting for /api/health on :${port}...`);
      const ok = await launchd.waitForHealth(
        port,
        HEALTH_CHECK_DEADLINE_MS,
      );
      if (!ok) {
        spinner.stop(`\u2717 Server didn't come up after restart.`);
        p.log.info(`Run \`tianshu logs\` to see why.`);
        return SKIPPED;
      }
      spinner.stop(`\u2713 Server is up on http://localhost:${port}.`);
      return {
        serverUrl: `http://localhost:${port}`,
        webUrl: existing.webPort
          ? `http://localhost:${existing.webPort}`
          : null,
        started: true,
      };
    }
    // action === "reinstall" — fall through to the install flow.
    // Boot out the old service so the install path can rewrite
    // the plist cleanly.
    launchd.bootout(existing.label);
    p.log.info(`Stopped existing '${existing.label}' to make way for reinstall.`);
  }

  // Bucket C: nothing installed (or user picked reinstall above).
  const wantStart = await p.confirm({
    message: "Start the dev server now?",
    initialValue: true,
  });
  if (p.isCancel(wantStart) || wantStart === false) {
    p.log.info(
      [
        "Skipping auto-start. When you're ready:",
        `  cd ${repoRoot}`,
        "  npm run dev",
      ].join("\n"),
    );
    return SKIPPED;
  }

  // Pick ports.
  const serverPort = await pickPort(
    "Server port (the API + WebSocket):",
    DEFAULT_SERVER_PORT,
  );
  if (serverPort === null) {
    p.log.warn("Aborted port selection. Skipping start.");
    return SKIPPED;
  }
  const webPort = await pickPort(
    "Web port (the dev UI you'll open in a browser):",
    DEFAULT_WEB_PORT,
  );
  if (webPort === null) {
    p.log.warn("Aborted port selection. Skipping start.");
    return SKIPPED;
  }

  // Persist the ports.
  writeEnvVar(envPath, "PORT", String(serverPort));
  writeEnvVar(envPath, "WEB_PORT", String(webPort));
  p.log.success(
    `Wrote PORT=${serverPort}, WEB_PORT=${webPort} to ${envPath}`,
  );

  // Cross-platform branch.
  const platform = os.platform();
  if (platform === "darwin") {
    return startViaLaunchd({ repoRoot, serverPort, webPort });
  }
  p.log.info(
    [
      `Auto-start via service manager isn't implemented yet on ${platform}.`,
      "",
      "On Linux the recommended path is a systemd --user unit; the template",
      "is in docs/running.md (TODO section).",
      "",
      "For now, run the dev server in a separate terminal:",
      `  cd ${repoRoot}`,
      "  npm run dev",
    ].join("\n"),
  );
  return SKIPPED;
}

interface LaunchdStartOpts {
  repoRoot: string;
  serverPort: number;
  webPort: number;
}

async function startViaLaunchd(
  opts: LaunchdStartOpts,
): Promise<StartServerResult> {
  // Resolve a stable label for this checkout. First checkout to
  // run the wizard claims the canonical `ai.tianshu.dev`; later
  // checkouts get a hashed suffix so they coexist instead of
  // stomping the original plist. See launchd.resolveLabel.
  const label = launchd.resolveLabel(opts.repoRoot);
  const plistPath = launchd.plistPathFor(label);
  const { out: logFile, err: errFile } = launchd.logPathsFor(label);

  // If a plist already exists from a previous wizard run / manual
  // install, ask before clobbering it. Most users will say yes
  // (they want the new ports), but we want consent.
  if (fs.existsSync(plistPath)) {
    const replace = await p.confirm({
      message: `A launchd plist already exists at ${plistPath}. Replace it (and reload)?`,
      initialValue: true,
    });
    if (p.isCancel(replace) || replace === false) {
      p.log.info(
        [
          "Keeping the existing plist. To control the existing service:",
          `  tianshu start    # bootstrap if not loaded`,
          `  tianshu restart  # kickstart -k`,
          `  tianshu status   # full health view`,
        ].join("\n"),
      );
      return SKIPPED;
    }
    // Boot out the existing service before we overwrite the plist.
    launchd.bootout(label); // best-effort; not-loaded is fine
  }

  const npmPath = launchd.resolveNpmPath();
  // Pick the npm script based on where we're installed from.
  // Git checkout (devDependencies on disk) → `dev` runs the
  // full watch + rebuild pipeline. Global npm install (no
  // devDeps) → `serve` runs the pre-built dist instead. See
  // isDevelopmentCheckout's docstring for the heuristic.
  const npmScript: "dev" | "serve" = isDevelopmentCheckout(opts.repoRoot)
    ? "dev"
    : "serve";
  const plistBody = launchd.renderPlist(label, {
    repoRoot: opts.repoRoot,
    serverPort: opts.serverPort,
    webPort: opts.webPort,
    npmPath,
    npmScript,
  });
  launchd.writePlist(label, plistBody);
  p.log.success(`Wrote launchd plist → ${plistPath}`);

  // Bootstrap into launchd. RunAtLoad=true means it starts now;
  // KeepAlive on non-zero exit means it auto-restarts on crash.
  const bootRes = launchd.bootstrap(plistPath);
  if (!bootRes.ok) {
    p.log.error(
      [
        `launchctl bootstrap failed: ${bootRes.stderr ?? "(unknown)"}`,
        "",
        "You can retry with:",
        `  tianshu start`,
      ].join("\n"),
    );
    return SKIPPED;
  }
  p.log.success(`Loaded launchd agent ${label}.`);

  // Wait for /api/health.
  const healthSpinner = p.spinner();
  healthSpinner.start(
    `Waiting for the server to come up on http://localhost:${opts.serverPort}...`,
  );
  const ok = await launchd.waitForHealth(
    opts.serverPort,
    HEALTH_CHECK_DEADLINE_MS,
  );
  if (!ok) {
    healthSpinner.stop(
      `\u2717 Server didn't respond within ${HEALTH_CHECK_DEADLINE_MS / 1000}s.`,
    );
    p.log.error(
      [
        `Last 30 lines of ${errFile}:`,
        "",
        tailFile(errFile, 30) || "(empty)",
        "",
        "The launchd agent is still loaded; you can:",
        `  · check status:  tianshu status`,
        `  · tail logs:     tail -f ${logFile}`,
        `  · stop it:       tianshu stop`,
        "  · debug:         tianshu doctor",
      ].join("\n"),
    );
    return SKIPPED;
  }
  healthSpinner.stop(
    `\u2713 Server is up on http://localhost:${opts.serverPort}.`,
  );
  p.log.info(
    [
      `Tianshu is running under launchd as '${label}'.`,
      `  Web UI:  http://localhost:${opts.webPort}`,
      `  API:     http://localhost:${opts.serverPort}/api`,
      `  Logs:    ${logFile} / ${errFile}`,
      ``,
      `Manage with: tianshu start | stop | restart | status`,
    ].join("\n"),
  );
  return {
    serverUrl: `http://localhost:${opts.serverPort}`,
    webUrl: `http://localhost:${opts.webPort}`,
    started: true,
  };
}

// ─── helpers ───────────────────────────────────────────────────────

async function pickPort(
  message: string,
  preferred: number,
): Promise<number | null> {
  let suggestion = preferred;
  if (await isPortInUse(suggestion)) {
    suggestion = await findFreePort(preferred);
  }
  while (true) {
    const answer = await p.text({
      message,
      placeholder: String(suggestion),
      defaultValue: String(suggestion),
      validate: (raw) => {
        const v = Number.parseInt(String(raw).trim(), 10);
        if (!Number.isFinite(v) || v < 1 || v > 65535) {
          return "Enter a port number between 1 and 65535.";
        }
        return undefined;
      },
    });
    if (p.isCancel(answer)) return null;
    const port = Number.parseInt(String(answer).trim(), 10);
    if (await isPortInUse(port)) {
      const next = await findFreePort(port + 1);
      const useNext = await p.confirm({
        message: `Port ${port} is already in use. Use ${next} instead?`,
        initialValue: true,
      });
      if (p.isCancel(useNext)) return null;
      if (useNext === true) return next;
      continue;
    }
    return port;
  }
}

/**
 * Decide whether `port` is taken by *anyone* the new server
 * would conflict with. We probe both IPv4 (127.0.0.1) and IPv6
 * (::1) so a tianshu instance on the dual-stack catch-all
 * doesn't slip through.
 */
async function isPortInUse(port: number): Promise<boolean> {
  // First: try to actively connect. If something answers,
  // there's definitely a listener.
  if (await canConnect("127.0.0.1", port)) return true;
  if (await canConnect("::1", port)) return true;
  // Second: try to bind exclusively. If we can't, somebody else
  // owns the port even if they didn't answer our connect.
  if (!(await canBind(port))) return true;
  return false;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(800);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 50; p++) {
    if (!(await isPortInUse(p))) return p;
  }
  return start;
}

function writeEnvVar(envPath: string, key: string, value: string): void {
  let body = "";
  if (fs.existsSync(envPath)) body = fs.readFileSync(envPath, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(body)) {
    body = body.replace(re, line);
  } else {
    if (body.length > 0 && !body.endsWith(os.EOL)) body += os.EOL;
    body += line + os.EOL;
  }
  fs.writeFileSync(envPath, body, { mode: 0o600 });
}

function tailFile(filepath: string, lines: number): string {
  try {
    const body = fs.readFileSync(filepath, "utf8");
    const split = body.split(/\r?\n/);
    return split.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ─── existing-service detection ─────────────────────────────
//
// runStartServer used to ask "Start the dev server now?" every
// time, including the (very common) case where launchd already
// had the service up and /api/health was returning 200. Users
// re-run `tianshu setup` for many reasons that have nothing to
// do with restarting the server (rotate keys, enable plugins,
// add a tenant), and forcing them to either say no or accept a
// pointless restart was a paper cut.
//
// We classify the current state into one of three buckets and
// let the wizard's flow branch on it.

type ExistingService =
  | {
      kind: "healthy";
      label: string;
      serverUrl: string;
      serverPort: number;
      webPort?: number;
    }
  | {
      kind: "installed-not-running";
      label: string;
      plistPath: string;
      serverPort?: number;
      webPort?: number;
      statusDetail?: string;
    }
  | { kind: "not-installed" };

async function detectExistingService(
  repoRoot: string,
): Promise<ExistingService> {
  const label = launchd.resolveLabel(repoRoot);
  const status = launchd.readStatus(label);

  // Read the previously-chosen ports from the repo's .env. The
  // wizard always writes PORT/WEB_PORT there, so on a re-run
  // these tell us where to probe. Falls back to defaults so a
  // weird half-installed state still gets a useful answer.
  const envPorts = readEnvPorts(path.join(repoRoot, ".env"));
  const serverPort = envPorts.serverPort ?? DEFAULT_SERVER_PORT;
  const webPort = envPorts.webPort;

  if (!status.installed) return { kind: "not-installed" };

  // Plist exists. Find out if it's actually serving traffic.
  // launchctl loaded != server up: launchd may have just spawned
  // npm and we're 30s into a cold build.
  if (status.loaded) {
    const health = await launchd.probeHealth(serverPort, 1500);
    if (health.ok) {
      return {
        kind: "healthy",
        label,
        serverUrl: `http://localhost:${serverPort}`,
        serverPort,
        webPort,
      };
    }
    return {
      kind: "installed-not-running",
      label,
      plistPath: status.plistPath,
      serverPort,
      webPort,
      statusDetail: `launchd loaded (pid ${status.pid ?? "?"}) but /api/health: ${health.reason ?? "(no response)"}`,
    };
  }

  // Plist on disk but launchd hasn't loaded it (user ran
  // `tianshu stop`, or the service crashed past KeepAlive's
  // throttle).
  return {
    kind: "installed-not-running",
    label,
    plistPath: status.plistPath,
    serverPort,
    webPort,
    statusDetail: `launchd hasn't loaded the agent. Last exit: ${status.lastExitStatus ?? "unknown"}`,
  };
}

function readEnvPorts(
  envPath: string,
): { serverPort?: number; webPort?: number } {
  if (!fs.existsSync(envPath)) return {};
  try {
    const body = fs.readFileSync(envPath, "utf8");
    const out: { serverPort?: number; webPort?: number } = {};
    for (const rawLine of body.split(/\r?\n/)) {
      const m = rawLine.match(/^(PORT|WEB_PORT)\s*=\s*(.+)$/);
      if (!m) continue;
      const v = Number.parseInt(m[2].trim(), 10);
      if (!Number.isFinite(v)) continue;
      if (m[1] === "PORT") out.serverPort = v;
      else out.webPort = v;
    }
    return out;
  } catch {
    return {};
  }
}
