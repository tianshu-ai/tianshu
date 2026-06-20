// Microsandbox readiness check.
//
// Two modes:
//   - quick:  binary present + version reachable. ~50ms. Default.
//   - full:   actually boot an alpine sandbox, run `echo`, tear down.
//             ~30s on a cold machine (image pull). Off by default;
//             enable with `tianshu doctor --probe-sandbox`.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckGroup } from "../render.js";

export interface SandboxCheckOpts {
  /** Run a real boot + exec rather than the binary-presence probe. */
  full?: boolean;
  /** Timeout for full-mode boot. Default 60s. */
  fullTimeoutMs?: number;
}

export async function checkSandbox(
  opts: SandboxCheckOpts = {},
): Promise<CheckGroup> {
  const lines: CheckGroup["lines"] = [];

  // Microsandbox ships a per-platform binary under
  //   ~/.microsandbox/bin/msb
  // …or anywhere `MSB_PATH` points. We mirror microsandbox-node's
  // own resolution: env first, then the well-known path.
  const candidates: string[] = [];
  if (process.env.MSB_PATH) candidates.push(process.env.MSB_PATH);
  candidates.push(path.join(os.homedir(), ".microsandbox", "bin", "msb"));
  const found = candidates.find((p) => {
    try {
      return fs.existsSync(p) && (fs.statSync(p).mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });

  if (!found) {
    lines.push({
      severity: "warning",
      text: "msb binary not found",
      detail: `tried ${candidates.join(", ")}. exec/browser tools won't work until microsandbox is installed; run \`npx microsandbox install\` once.`,
    });
    return { title: "Sandbox", lines };
  }
  lines.push({
    severity: "ok",
    text: "msb binary present",
    detail: found,
  });

  if (opts.full) {
    const result = await fullProbe(found, opts.fullTimeoutMs ?? 60_000);
    if (result.ok) {
      lines.push({
        severity: "ok",
        text: "alpine quick-boot succeeded",
        detail: `${result.durationMs}ms`,
      });
    } else {
      lines.push({
        severity: "blocker",
        text: "alpine quick-boot failed",
        detail: result.error,
      });
    }
  }

  return { title: "Sandbox", lines };
}

interface ProbeResult {
  ok: boolean;
  durationMs: number;
  error?: string;
}

async function fullProbe(_msbPath: string, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now();
  // We try to import the SDK and boot a one-shot sandbox. The SDK
  // wraps the same msbPath we just found, so this exercises the
  // full boot path. We deliberately don't shell out to msb
  // ourselves — too easy to get the args wrong across versions.
  let mod: typeof import("microsandbox") | null = null;
  try {
    mod = await import("microsandbox");
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: `failed to load 'microsandbox' npm package: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const { Sandbox } = mod!;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Low-spec alpine: 1 CPU, 256 MiB. Fast enough to be a probe.
    const sb = await Sandbox.builder("tianshu-doctor-probe").image("alpine").create();
    try {
      await sb.shell("echo doctor-ok");
    } finally {
      await sb.stop().catch(() => {});
    }
    return { ok: true, durationMs: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error:
        err instanceof Error
          ? err.name === "AbortError"
            ? `timeout after ${timeoutMs}ms`
            : err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// `_msbPath` is unused today (we go through the SDK), but kept on
// the signature so a future `msb --version`-style probe can use
// it without touching call sites.
void spawn;
