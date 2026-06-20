// Runtime environment check: Node version + OS.
//
// Cheap, sync, no external IO. Run at startup-hook AND in
// `tianshu doctor`.

import os from "node:os";
import { CheckGroup } from "../render.js";

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
    severity: supported ? "ok" : "warning",
    text: `${platform} ${release} (${arch})`,
    detail: supported
      ? undefined
      : "Sandbox features need macOS Apple Silicon or Linux. Other platforms can run the chat surface but exec/browser tools won't work.",
  });

  return { title: "Runtime", lines };
}
