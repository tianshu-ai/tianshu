// Facade that picks between the real microsandbox runner and the
// nullable fallback at activation time.
//
// Resolution order for the binary:
// 1. `config.binary` — if it's an absolute path, use it directly
//    (no PATH lookup).
// 2. Otherwise, look it up on PATH via `which`. We do this once at
//    plugin start; subsequent calls reuse the cached path.
// 3. If neither yields an executable file, fall through to the
//    nullable runner with a descriptive `reason`. The capability is
//    still registered so dependents don't trip over a missing
//    provider.

import type { SandboxRunner } from "@tianshu/plugin-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveConfig, type MicroSandboxConfig } from "./types.js";
import { NullableRunner } from "./nullable.js";
import { MicrosandboxRunner } from "./microsandbox.js";

const execFileP = promisify(execFile);

export interface BuildRunnerOpts {
  pluginId: string;
  contributionId: string;
  workspaceDir: string;
  /** Raw `pluginConfig` passed through from PluginContext. */
  rawConfig: Record<string, unknown>;
  /** Test seam: override the binary resolver. */
  resolveBinary?: (cfgBinary: string) => Promise<string | null>;
}

export interface BuiltRunner {
  runner: SandboxRunner;
  config: MicroSandboxConfig;
  /** True iff the real runner was selected; false for nullable. */
  ready: boolean;
  /** Human-readable hint for the status panel + logs. */
  selectedReason: string;
}

export async function buildRunner(opts: BuildRunnerOpts): Promise<BuiltRunner> {
  const config = resolveConfig(opts.rawConfig);
  const binaryResolver = opts.resolveBinary ?? defaultResolveBinary;
  const binaryPath = await binaryResolver(config.binary).catch(() => null);

  if (binaryPath) {
    return {
      runner: new MicrosandboxRunner({
        pluginId: opts.pluginId,
        contributionId: opts.contributionId,
        workspaceDir: opts.workspaceDir,
        config,
        binaryPath,
      }),
      config,
      ready: true,
      selectedReason: `using microsandbox binary at ${binaryPath}`,
    };
  }

  const reason =
    config.binary === "microsandbox"
      ? "microsandbox binary not found on PATH; install it from https://github.com/microsandbox/microsandbox or set plugins.microsandbox.config.binary to the absolute path"
      : `microsandbox binary not found at ${config.binary}`;
  return {
    runner: new NullableRunner({
      pluginId: opts.pluginId,
      contributionId: opts.contributionId,
      workspaceDir: opts.workspaceDir,
      reason,
    }),
    config,
    ready: false,
    selectedReason: reason,
  };
}

async function defaultResolveBinary(cfgBinary: string): Promise<string | null> {
  // Absolute path: stat it directly.
  if (path.isAbsolute(cfgBinary)) {
    try {
      const st = await fs.stat(cfgBinary);
      if (st.isFile()) return cfgBinary;
    } catch {
      // fallthrough
    }
    return null;
  }
  // PATH lookup. `which` is on every supported platform we care about
  // (macOS / Linux); `where` on Windows would be the equivalent but
  // we don't ship Windows in v0.
  try {
    const { stdout } = await execFileP("which", [cfgBinary]);
    const found = stdout.trim();
    if (found.length === 0) return null;
    const st = await fs.stat(found);
    return st.isFile() ? found : null;
  } catch {
    return null;
  }
}
