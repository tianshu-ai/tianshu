// Runtime environment check: Node version + OS.
//
// Cheap, sync, no external IO. Run at startup-hook AND in
// `tianshu doctor`.

import os from "node:os";
import type { CheckGroup } from "../render.js";

const MIN_NODE_MAJOR = 22;

export function checkRuntime(): CheckGroup {
  const lines: CheckGroup["lines"] = [];

  // Node version
  const v = process.versions.node;
  const major = Number.parseInt(v.split(".")[0] ?? "0", 10);
  if (major >= MIN_NODE_MAJOR) {
    lines.push({
      severity: "ok",
      text: `Node ${v}`,
      detail: `(>= ${MIN_NODE_MAJOR})`,
    });
  } else {
    lines.push({
      severity: "blocker",
      text: `Node ${v} is too old`,
      detail: `Tianshu needs Node >= ${MIN_NODE_MAJOR}. Upgrade and re-run.`,
    });
  }

  // Platform — informational, not a blocker. Microsandbox needs
  // macOS-Apple-Silicon or Linux+KVM, but we surface that under
  // checks/sandbox.ts (its own quick-boot probe). Here we only
  // print what we see.
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  const supported =
    (platform === "darwin" && arch === "arm64") ||
    platform === "linux";
  lines.push({
    severity: supported ? "ok" : "info",
    text: `${platform} ${release} (${arch})`,
    detail: supported
      ? undefined
      : platform === "win32"
        ? "Windows is supported for chat and most plugins. Sandbox and openshell features are macOS/Linux only."
        : "Sandbox features need macOS Apple Silicon or Linux. Other platforms can run the chat surface but exec/browser tools won't work.",
  });

  // HOME env — openshell-gateway and other tools need it.
  // systemd services on Linux often don't set HOME.
  // Windows uses USERPROFILE instead of HOME — that's normal.
  const homeVar = process.env.HOME ?? process.env.USERPROFILE;
  if (!homeVar) {
    lines.push({
      severity: platform === "win32" ? "info" : "warning",
      text: "HOME environment variable not set",
      detail:
        platform === "win32"
          ? "Neither HOME nor USERPROFILE is set. This is unusual on Windows; Node's os.homedir() should still resolve correctly."
          : "Some tools (openshell-gateway) require HOME. " +
            (platform === "linux"
              ? 'If running under systemd, add Environment=HOME=/root (or the appropriate user home) to the service unit.'
              : "Set it in your shell profile."),
    });
  } else {
    lines.push({
      severity: "ok",
      text: platform === "win32" ? `USERPROFILE=${homeVar}` : `HOME=${homeVar}`,
    });
  }

  return { title: "Runtime", lines };
}
