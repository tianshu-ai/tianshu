// MicroSandbox plugin server entry (ADR-0004 §9 + §10, N+3, N+4).
//
// What activate() does:
// - buildRunner() picks between the real microsandbox runner and
//   the nullable fallback.
// - exports.sandboxes["MicroSandboxRunner"] registers the runner
//   under the manifest's `sandbox.shell` capability.
// - exports.tools registers seven agent tools (exec, reset_sandbox,
//   get_sandbox_status, update_sandbox_config, build_sandbox,
//   list_sandbox_builds, use_sandbox_build). The host collects
//   these via PluginRegistry.toolsForTenant() each agent turn and
//   gates each through its own `available()` hook.
// - exports.routes wires the GET /status, the four admin endpoints
//   (sandboxfile read/write, builds list/build/use), and the
//   reset endpoint behind /api/p/microsandbox/<route>.
//
// Browser sidecar (browser.cdp) and the chromium/Playwright-MCP
// stack land in a follow-up PR.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserSidecar,
  ExecRequest,
  ExecResult,
  PluginContext,
  PluginRouteHandler,
  PluginServerExports,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu/plugin-sdk";
import { buildRunner, type BuiltRunner } from "./runner/index.js";
import { SandboxPool } from "./runner/pool.js";
import {
  BrowserHealthCheckTool,
  BuildSandboxTool,
  ExecTool,
  GetSandboxStatusTool,
  ListSandboxBuildsTool,
  ResetSandboxTool,
  UpdateSandboxConfigTool,
  UseSandboxBuildTool,
  makeBrowserToolset,
} from "./tools/index.js";
import { buildAdminRoutes } from "./admin/routes.js";
import { buildBrowserRoutes } from "./admin/browser-routes.js";
import { loadTemplates, type SandboxfileTemplate } from "./admin/templates.js";

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
  /** Sandboxfile templates loaded once at activate(). */
  templates: SandboxfileTemplate[];
  /** Per-task sandbox manager. Provides `sandbox.taskPool`. */
  pool: SandboxPool;
  /** Routing wrapper around the long-lived runner: dispatches
   *  exec calls into the pool when ctx.taskId / ctx.sessionId
   *  resolves to a task; otherwise falls back to the long-lived
   *  Browser runner. Registered under `sandbox.shell`. */
  routedRunner: SandboxRunner;
}

let active: ActiveState | null = null;

function getRunner(): SandboxRunner | null {
  return active?.built.runner ?? null;
}

/**
 * Build the SandboxRunner facade exposed under `sandbox.shell`.
 * Almost every method delegates to the long-lived Browser runner
 * unchanged. The exception is `exec()`: when the call carries a
 * taskId (explicit or resolved via session binding), we dispatch
 * to the pool's per-task sandbox.
 */
function buildRoutedRunner(
  browserRunner: SandboxRunner,
  pool: SandboxPool,
): SandboxRunner {
  // Build a lightweight proxy that forwards every field except
  // exec to the underlying browser runner. Plain `Proxy` keeps
  // the prototype + future SDK additions auto-forwarded without a
  // version-bump churn here.
  return new Proxy(browserRunner, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return async (req: ExecRequest): Promise<ExecResult> => {
          const taskId =
            req.taskId ??
            (req.sessionId
              ? pool.resolveBySession(req.sessionId)?.taskId
              : undefined);
          if (taskId && pool.get(taskId)) {
            return pool.execForTask(taskId, req);
          }
          return target.exec(req);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      // Bind functions so `this` stays the underlying runner.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const templatesRoute: PluginRouteHandler = async (_req, res) => {
  if (!active) {
    res.status(503).json({ error: "not_started" });
    return;
  }
  res.json({ templates: active.templates });
};

const statusRoute: PluginRouteHandler = async (_req, res) => {
  if (!active) {
    res.status(503).json({ error: "not_started" });
    return;
  }
  try {
    const status = await active.built.runner.status();
    // Live memory probe — cheap, useful, and the user's #1 ask
    // ("is the sandbox actually using the 8 GiB I gave it, or
    // OOM-ing at 2 GiB because of some default I don't see?").
    // Only probe when state==='ready' so a status poll doesn't
    // cold-start an idle sandbox; nullable / starting / error all
    // skip and the UI just shows "—".
    let liveMemory: {
      totalKb: number;
      availableKb: number;
      usedKb: number;
    } | null = null;
    if (status.state === "ready" && active.built.ready) {
      try {
        const r = await active.built.runner.exec({
          command:
            "awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{print t\" \"a}' /proc/meminfo",
          // Tight timeout: meminfo on a live VM is a sub-ms read.
          // If we can't get an answer in 2s the VM is wedged and
          // skipping memory in the response is the right call.
          timeoutMs: 2000,
        });
        if (r.exitCode === 0) {
          const [tStr, aStr] = r.stdout.trim().split(/\s+/);
          const t = Number(tStr);
          const a = Number(aStr);
          if (Number.isFinite(t) && Number.isFinite(a)) {
            liveMemory = {
              totalKb: t,
              availableKb: a,
              usedKb: Math.max(0, t - a),
            };
          }
        }
      } catch {
        // Probe is best-effort. Fall through with liveMemory=null.
      }
    }
    res.json({
      ...status,
      ready: active.built.ready,
      runner: active.built.ready ? "microsandbox" : "nullable",
      liveMemory,
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

    // Templates live next to the manifest at runtime, mirrored
    // to builtinConfig by sync-builtin-plugins.mjs. Resolve
    // relative to this server.js (`dist/server.js`); the manifest
    // dir is one level up.
    const templatesDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "templates",
    );
    let templates: SandboxfileTemplate[] = [];
    try {
      templates = await loadTemplates(templatesDir);
      ctx.log.info(
        `loaded ${templates.length} sandbox template(s) from ${templatesDir}`,
      );
    } catch (err) {
      // Don't fail activate — the user can still author from
      // scratch. Surface as a warning so the plugin manager UI
      // shows it.
      ctx.log.warn(
        `failed to load sandbox templates from ${templatesDir}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const pool = new SandboxPool({
      tenantId: ctx.tenantId,
      workspaceDir: ctx.workspaceDir,
      config: built.config,
      log: ctx.log,
    });
    const routedRunner = buildRoutedRunner(built.runner, pool);

    active = {
      built,
      log: ctx.log,
      tenantHomeDir,
      tenantId: ctx.tenantId,
      workspaceDir: ctx.workspaceDir,
      sandboxName: `tianshu-${ctx.tenantId}`,
      templates,
      pool,
      routedRunner,
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

    const browserRoutes = buildBrowserRoutes({
      getRunner,
    });

    const adminRoutes = buildAdminRoutes({
      getRunner,
      // The pool is owned by the activate closure (no module
      // global), so we expose it via a closure rather than a
      // module-level getter. Returns null only if a future
      // refactor decouples pool creation from activate.
      getPool: () => active?.pool ?? null,
      tenantId: active.tenantId,
      workspaceDir: active.workspaceDir,
      tenantHomeDir: active.tenantHomeDir,
      sandboxName: active.sandboxName,
    });

    // The Playwright MCP toolset is wired regardless of whether
    // the runner currently exposes a browser sidecar — listTools()
    // simply returns [] until the sandbox starts emitting an MCP
    // host port. Refresh on demand from the host /api/mcp/servers
    // route or implicitly each agent turn.
    const browserToolset = makeBrowserToolset({
      getSidecar: (): BrowserSidecar | null => getRunner()?.browser ?? null,
      log: ctx.log,
    });

    return {
      sandboxes: {
        MicroSandboxRunner: routedRunner,
      },
      taskSandboxPool: pool,
      tools: {
        ExecTool,
        ResetSandboxTool,
        GetSandboxStatusTool,
        UpdateSandboxConfigTool,
        BuildSandboxTool,
        ListSandboxBuildsTool,
        UseSandboxBuildTool,
        BrowserHealthCheckTool,
      },
      toolsetProviders: {
        BrowserToolset: browserToolset,
      },
      routes: {
        status: statusRoute,
        getSandboxfile: adminRoutes.getSandboxfile,
        putSandboxfile: adminRoutes.putSandboxfile,
        getSandboxfileTemplates: templatesRoute,
        getBuilds: adminRoutes.getBuilds,
        postBuilds: adminRoutes.postBuilds,
        postUseBuild: adminRoutes.postUseBuild,
        postReset: adminRoutes.postReset,
        postExec: adminRoutes.postExec,
        getTaskPool: adminRoutes.getTaskPool,
        postTaskPoolDestroy: adminRoutes.postTaskPoolDestroy,
        getBrowserStatus: browserRoutes.getBrowserStatus,
        postBrowserRestart: browserRoutes.postBrowserRestart,
        postBrowserResize: browserRoutes.postBrowserResize,
      },
    };
  },
  async deactivate() {
    if (!active) return;
    // Stop every running task sandbox first; they hold per-task
    // microVMs that the long-lived runner doesn't know about.
    try {
      await active.pool.dispose();
    } catch (err) {
      active.log.warn(
        `task pool dispose during deactivate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
