// Platform dispatcher for tianshu's background-service backend.
//
// macOS   → launchd.ts         (launchctl, ~/Library/LaunchAgents)
// Linux   → systemd.ts         (systemctl --user, ~/.config/systemd/user)
// Windows → windows-service.ts (schtasks.exe + Task Scheduler XML)
//
// All three modules expose the same function surface. service.ts and
// the wizard import THIS module and stay OS-agnostic.

import os from "node:os";
import * as launchd from "./launchd.js";
import * as systemd from "./systemd.js";
import * as windowsService from "./windows-service.js";
import type {
  ServiceStatus,
  LaunchctlResult,
  LaunchdInstallOpts,
  HealthResult,
} from "./launchd.js";

/** The uniform surface both launchd.ts and systemd.ts implement. */
export interface ServiceBackend {
  resolveLabel(repoRoot: string): string;
  readStatus(label: string): ServiceStatus;
  plistPathFor(label: string): string;
  logPathsFor(label: string): { out: string; err: string };
  renderPlist(label: string, opts: LaunchdInstallOpts): string;
  writePlist(label: string, body: string): string;
  findOrphanedLabels(
    currentLabel: string,
    installPath: string,
  ): Array<{ label: string; plistPath: string; workingDir: string }>;
  bootstrap(plistPathOrUnit: string): LaunchctlResult;
  bootout(label: string): LaunchctlResult;
  kickstart(label: string): LaunchctlResult;
  resolveNpmPath(): string;
  probeHealth(serverPort: number, timeoutMs?: number): Promise<HealthResult>;
  waitForHealth(
    serverPort: number,
    deadlineMs: number,
    onProgress?: (elapsedMs: number, deadlineMs: number) => void,
  ): Promise<boolean>;
}

/** True on a platform we have a service backend for. */
export function isServiceManaged(): boolean {
  const p = os.platform();
  return p === "darwin" || p === "linux" || p === "win32";
}

/** Human name for the underlying init system. */
export function backendName(): "launchd" | "systemd" | "schtasks" | "unsupported" {
  const p = os.platform();
  if (p === "darwin") return "launchd";
  if (p === "linux") return "systemd";
  if (p === "win32") return "schtasks";
  return "unsupported";
}

/**
 * Return the backend for the current platform, or null on an
 * unsupported OS. Callers render a friendly message on null rather
 * than crashing.
 */
export function getBackend(): ServiceBackend | null {
  const p = os.platform();
  if (p === "darwin") return launchd as unknown as ServiceBackend;
  if (p === "linux") return systemd as unknown as ServiceBackend;
  if (p === "win32") return windowsService as unknown as ServiceBackend;
  return null;
}
