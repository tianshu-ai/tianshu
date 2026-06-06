// MicroSandbox plugin server entry (ADR-0004 §9, N+2).
//
// What activate() does:
// - Calls buildRunner() to pick between the real microsandbox runner
//   and the nullable fallback.
// - Returns the runner under exports.sandboxes["MicroSandboxRunner"]
//   so the host's `registerProvidedCapabilities` step can wire it up
//   to the `sandbox.shell` capability declared in manifest.json.
// - Exposes GET /api/p/microsandbox/status for the right-panel UI.
//
// What it explicitly does NOT do (yet):
// - No browser sidecar (browser.cdp); will land in a follow-up PR
//   that wires chromium + Playwright MCP through the same VM. The
//   manifest's `provides[]` deliberately omits browser.cdp until then.
// - No agent tools (`exec`, `reset_sandbox`); ADR-0004 N+3 wires
//   those into the chat agent loop via the capability registry.

import type {
  PluginContext,
  PluginRouteHandler,
  PluginServerExports,
} from "@tianshu/plugin-sdk";
import { buildRunner, type BuiltRunner } from "./runner/index.js";

interface ActiveState {
  built: BuiltRunner;
  log: PluginContext["log"];
}

let active: ActiveState | null = null;

const statusRoute: PluginRouteHandler = async (_req, res) => {
  if (!active) {
    res.status(503).json({ error: "not_started" });
    return;
  }
  try {
    const status = await active.built.runner.status();
    res.json({
      ...status,
      ready: active.built.ready,
      runner: active.built.ready ? "microsandbox" : "nullable",
    });
  } catch (err) {
    res.status(500).json({
      error: "status_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

export default {
  async activate(ctx: PluginContext): Promise<PluginServerExports> {
    const built = await buildRunner({
      pluginId: ctx.pluginId,
      contributionId: "main",
      workspaceDir: ctx.workspaceDir,
      rawConfig: ctx.pluginConfig,
    });
    active = { built, log: ctx.log };
    if (built.ready) {
      ctx.log.info(built.selectedReason);
    } else {
      ctx.log.warn(built.selectedReason);
    }
    return {
      sandboxes: {
        MicroSandboxRunner: built.runner,
      },
      routes: {
        status: statusRoute,
      },
    };
  },
  async deactivate() {
    if (!active) return;
    try {
      await active.built.runner.shutdown();
    } catch {
      // Shutdown is best-effort; loader rebuilds the registry anyway.
    }
    active = null;
  },
};
