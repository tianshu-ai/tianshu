// MicroSandbox plugin server entry (ADR-0004 §9 + §10, N+3).
//
// What activate() does:
// - buildRunner() picks between the real microsandbox runner and
//   the nullable fallback.
// - exports.sandboxes["MicroSandboxRunner"] registers the runner
//   under the manifest's `sandbox.shell` capability.
// - exports.tools registers four agent tools (exec, reset_sandbox,
//   get_sandbox_status, update_sandbox_config). The host collects
//   these via PluginRegistry.toolsForTenant() each agent turn and
//   gates each through its own `available()` hook.
// - GET /api/p/microsandbox/status feeds the right-panel UI.
//
// Browser sidecar (browser.cdp) and the chromium/Playwright-MCP
// stack land in a follow-up PR.

import type {
  PluginContext,
  PluginRouteHandler,
  PluginServerExports,
} from "@tianshu/plugin-sdk";
import { buildRunner, type BuiltRunner } from "./runner/index.js";
import {
  ExecTool,
  GetSandboxStatusTool,
  ResetSandboxTool,
  UpdateSandboxConfigTool,
} from "./tools/index.js";

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
      tenantId: ctx.tenantId,
      rawConfig: ctx.pluginConfig,
    });
    active = { built, log: ctx.log };
    if (built.ready) {
      ctx.log.info(built.selectedReason);
      // Eager start: kick off the VM in the background so the
      // sandbox is warm by the time the agent (or the user) calls
      // anything. Per Yu 2026-06-06: "还是一直开着，以后还要做后台一直跑的服务".
      // Errors during warm-up land in runner.status().lastError; we
      // don't await because activate() shouldn't block on it.
      const runner = built.runner as unknown as {
        warmUp?: () => void;
      };
      if (typeof runner.warmUp === "function") {
        runner.warmUp();
      }
    } else {
      ctx.log.warn(built.selectedReason);
    }
    return {
      sandboxes: {
        MicroSandboxRunner: built.runner,
      },
      tools: {
        ExecTool,
        ResetSandboxTool,
        GetSandboxStatusTool,
        UpdateSandboxConfigTool,
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
      // best-effort
    }
    active = null;
  },
};
