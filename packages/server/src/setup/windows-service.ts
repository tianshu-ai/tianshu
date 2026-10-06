// Low-level Windows background service helpers via Task Scheduler
// (schtasks.exe). Parallels launchd.ts (macOS) and systemd.ts (Linux)
// so service.ts and the setup wizard dispatch by platform without
// caring which init system is underneath.
//
// Why Task Scheduler, not sc.exe:
//   - sc.exe creates proper Windows Services, but node.exe can't
//     respond to SCM control messages — the Service Control Manager
//     would kill it within ~30s. Making a Node process a real
//     service requires a wrapper (nssm, node-windows). Those add
//     a native binary dependency we don't want.
//   - Task Scheduler runs the process as the user, starts on logon
//     (and optionally on boot via "Run with highest privileges"),
//     restarts on failure, and only needs schtasks.exe which ships
//     with every Windows install since XP. No third-party deps.
//
// Design choices (kept parallel to launchd.ts / systemd.ts):
//   - Task name derived from install shape, not hash:
//       * `npm install -g` install → `Tianshu-Prod`
//       * git checkout (dev mode)  → `Tianshu-Dev`
//       * second checkout colliding → `Tianshu-Dev-<hash8>`
//   - Functions return structured results, never throw.
//   - Args quoted carefully — Windows paths contain spaces often.

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

// Re-export shared shapes so dispatcher callers can import from
// whichever backend module they hold.
export type { ServiceStatus, LaunchctlResult } from "./launchd.js";
export {
  probeHealth,
  waitForHealth,
  resolveNpmPath,
  type HealthResult,
} from "./launchd.js";

export const CANONICAL_DEV_TASK = "Tianshu-Dev";
export const PROD_TASK = "Tianshu-Prod";
export const CANONICAL_TASK = CANONICAL_DEV_TASK;

export type WindowsTaskInstallOpts = LaunchdInstallOpts;

// ─── task-name resolution (parallels launchd.resolveLabel) ─────────

/** Directory holding tianshu-generated Task Scheduler XML definitions.
 *  schtasks itself stores tasks in the Windows registry; we also stash
 *  the XML files for inspection and so writePlist can return a real
 *  path like the other backends. */
function taskXmlDir(): string {
  const base = process.env.LOCALAPPDATA?.trim()
    || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "tianshu", "tasks");
}

export function taskXmlPathFor(taskName: string): string {
  return path.join(taskXmlDir(), `${taskName}.xml`);
}

// Alias matching the ServiceBackend interface.
export const plistPathFor = taskXmlPathFor;

/** Resolve the Task Scheduler task name for a given tianshu install.
 *  Mirrors launchd.resolveLabel / systemd.resolveLabel. */
export function resolveLabel(repoRoot: string): string {
  if (!isDevelopmentCheckout(repoRoot)) {
    return PROD_TASK;
  }
  const canonical = taskXmlPathFor(CANONICAL_DEV_TASK);
  if (!fs.existsSync(canonical)) return CANONICAL_DEV_TASK;
  try {
    const body = fs.readFileSync(canonical, "utf8");
    // We store <WorkingDirectory>...</WorkingDirectory> in the XML
    const match = body.match(/<WorkingDirectory>([^<]+)<\/WorkingDirectory>/);
    if (match && path.resolve(match[1].trim()) === path.resolve(repoRoot)) {
      return CANONICAL_DEV_TASK;
    }
  } catch {
    // unreadable — fall through to hash
  }
  const hash = createHash("sha256")
    .update(path.resolve(repoRoot))
    .digest("hex")
    .slice(0, 8);
  return `Tianshu-Dev-${hash}`;
}

/** Find stale task XMLs pointing at this same install path but
 *  using a different task name. Parallels launchd.findOrphanedLabels. */
export function findOrphanedLabels(
  currentTask: string,
  installPath: string,
): Array<{ label: string; plistPath: string; workingDir: string }> {
  const dir = taskXmlDir();
  if (!fs.existsSync(dir)) return [];
  const normalisedInstall = path.resolve(installPath);
  const orphans: Array<{ label: string; plistPath: string; workingDir: string }> = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith("Tianshu-")) continue;
    if (!entry.endsWith(".xml")) continue;
    const taskName = entry.replace(/\.xml$/, "");
    if (taskName === currentTask) continue;
    const xmlPath = path.join(dir, entry);
    let body: string;
    try {
      body = fs.readFileSync(xmlPath, "utf8");
    } catch {
      continue;
    }
    const match = body.match(/<WorkingDirectory>([^<]+)<\/WorkingDirectory>/);
    if (!match) continue;
    const workingDir = path.resolve(match[1].trim());
    if (workingDir === normalisedInstall) {
      orphans.push({ label: taskName, plistPath: xmlPath, workingDir });
    }
  }
  return orphans;
}

// ─── logs ──────────────────────────────────────────────────────────
//
// Task Scheduler does not capture stdio by default. We redirect
// stdout/stderr in the ExecStart command itself (`> out.log 2> err.log`
// via a cmd /c wrapper) so `tianshu logs -f` works without needing
// Event Viewer / Get-WinEvent access.

function tianshuLogDir(): string {
  const base = process.env.LOCALAPPDATA?.trim()
    || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "tianshu", "logs");
}

export function logPathsFor(taskName: string): { out: string; err: string } {
  const dir = tianshuLogDir();
  return {
    out: path.join(dir, `${taskName}.out.log`),
    err: path.join(dir, `${taskName}.err.log`),
  };
}

// ─── status ──────────────────────────────────────────────────────

/** Read current task state via `schtasks /query /tn <name> /fo list`.
 *  Never throws; "task not found" collapses to installed=false. */
export function readStatus(taskName: string): ServiceStatus {
  const xmlPath = taskXmlPathFor(taskName);
  const installed = fs.existsSync(xmlPath);
  let loaded = false;
  let pid: number | null = null;
  const lastExitStatus: number | null = null;
  try {
    const out = execSync(
      `schtasks /query /tn ${quoteArg(taskName)} /fo list /v 2>nul`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    // Parse "Status: Running" / "Status: Ready" lines
    const statusMatch = out.match(/^\s*Status:\s*(.+?)\s*$/m);
    const statusTxt = statusMatch?.[1]?.trim() ?? "";
    loaded = !!statusTxt && statusTxt !== "Could not start";
    if (statusTxt === "Running") {
      // schtasks doesn't surface PID directly; use tasklist filter
      try {
        const tl = execSync(
          `tasklist /fi "IMAGENAME eq node.exe" /fo csv /nh 2>nul`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        );
        // Grab the first node PID; good enough for "is it running" UX.
        // Precise mapping task→pid requires WMI; not worth the complexity here.
        const firstLine = tl.split("\n").find((l) => l.includes("node.exe"));
        if (firstLine) {
          const cols = firstLine.split('","').map((c) => c.replace(/^"|"$/g, ""));
          const n = Number.parseInt(cols[1] ?? "", 10);
          if (!Number.isNaN(n)) pid = n;
        }
      } catch {
        // tasklist missing — leave pid null
      }
    }
  } catch {
    // schtasks missing / task not found — defaults stay
  }
  return { label: taskName, plistPath: xmlPath, installed, loaded, pid, lastExitStatus };
}

// ─── task XML render ──────────────────────────────────────────────

/** Render the Task Scheduler XML body. Pure — no side effects.
 *  Parallels launchd.renderPlist / systemd.renderUnit.
 *
 *  Key settings:
 *   - LogonTrigger starts on user logon.
 *   - UserId=S-1-5-32-545 means "Users" group (the current user).
 *   - RunLevel=LeastPrivilege — no UAC prompt, runs as normal user.
 *   - MultipleInstancesPolicy=IgnoreNew — second schtasks /run is no-op.
 *   - RestartOnFailure count=999 interval=PT30S — self-heal on crash.
 *   - DisallowStartIfOnBatteries=false — keep running on laptop battery.
 *   - Hidden=true — doesn't clutter the user's taskbar.
 */
export function renderPlist(taskName: string, opts: WindowsTaskInstallOpts): string {
  const { out: logFile, err: errFile } = logPathsFor(taskName);
  const npmBinDir = path.dirname(opts.npmPath);
  // Pathext for Windows: ensure node + npm from the specific install
  // dir are picked up first, then system PATH.
  const pathEnv = `${npmBinDir};${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}`;
  const script = opts.npmScript ?? "dev";
  // Use cmd /c to redirect stdio and set PATH, then invoke npm run.
  // schtasks requires Command + Arguments split; we put the full
  // pipeline in Arguments to cmd.exe.
  const cmdArgs = `/c set PATH=${pathEnv} && cd /d "${opts.repoRoot}" && "${opts.npmPath}" run ${script} > "${logFile}" 2> "${errFile}"`;
  const date = new Date().toISOString().split(".")[0]; // 2026-10-06T20:00:00

  // Task Scheduler XML (schema v1.4). Hand-rolled; schtasks /xml imports it.
  // Reference: https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${date}</Date>
    <Author>tianshu</Author>
    <Description>Tianshu server (${taskName})</Description>
    <URI>\\${taskName}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(os.userInfo().username)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <RestartOnFailure>
      <Interval>PT30S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${escapeXml(cmdArgs)}</Arguments>
      <WorkingDirectory>${escapeXml(opts.repoRoot)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Write the Task XML file (creating log dir + task-xml dir).
 *  Idempotent. Parallels launchd.writePlist / systemd.writePlist. */
export function writePlist(taskName: string, body: string): string {
  const xmlPath = taskXmlPathFor(taskName);
  fs.mkdirSync(path.dirname(xmlPath), { recursive: true });
  // Task Scheduler XML must be UTF-16 LE with BOM — write it correctly.
  const utf16 = Buffer.concat([
    Buffer.from([0xff, 0xfe]), // UTF-16 LE BOM
    Buffer.from(body, "utf16le"),
  ]);
  fs.writeFileSync(xmlPath, utf16);
  fs.mkdirSync(tianshuLogDir(), { recursive: true });
  return xmlPath;
}

// ─── schtasks wrappers (parallel launchctl/systemctl) ──────────────

function runSchtasks(args: string): LaunchctlResult {
  try {
    execSync(`schtasks ${args}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    return { ok: false, stderr: e.stderr ? e.stderr.toString() : e.message };
  }
}

/** Import the XML into Task Scheduler + run it now. Takes a path to
 *  the XML (as written by writePlist). Parallels launchd.bootstrap. */
export function bootstrap(xmlPath: string): LaunchctlResult {
  const taskName = path.basename(xmlPath, ".xml");
  // schtasks /create /xml imports (and overwrites if /f).
  const createRes = runSchtasks(
    `/create /tn ${quoteArg(taskName)} /xml ${quoteArg(xmlPath)} /f`,
  );
  if (!createRes.ok) return createRes;
  return runSchtasks(`/run /tn ${quoteArg(taskName)}`);
}

/** `schtasks /end` + `/delete`. Parallels launchd.bootout / systemd.bootout. */
export function bootout(taskName: string): LaunchctlResult {
  const name = taskName.replace(/\.xml$/, "");
  // Best-effort end first (ignore errors — task may not be running).
  runSchtasks(`/end /tn ${quoteArg(name)}`);
  return runSchtasks(`/delete /tn ${quoteArg(name)} /f`);
}

/** Restart: end + run. schtasks has no atomic restart. Parallels
 *  launchd.kickstart / systemd.kickstart. */
export function kickstart(taskName: string): LaunchctlResult {
  const name = taskName.replace(/\.xml$/, "");
  // /end is a no-op if task is already stopped; harmless.
  runSchtasks(`/end /tn ${quoteArg(name)}`);
  return runSchtasks(`/run /tn ${quoteArg(name)}`);
}

// ─── util ────────────────────────────────────────────────────────

/** Quote a Windows cmd argument. Handles spaces + double quotes. */
function quoteArg(s: string): string {
  if (!/[ "]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** Escape text for insertion into Task Scheduler XML. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Is Windows Task Scheduler reachable? Mirrors systemd.userBusAvailable. */
export function userBusAvailable(): boolean {
  try {
    execSync("schtasks /query /fo list 2>nul", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
