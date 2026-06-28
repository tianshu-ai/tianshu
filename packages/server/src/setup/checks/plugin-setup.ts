// Generic plugin-prerequisite check runner.
//
// Reads each plugin's `manifest.setup` spec (see
// PluginSetupSpec in @tianshu-ai/plugin-sdk), runs the verify
// commands on the host, and produces a CheckGroup the doctor /
// setup agent can render.
//
// Design choices:
//   - We never auto-run install commands. They're returned in
//     the result so the agent can show them to the user and let
//     them pick which path to take. The setup-agent rule that
//     mutating actions require confirmation still applies.
//   - Verify commands run with a per-command 5s timeout (long
//     enough for `docker info` over a busy daemon, short enough
//     that a hung daemon doesn't wedge the doctor for minutes).
//   - We filter `os`-tagged commands against `process.platform`
//     so the doctor renders one host's appropriate steps even
//     when the plugin ships cross-platform install paths.
//   - All paths through here are read-only WRT plugin state \u2014
//     no file writes, no plugin (de)activation. Safe to call from
//     `tianshu doctor`.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PluginSetupSpec,
  PluginSetupCommand,
  PluginSetupRequirement,
} from "@tianshu-ai/plugin-sdk";
import type { CheckGroup, CheckLine } from "../render.js";

export interface PluginSetupStatus {
  pluginId: string;
  displayName: string;
  summary?: string;
  docs?: string;
  requirements: RequirementStatus[];
}

export interface RequirementStatus {
  id: string;
  label: string;
  description?: string;
  severity: PluginSetupRequirement["severity"];
  ok: boolean;
  /** Verify command output (truncated to 200 bytes per stream).
   *  Useful for diagnosing why a check failed. */
  verifyDetail: string;
  /** Install paths whose `os` tag matches the current platform.
   *  Empty array means the plugin didn't list any installs for
   *  this OS \u2014 the user has to consult the docs link. */
  installSteps: RenderedInstallPath[];
}

export interface RenderedInstallPath {
  label: string;
  description?: string;
  steps: { cmd: string; note?: string }[];
}

export interface PluginSetupCheckOpts {
  /** Per-verify-command timeout. Default 5000ms. */
  perCommandTimeoutMs?: number;
}

/**
 * Run the verify commands declared by one plugin's setup spec and
 * return a structured status. Mutating install commands are NOT
 * run; they're rendered into the result for the caller (doctor /
 * setup agent) to surface to the user.
 */
export async function evaluatePluginSetup(
  pluginId: string,
  displayName: string,
  spec: PluginSetupSpec,
  opts: PluginSetupCheckOpts = {},
): Promise<PluginSetupStatus> {
  const timeoutMs = opts.perCommandTimeoutMs ?? 5_000;
  const requirements: RequirementStatus[] = [];
  for (const req of spec.requirements) {
    requirements.push(await evaluateOne(req, timeoutMs));
  }
  return {
    pluginId,
    displayName,
    summary: spec.summary,
    docs: spec.docs,
    requirements,
  };
}

async function evaluateOne(
  req: PluginSetupRequirement,
  timeoutMs: number,
): Promise<RequirementStatus> {
  const platform = process.platform;
  const platformCmds = req.verify.filter((c) => matchesPlatform(c, platform));
  // If the plugin tagged every verify command with `os` and none
  // match this platform, we surface that as a soft-warn rather
  // than a hard fail: the requirement might not apply on this OS.
  if (platformCmds.length === 0) {
    return {
      id: req.id,
      label: req.label,
      description: req.description,
      severity: req.severity,
      ok: true,
      verifyDetail: `(no verify command for platform=${platform}; skipped)`,
      installSteps: renderInstalls(req, platform),
    };
  }
  let lastDetail = "";
  for (const c of platformCmds) {
    const r = await runCommand(c.cmd, timeoutMs);
    lastDetail = formatDetail(c.cmd, r);
    if (r.exitCode === 0) {
      return {
        id: req.id,
        label: req.label,
        description: req.description,
        severity: req.severity,
        ok: true,
        verifyDetail: lastDetail,
        installSteps: renderInstalls(req, platform),
      };
    }
  }
  return {
    id: req.id,
    label: req.label,
    description: req.description,
    severity: req.severity,
    ok: false,
    verifyDetail: lastDetail,
    installSteps: renderInstalls(req, platform),
  };
}

function renderInstalls(
  req: PluginSetupRequirement,
  platform: NodeJS.Platform,
): RenderedInstallPath[] {
  if (!req.install) return [];
  const out: RenderedInstallPath[] = [];
  for (const inst of req.install) {
    const steps = inst.steps.filter((s) => matchesPlatform(s, platform));
    if (steps.length === 0) continue;
    out.push({
      label: inst.label,
      description: inst.description,
      steps: steps.map((s) => ({ cmd: s.cmd, note: s.note })),
    });
  }
  return out;
}

function matchesPlatform(
  c: PluginSetupCommand,
  platform: NodeJS.Platform,
): boolean {
  if (!c.os || c.os.length === 0) return true;
  return c.os.includes(platform as "darwin" | "linux" | "win32");
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runCommand(cmd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd" : "/bin/sh";
    const args = isWin ? ["/c", cmd] : ["-c", cmd];
    const child = spawn(shell, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8").slice(0, 1024);
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8").slice(0, 1024);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout: truncate(stdout, 200),
        stderr: truncate(stderr, 200),
        timedOut,
      });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: `(spawn failed)`,
        timedOut,
      });
    });
  });
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.trim();
  return `${s.slice(0, n).trim()}…`;
}

function formatDetail(cmd: string, r: RunResult): string {
  const bits: string[] = [`$ ${cmd}`];
  if (r.timedOut) bits.push("(timed out)");
  if (r.stdout) bits.push(r.stdout);
  if (r.stderr) bits.push(`stderr: ${r.stderr}`);
  bits.push(`exit ${r.exitCode}`);
  return bits.join("\n");
}

/**
 * Convert a PluginSetupStatus into the doctor's CheckGroup format
 * so the renderer prints it next to the other host checks.
 */
export function pluginSetupToCheckGroup(
  status: PluginSetupStatus,
): CheckGroup {
  const lines: CheckLine[] = [];
  for (const r of status.requirements) {
    let severity: CheckLine["severity"];
    if (r.ok) {
      severity = "ok";
    } else if (r.severity === "required") {
      severity = "blocker";
    } else {
      // recommended + optional both map to a non-blocking warn so
      // the doctor still surfaces them without forcing the user
      // to act before launching tianshu start.
      severity = "warning";
    }
    const detailBits: string[] = [];
    if (r.description) detailBits.push(r.description);
    if (!r.ok && r.installSteps.length > 0) {
      detailBits.push(
        `install path: ${r.installSteps[0]!.label} (others: ${r.installSteps
          .slice(1)
          .map((p) => p.label)
          .join(", ") || "—"})`,
      );
    }
    lines.push({
      severity,
      text: r.label,
      detail: detailBits.length > 0 ? detailBits.join(" · ") : undefined,
    });
  }
  return {
    title: `Plugin: ${status.displayName} (${status.pluginId})`,
    lines,
  };
}

/**
 * Scan a directory of plugin manifest.json files (the same dir the
 * builtin-loader uses) and return the setup spec for each plugin
 * that declares one. Plugins without `setup` are skipped silently.
 *
 * Returns an array sorted by plugin id for stable rendering.
 */
export function discoverPluginSetupSpecs(
  pluginsRoot: string,
): Array<{ pluginId: string; displayName: string; spec: PluginSetupSpec }> {
  if (!fs.existsSync(pluginsRoot)) return [];
  const out: Array<{
    pluginId: string;
    displayName: string;
    spec: PluginSetupSpec;
  }> = [];
  const ids = fs
    .readdirSync(pluginsRoot, { withFileTypes: true })
    .filter(
      (d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"),
    )
    .map((d) => d.name)
    .sort();
  for (const id of ids) {
    const manifestPath = path.join(pluginsRoot, id, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        id?: string;
        displayName?: string;
        setup?: PluginSetupSpec;
      };
      if (!raw.setup || !Array.isArray(raw.setup.requirements)) continue;
      out.push({
        pluginId: raw.id ?? id,
        displayName: raw.displayName ?? id,
        spec: raw.setup,
      });
    } catch {
      // Bad manifest \u2014 the builtin-loader will warn about it
      // separately; we don't double-log here.
    }
  }
  return out;
}
