// OpenShell plugin server entry.
//
// What activate() does:
//   1. Stand up a per-plugin `openshell-gateway` subprocess (managed
//      by GatewayManager inside the runner). The plugin owns the
//      gateway's lifecycle: certs, config, sqlite db, and shutdown
//      all live under `<tenant>/state/openshell-plugin/`.
//   2. Create / adopt the tenant sandbox ("tianshu-<tenant>") with
//      the tenant workspace bind-mounted at /workspace. Lazy warm-up
//      so a slow first start (image pull) doesn't block tenant boot.
//   3. Register the runner under `exports.sandboxes["OpenShellRunner"]`
//      so the host wires it under the `sandbox.shell` capability.
//   4. Register three agent tools (exec / reset_sandbox /
//      get_sandbox_status). MVP intentionally skips browser, per-task
//      pool, build management, and the openshell policy/inference
//      admin surface — see manifest description.
//
// State directory layout (created on first start, cleaned on
// uninstall):
//   <tenantRoot>/state/openshell-plugin/
//     certs/{ca,server,client}/...     <-- mTLS PKI
//     certs/jwt/{signing,public,kid}   <-- gateway-minted sandbox JWT
//     gateway.toml                     <-- regenerated each start
//     gateway.log                      <-- gateway stdout/stderr
//     cli-xdg/openshell/gateways/...   <-- plugin-local CLI config
//     <gateway's own sqlite db lives in $XDG_STATE_HOME by default;
//      we leave it under the operator's home — see gateway docs>

import * as path from "node:path";
import type {
  PluginContext,
  PluginServerExports,
} from "@tianshu-ai/plugin-sdk";
import { OpenShellRunner } from "./runner/openshell-runner.js";
import {
  ExecTool,
  GetSandboxStatusTool,
  ResetSandboxTool,
  SyncDownTool,
  SyncUpTool,
} from "./tools/index.js";

let active: { runner: OpenShellRunner; log: PluginContext["log"] } | null =
  null;

function deriveStateDir(workspaceDir: string): string {
  // `<tenantRoot>/workspace` → `<tenantRoot>/state/openshell-plugin`.
  // Sibling to logs/, db.sqlite, _tenant/ — mirrors the host's own
  // convention for non-workspace state without needing a new SDK
  // hook just for this plugin.
  return path.resolve(workspaceDir, "..", "state", "openshell-plugin");
}

export default {
  async activate(ctx: PluginContext): Promise<PluginServerExports> {
    const stateDir = deriveStateDir(ctx.workspaceDir);
    const cfg = ctx.pluginConfig ?? {};
    const runner = new OpenShellRunner({
      tenantId: ctx.tenantId,
      workspaceDir: ctx.workspaceDir,
      stateDir,
      // Plugin config (read from `<tenant>/config.json`'s
      // `plugins.openshell.config` section) can override the binary
      // paths, gateway port, and base image. Defaults work out of
      // the box on a host with `openshell` + `openshell-gateway`
      // installed on $PATH.
      openshellBin:
        typeof cfg.openshellBin === "string"
          ? cfg.openshellBin
          : undefined,
      gatewayBin:
        typeof cfg.gatewayBin === "string"
          ? cfg.gatewayBin
          : undefined,
      port:
        typeof cfg.port === "number" && Number.isInteger(cfg.port)
          ? cfg.port
          : undefined,
      fromImage:
        typeof cfg.fromImage === "string" ? cfg.fromImage : undefined,
      log: ctx.log,
    });

    // Warm the gateway + sandbox up so the first agent exec doesn't
    // stall waiting on (a) gateway spawn (~2s warm) or (b) container
    // create + Ready transition (~5s warm, ~120s cold for first ever
    // image pull). Background; failures get logged and the next exec
    // retries.
    void runner.ensureSandbox().catch((err) => {
      ctx.log.warn(
        `openshell: initial ensureSandbox failed (will retry on first exec): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });

    active = { runner, log: ctx.log };

    return {
      sandboxes: {
        // Key matches manifest.contributes.sandboxes[0].module.
        OpenShellRunner: runner,
      },
      tools: {
        // Keys match manifest.contributes.tools[].module.
        ExecTool: ExecTool(runner),
        ResetSandboxTool: ResetSandboxTool(runner),
        GetSandboxStatusTool: GetSandboxStatusTool(runner),
        SyncUpTool: SyncUpTool(runner),
        SyncDownTool: SyncDownTool(runner),
      },
    };
  },

  async deactivate() {
    if (!active) return;
    try {
      await active.runner.shutdown();
    } catch (err) {
      active.log.warn(
        `openshell: shutdown during deactivate failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    active = null;
  },
};
