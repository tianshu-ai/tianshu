// Facade — picks between the real microsandbox runner and the
// nullable fallback at activation time.
//
// Decision logic:
// 1. Try `import("microsandbox")`. The SDK ships prebuilt napi
//    binaries via optionalDependencies for darwin-arm64,
//    linux-x64-gnu, and linux-arm64-gnu. If the host platform isn't
//    in that set, the import will succeed but the napi entry will
//    be missing — we detect that by trying to access `Sandbox`.
// 2. If the SDK loads, instantiate `MicrosandboxRunner` (lazy-start
//    on first exec).
// 3. If it fails, fall through to `NullableRunner` with a reason
//    string. The capability is still registered so dependents
//    don't trip over a missing provider.

import type { SandboxRunner } from "@tianshu-ai/plugin-sdk";
import { resolveConfig, type MicroSandboxConfig } from "./types.js";
import { NullableRunner } from "./nullable.js";
import { MicrosandboxRunner } from "./microsandbox.js";

export interface BuildRunnerOpts {
  pluginId: string;
  contributionId: string;
  workspaceDir: string;
  tenantId: string;
  /** Raw `pluginConfig` passed through from PluginContext. */
  rawConfig: Record<string, unknown>;
  /** Test seam: override the SDK probe. Returns true if the SDK is
   *  available and usable, false otherwise (with a reason). */
  probeSdk?: () => Promise<{ ok: true } | { ok: false; reason: string }>;
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
  const config = resolveConfig({
    // sensible per-tenant default sandboxName so two tenants don't
    // collide on the same VM identifier.
    sandboxName: `tianshu-${opts.tenantId}`,
    ...opts.rawConfig,
  });

  const probe = opts.probeSdk ?? defaultProbeSdk;
  const probed = await probe();

  if (probed.ok) {
    return {
      runner: new MicrosandboxRunner({
        pluginId: opts.pluginId,
        contributionId: opts.contributionId,
        workspaceDir: opts.workspaceDir,
        tenantId: opts.tenantId,
        config,
      }),
      config,
      ready: true,
      selectedReason: `microsandbox SDK loaded; sandbox \"${config.sandboxName}\" will start on first exec`,
    };
  }

  return {
    runner: new NullableRunner({
      pluginId: opts.pluginId,
      contributionId: opts.contributionId,
      workspaceDir: opts.workspaceDir,
      reason: probed.reason,
    }),
    config,
    ready: false,
    selectedReason: probed.reason,
  };
}

async function defaultProbeSdk(): Promise<
  { ok: true } | { ok: false; reason: string }
> {
  try {
    const mod = await import("microsandbox");
    if (typeof mod.Sandbox?.builder !== "function") {
      return {
        ok: false,
        reason:
          "microsandbox SDK loaded but Sandbox.builder is missing; the napi prebuild for this platform may be unavailable",
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `microsandbox SDK failed to load: ${msg}. Supported platforms: darwin-arm64, linux-x64-gnu, linux-arm64-gnu.`,
    };
  }
}
