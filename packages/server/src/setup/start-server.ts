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
import { execSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface StartServerOpts {
  /** Repo root (used as cwd for `npm run dev`). Defaults to process.cwd(). */
  repoRoot?: string;
  /** Path to the .env file we write PORT / WEB_PORT into. */
  envPath?: string;
}

const DEFAULT_SERVER_PORT = 3110;
const DEFAULT_WEB_PORT = 5183;
const HEALTH_CHECK_DEADLINE_MS = 120_000;
const LAUNCHD_LABEL = "ai.tianshu.dev";

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
  const repoRoot = opts.repoRoot ?? findCheckoutRoot();
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
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${LAUNCHD_LABEL}.plist`,
  );
  const logFile = path.join(os.tmpdir(), `${LAUNCHD_LABEL}.out.log`);
  const errFile = path.join(os.tmpdir(), `${LAUNCHD_LABEL}.err.log`);

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
          "Keeping the existing plist. To start the existing service:",
          `  launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`,
          "",
          "Or to inspect:",
          `  launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`,
        ].join("\n"),
      );
      return SKIPPED;
    }
    // Boot out the existing service before we overwrite the plist.
    try {
      execSync(`launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`, {
        stdio: "ignore",
      });
    } catch {
      // already booted out / never loaded — that's fine
    }
  }

  // Resolve npm path. launchd doesn't inherit shell PATH, so we
  // need an absolute path. `which npm` from the user's shell is
  // the most reliable way; we fall back to `npm` if which fails.
  let npmPath: string;
  try {
    npmPath = execSync("which npm", { encoding: "utf8" }).trim();
  } catch {
    npmPath = "/usr/bin/env npm"; // last-ditch
  }

  // Render the plist. The PATH env entry derives from `which npm`
  // (its dirname) plus standard system paths so child npm scripts
  // can find node, tsx, etc.
  const npmBinDir = path.dirname(npmPath);
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${npmPath}</string>
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

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plistBody, { mode: 0o644 });
  p.log.success(`Wrote launchd plist → ${plistPath}`);

  // Bootstrap into launchd. RunAtLoad=true means it starts now;
  // KeepAlive on non-zero exit means it auto-restarts on crash.
  try {
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, {
      stdio: "ignore",
    });
    p.log.success(`Loaded launchd agent ${LAUNCHD_LABEL}.`);
  } catch (err) {
    p.log.error(
      [
        `launchctl bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
        "",
        "You can try loading it manually:",
        `  launchctl bootstrap gui/$(id -u) ${plistPath}`,
      ].join("\n"),
    );
    return SKIPPED;
  }

  // Wait for /api/health.
  const healthSpinner = p.spinner();
  healthSpinner.start(
    `Waiting for the server to come up on http://localhost:${opts.serverPort}...`,
  );
  const ok = await waitForHealth(
    `http://localhost:${opts.serverPort}/api/health`,
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
        `  · check status:  launchctl print gui/$(id -u)/${LAUNCHD_LABEL}`,
        `  · tail logs:     tail -f ${logFile}`,
        `  · stop it:       launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`,
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
      `Tianshu is running under launchd.`,
      `  Web UI:  http://localhost:${opts.webPort}`,
      `  API:     http://localhost:${opts.serverPort}/api`,
      `  Logs:    ${logFile} / ${errFile}`,
    ].join("\n"),
  );
  return {
    serverUrl: `http://localhost:${opts.serverPort}`,
    webUrl: `http://localhost:${opts.webPort}`,
    started: true,
  };
}

// ─── helpers ───────────────────────────────────────────────────────

/** Walk up from this module's directory until we find the
 *  tianshu package.json. Returns the original CWD as a fallback
 *  if nothing matches; isTianshuCheckout will then surface the
 *  'not a checkout' message and skip. */
function findCheckoutRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (isTianshuCheckout(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isTianshuCheckout(repoRoot: string): boolean {
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

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(false));
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

async function waitForHealth(url: string, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 2_000);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(timeout);
      if (res.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return false;
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
