// MicroSandbox plugin server entry (ADR-0004 §9 + §10, N+3, N+4).
//
// What activate() does:
// - buildRunner() picks between the real microsandbox runner and
//   the nullable fallback.
// - exports.sandboxes["MicroSandboxRunner"] registers the runner
//   under the manifest's `sandbox.shell` capability.
// - exports.tools registers seven agent tools (exec, reset_sandbox,
//   get_sandbox_status, update_sandbox_config, build_sandbox,
//   list_sandbox_builds, publish_sandbox). The host collects
//   these via PluginRegistry.toolsForTenant() each agent turn and
//   gates each through its own `available()` hook.
// - exports.routes wires the GET /status, the four admin endpoints
//   (sandboxfile read/write, builds list/build/publish), and the
//   reset endpoint behind /api/p/microsandbox/<route>.
//
// Browser sidecar (browser.cdp) and the chromium/Playwright-MCP
// stack land in a follow-up PR.

import * as path from "node:path";
import type {
  PluginContext,
  PluginRouteHandler,
  PluginServerExports,
  SandboxRunner,
} from "@tianshu/plugin-sdk";
import { buildRunner, type BuiltRunner } from "./runner/index.js";
import {
  BuildSandboxTool,
  ExecTool,
  GetSandboxStatusTool,
  ListSandboxBuildsTool,
  PublishSandboxTool,
  ResetSandboxTool,
  UpdateSandboxConfigTool,
} from "./tools/index.js";
import { buildAdminRoutes } from "./admin/routes.js";

interface ActiveState {
  built: BuiltRunner;
  log: PluginContext["log"];
  /** Tenant root dir on the host fs. Same value the host sets on
   *  every tenant's `tenantHomeDir` field, captured here so the
   *  admin routes can resolve `<tenantHomeDir>/tenants/<id>/workspace/users/<userId>`. */
  tenantHomeDir: string;
  tenantId: string;
  workspaceDir: string;
  sandboxName: string;
}

let active: ActiveState | null = null;

function getRunner(): SandboxRunner | null {
  return active?.built.runner ?? null;
}

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
    // ctx.workspaceDir is `<tenantHomeDir>/tenants/<id>/workspace`,
    // so two `dirname()` calls reach the host's tenants root, then
    // one more reaches the tenant home root used by AgentToolContext.
    // (path.dirname twice → strip "/workspace" + strip "/<tenantId>"
    // gives `<tenantHomeDir>/tenants`; we want one more level up.)
    const tenantHomeDir = pathTenantHomeDir(ctx.workspaceDir);
    active = {
      built,
      log: ctx.log,
      tenantHomeDir,
      tenantId: ctx.tenantId,
      workspaceDir: ctx.workspaceDir,
      sandboxName: `tianshu-${ctx.tenantId}`,
    };
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

    const adminRoutes = buildAdminRoutes({
      getRunner,
      tenantId: active.tenantId,
      workspaceDir: active.workspaceDir,
      tenantHomeDir: active.tenantHomeDir,
      sandboxName: active.sandboxName,
    });

    return {
      sandboxes: {
        MicroSandboxRunner: built.runner,
      },
      tools: {
        ExecTool,
        ResetSandboxTool,
        GetSandboxStatusTool,
        UpdateSandboxConfigTool,
        BuildSandboxTool,
        ListSandboxBuildsTool,
        PublishSandboxTool,
      },
      routes: {
        status: statusRoute,
        getSandboxfile: adminRoutes.getSandboxfile,
        putSandboxfile: adminRoutes.putSandboxfile,
        getBuilds: adminRoutes.getBuilds,
        postBuilds: adminRoutes.postBuilds,
        postPublish: adminRoutes.postPublish,
        postReset: adminRoutes.postReset,
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

/**
 * `ctx.workspaceDir` is `<tenantHomeDir>/tenants/<tenantId>/workspace`.
 * Walk up three directory levels to recover the tenant home dir
 * (the same value the host sets as `AgentToolContext.tenantHomeDir`).
 */
function pathTenantHomeDir(workspaceDir: string): string {
  return path.resolve(workspaceDir, "..", "..", "..");
}
