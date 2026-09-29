// Service backend check: launchd (macOS) / systemd (Linux).
//
// Verifies:
//   1. plist/unit file exists and is loaded
//   2. Service is running (has a PID)
//   3. ProgramArguments / ExecStart points at the SAME node/npm
//      binary that the current CLI process is using
//   4. WorkingDirectory matches the current install path
//
// The last two catch the common drift scenario: user upgrades
// node via nvm, or moves the checkout, but the launchd plist
// still points at the old path. `tianshu restart` runs fine
// from the CLI (which uses the new node) but the service keeps
// respawning under the old binary — sometimes a completely
// different tianshu version.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { CheckGroup } from "../render.js";
import {
  getBackend,
  backendName,
  isServiceManaged,
} from "../service-backend.js";
import { findRepoRoot, isDevelopmentCheckout } from "../repo-root.js";

export function checkService(): CheckGroup {
  const lines: CheckGroup["lines"] = [];
  const platform = backendName();

  if (!isServiceManaged()) {
    lines.push({
      severity: "ok",
      text: `Platform ${os.platform()} — no service backend`,
      detail: "Service checks only apply to macOS (launchd) and Linux (systemd).",
    });
    return { title: "Service", lines };
  }

  const backend = getBackend();
  if (!backend) {
    lines.push({
      severity: "warning",
      text: `Could not load ${platform} backend`,
    });
    return { title: "Service", lines };
  }

  // Resolve what label + plist the current install SHOULD use.
  let repoRoot: string;
  try {
    repoRoot = findRepoRoot();
  } catch {
    lines.push({
      severity: "warning",
      text: "Could not determine install path",
      detail: "findRepoRoot() failed — skipping service checks.",
    });
    return { title: "Service", lines };
  }

  const label = backend.resolveLabel(repoRoot);
  const status = backend.readStatus(label);

  // 1. Plist/unit exists?
  if (!status.installed) {
    lines.push({
      severity: "warning",
      text: `No ${platform} service installed (${label})`,
      detail: `Run \`tianshu start\` to install and start the service.`,
    });
    return { title: "Service", lines };
  }
  lines.push({
    severity: "ok",
    text: `${platform} service installed: ${label}`,
    detail: status.plistPath,
  });

  // 2. Loaded + running?
  if (!status.loaded) {
    lines.push({
      severity: "warning",
      text: "Service not loaded",
      detail: `Run \`tianshu start\` or \`tianshu restart\` to load it.`,
    });
  } else if (status.pid) {
    lines.push({
      severity: "ok",
      text: `Service running (PID ${status.pid})`,
    });
  } else {
    lines.push({
      severity: "warning",
      text: "Service loaded but not running",
      detail: status.lastExitStatus != null
        ? `Last exit status: ${status.lastExitStatus}. Check logs with \`tianshu logs\`.`
        : `Run \`tianshu restart\` to start it.`,
    });
  }

  // 3 & 4. Parse the plist/unit and compare paths.
  if (platform === "launchd") {
    checkLaunchdPaths(status.plistPath, repoRoot, lines);
  } else {
    checkSystemdPaths(label, repoRoot, lines);
  }

  return { title: "Service", lines };
}

// ── launchd: parse plist XML and compare ────────────────────────────

function checkLaunchdPaths(
  plistPath: string,
  repoRoot: string,
  lines: CheckGroup["lines"],
): void {
  let body: string;
  try {
    body = fs.readFileSync(plistPath, "utf8");
  } catch {
    lines.push({
      severity: "warning",
      text: "Cannot read plist file",
      detail: plistPath,
    });
    return;
  }

  // WorkingDirectory
  const wdMatch = body.match(
    /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/,
  );
  const plistWorkDir = wdMatch ? path.resolve(wdMatch[1]) : null;
  const currentWorkDir = path.resolve(repoRoot);

  if (!plistWorkDir) {
    lines.push({
      severity: "warning",
      text: "Plist missing WorkingDirectory",
    });
  } else if (plistWorkDir === currentWorkDir) {
    lines.push({
      severity: "ok",
      text: "WorkingDirectory matches current install",
      detail: plistWorkDir,
    });
  } else {
    lines.push({
      severity: "blocker",
      text: "WorkingDirectory mismatch",
      detail:
        `Plist: ${plistWorkDir}\n` +
        `CLI:   ${currentWorkDir}\n` +
        `The service is running from a different install. Run \`tianshu restart\` to update the plist.`,
    });
  }

  // ProgramArguments — extract the first <string> (the binary path)
  const progMatch = body.match(
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/,
  );
  const plistBinary = progMatch ? path.resolve(progMatch[1]) : null;

  // The current CLI's npm/node path
  const currentNpm = resolveCurrentNpmPath();
  const currentNode = path.resolve(process.execPath);

  if (!plistBinary) {
    lines.push({
      severity: "warning",
      text: "Cannot parse ProgramArguments from plist",
    });
  } else {
    // The plist usually points at npm; compare with current npm.
    // Also check if the node version directory differs (nvm scenario).
    const plistResolved = path.resolve(plistBinary);
    const binaryMatch = plistResolved === path.resolve(currentNpm);
    // Also check node version directory: if plist npm is under
    // /Users/x/.nvm/versions/node/v22.x/... and current is v24.x/...,
    // that's a version drift.
    const plistNodeDir = extractNodeVersionDir(plistResolved);
    const currentNodeDir = extractNodeVersionDir(currentNpm) ?? extractNodeVersionDir(currentNode);

    if (binaryMatch) {
      lines.push({
        severity: "ok",
        text: "ProgramArguments binary matches current CLI",
        detail: plistResolved,
      });
    } else {
      // Different binary — check if it's just an nvm version drift
      const isNvmDrift = plistNodeDir && currentNodeDir && plistNodeDir !== currentNodeDir;
      lines.push({
        severity: "blocker",
        text: "ProgramArguments binary mismatch",
        detail:
          `Plist:   ${plistResolved}\n` +
          `Current: ${path.resolve(currentNpm)}\n` +
          (isNvmDrift
            ? `Looks like an nvm version change (${plistNodeDir} → ${currentNodeDir}). `
            : "") +
          `Run \`tianshu restart\` to update the plist.`,
      });
    }
  }
}

// ── systemd: parse unit file ────────────────────────────────────────

function checkSystemdPaths(
  label: string,
  repoRoot: string,
  lines: CheckGroup["lines"],
): void {
  // systemd user units live in ~/.config/systemd/user/
  const unitPath = path.join(
    os.homedir(),
    ".config",
    "systemd",
    "user",
    `${label}.service`,
  );
  let body: string;
  try {
    body = fs.readFileSync(unitPath, "utf8");
  } catch {
    // Try system-wide unit
    try {
      body = fs.readFileSync(`/etc/systemd/system/${label}.service`, "utf8");
    } catch {
      lines.push({
        severity: "warning",
        text: "Cannot read systemd unit file",
        detail: unitPath,
      });
      return;
    }
  }

  // WorkingDirectory
  const wdMatch = body.match(/^WorkingDirectory=(.+)$/m);
  const unitWorkDir = wdMatch ? path.resolve(wdMatch[1]) : null;
  const currentWorkDir = path.resolve(repoRoot);

  if (unitWorkDir && unitWorkDir !== currentWorkDir) {
    lines.push({
      severity: "blocker",
      text: "WorkingDirectory mismatch",
      detail:
        `Unit:  ${unitWorkDir}\n` +
        `CLI:   ${currentWorkDir}\n` +
        `Run \`tianshu restart\` to update.`,
    });
  } else if (unitWorkDir) {
    lines.push({
      severity: "ok",
      text: "WorkingDirectory matches",
      detail: unitWorkDir,
    });
  }

  // ExecStart binary
  const execMatch = body.match(/^ExecStart=(.+)$/m);
  if (execMatch) {
    const execBinary = execMatch[1].split(/\s+/)[0];
    const currentNpm = resolveCurrentNpmPath();
    if (execBinary && path.resolve(execBinary) !== path.resolve(currentNpm)) {
      lines.push({
        severity: "blocker",
        text: "ExecStart binary mismatch",
        detail:
          `Unit:    ${execBinary}\n` +
          `Current: ${currentNpm}\n` +
          `Run \`tianshu restart\` to update.`,
      });
    } else {
      lines.push({
        severity: "ok",
        text: "ExecStart binary matches",
      });
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function resolveCurrentNpmPath(): string {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    return execSync("which npm", { encoding: "utf8" }).trim();
  } catch {
    return "/usr/bin/env npm";
  }
}

/** Extract the nvm version directory segment, e.g.
 *  "/Users/x/.nvm/versions/node/v22.16.0" from a full path.
 *  Returns null if the path doesn't contain an nvm layout. */
function extractNodeVersionDir(p: string): string | null {
  const match = p.match(/(\.nvm\/versions\/node\/v[\d.]+)/);
  return match ? match[1] : null;
}
