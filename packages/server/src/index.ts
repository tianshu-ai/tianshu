// Tianshu server entrypoint.
//
// PR #20 wires up the tenant infrastructure: every API request is
// attached to a TenantContext via middleware, the dev tenant is
// auto-created on first boot, and there's a tiny /api/me endpoint so
// you can see "yes, you really are inside a tenant" in the UI.
//
// Agent runtime, sandbox, and channels are still out of scope.

import "dotenv/config";

import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_USER_ID,
  GlobalOps,
  McpManager,
  getDefaultModel,
  listModels,
  loadGlobalConfig,
  tenantMiddleware,
} from "./core/index.js";
import { buildReloadingBuiltinResolver, PluginRegistry } from "./core/plugins/index.js";
import { buildPluginsRouter } from "./plugins-routes.js";
import { CatalogClient } from "./catalog.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachChatHandler } from "./chat/handler.js";
import { appendMessage, ensureActiveSession } from "./chat/messages.js";
import type { PluginsChangedDelta } from "./chat/ws-protocol.js";
import { runAgentLoop } from "./chat/agent-loop.js";
import type {
  AgentLoopRunner,
  AgentLoopRunnerRequest,
  AgentLoopRunnerResult,
  SessionInboxCapability,
  ToolCatalogCapability,
  SkillCatalogCapability,
} from "@tianshu/plugin-sdk";
import {
  enqueue as inboxEnqueue,
  bindIdleRunner,
} from "./chat/session-inbox.js";
import { runPrompt } from "./chat/handler.js";
import { broadcastToUser } from "./chat/active-harnesses.js";

// Default ports differ from the closed-source predecessor (3100/5173) so
// both projects can run side-by-side on the same dev machine without
// fighting over ports. Override via env if you need 3100 / 5173.
const PORT = Number.parseInt(process.env.PORT ?? "3110", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5183";

const globalOps = new GlobalOps();

// Plugin registry. ADR-0004 §15: builtin server modules are
// discovered by scanning the top-level `plugins/` directory rather
// than hand-imported here. Adding a new builtin = drop a directory
// with `manifest.json` + `dist/server.js`, no edit to this file.
//
// Tenant plugins (v1+) will be loaded via dynamic import in the
// resolver alongside the builtins.
const here = path.dirname(fileURLToPath(import.meta.url));
// `dist/index.js` → ../../../plugins, mirroring the convention used
// by the manifest discovery step in core/plugins/discovery.ts.
const defaultPluginsRoot = path.resolve(here, "..", "..", "..", "plugins");
const pluginsRoot = process.env.TIANSHU_PLUGINS_DIR
  ? path.resolve(process.env.TIANSHU_PLUGINS_DIR)
  : defaultPluginsRoot;

const reloadingResolver = await buildReloadingBuiltinResolver({ pluginsRoot });
const mcpManager = new McpManager();
// Forward-declared so the host.agentLoop factory can close over it
// before construction; assigned right below.
let pluginRegistry: PluginRegistry;
pluginRegistry = new PluginRegistry({
  resolver: reloadingResolver,
  mcpManager,
  hostCapabilities: {
    "host.sessionInbox": (ctx): SessionInboxCapability => ({
      enqueue: (targetSessionId, message) =>
        inboxEnqueue(ctx, targetSessionId, message),
    }),
    // Tool / skill catalog — plugins use these to seed default
    // allow-lists (e.g. workboard's Default LLM agent grants every
    // tool the host advertises, recomputed at activation time so
    // newly-installed plugins automatically extend the seed set).
    //
    // The closures resolve the registry at call time (not capture)
    // so they always reflect the current set of active plugins;
    // a plugin enable/disable cycle on a *separate* plugin will be
    // visible to whoever calls list() next.
    "host.toolCatalog": (ctx): ToolCatalogCapability => ({
      list() {
        const entries = pluginRegistry.toolsForTenant(ctx.tenantId);
        const byName = new Map<
          string,
          { name: string; description: string; pluginId: string }
        >();
        for (const { pluginId, tool } of entries) {
          if (byName.has(tool.schema.name)) continue;
          byName.set(tool.schema.name, {
            name: tool.schema.name,
            description: tool.schema.description ?? "",
            pluginId,
          });
        }
        return [...byName.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      },
    }),
    "host.skillCatalog": (ctx): SkillCatalogCapability => ({
      list() {
        return pluginRegistry
          .skillsForTenant(ctx.tenantId)
          .map((s) => ({
            name: s.name,
            description: s.description,
            pluginId: s.source.pluginId,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    }),
    "host.agentLoop": (ctx) => {
      const runner: AgentLoopRunner = {
        run: async (
          req: AgentLoopRunnerRequest,
        ): Promise<AgentLoopRunnerResult> => {
          const result = await runAgentLoop({
            ctx,
            userId: req.userId,
            initialUserMessage: req.initialUserMessage,
            systemPrompt: req.systemPrompt,
            modelId: req.modelId,
            toolsAllow: req.toolsAllow,
            toolsDeny: req.toolsDeny,
            skillsAllow: req.skillsAllow,
            sessionTitle: req.sessionTitle,
            workerRole: req.workerRole,
            parentSessionId: req.parentSessionId,
            timeouts: req.timeouts,
            signal: req.signal,
            onSessionStart: req.onSessionStart,
            resumeSessionId: req.resumeSessionId,
            pluginRegistry,
            homeDir: ctx.workspaceDir,
          });
          return {
            status: result.status,
            summary: result.summary,
            files: result.files,
            sessionId: result.sessionId,
            turns: result.turns,
            reason: result.reason,
          };
        },
      };
      return runner;
    },
  },
});

// Catalog client — fetches the list of installable plugins from the
// `tianshu-ai/plugin-registry` repo. Override URL via
// TIANSHU_CATALOG_URL for self-hosted catalogs.
const catalogClient = new CatalogClient();

// Create the dev tenant + dev user on first boot if global config allows.
const bootstrap = bootstrapDevTenantIfNeeded(globalOps, loadGlobalConfig());
if (bootstrap.created) {
  // eslint-disable-next-line no-console
  console.log(
    `[tianshu] bootstrapped dev tenant "${bootstrap.tenantId}" with user "${bootstrap.userId}"`,
  );
} else {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] tenants found: [${globalOps.list().join(", ")}]`);
}

// Wire the session-inbox idle runner. When a worker pool finishes
// a task and the parent chat session is idle (no active harness),
// the inbox kicks a background `runPrompt` turn so the agent
// reacts to the notification immediately instead of waiting for
// the user to send something.
//
// We bind here (one-shot, process-wide) so the inbox module
// doesn't have to import the host registry directly. The runner
// closure resolves the tenant from globalOps at call time — the
// session row already lives in some tenant DB; tonight there's
// only one (default), but the closure is tenant-agnostic.
bindIdleRunner(async ({ sessionId, userId, promptText }) => {
  // Find which tenant owns this session. If none, give up
  // silently — the inbox row stays delivered=false and will be
  // flushed on the next user prompt anyway.
  let owningCtx:
    | ReturnType<typeof globalOps.open>
    | null = null;
  for (const tenantId of globalOps.list()) {
    const ctx = globalOps.open(tenantId);
    const row = ctx.db
      .prepare<[string], { id: string }>(
        `SELECT id FROM sessions WHERE id = ?`,
      )
      .get(sessionId);
    if (row) {
      owningCtx = ctx;
      break;
    }
  }
  if (!owningCtx) {
    console.warn(
      `[idle-runner] no tenant found for session ${sessionId}; skipping`,
    );
    return;
  }
  const ctx = owningCtx;

  // Stream events out to every chat tab the user has open. If
  // they have no tabs (offline), the turn still runs and its
  // assistant message persists; next reconnect's history fetch
  // surfaces it.
  const send = (msg: import("./chat/ws-protocol.js").ServerMsg) =>
    broadcastToUser(userId, msg);

  // The runner needs an AbortController so a wedged provider
  // can't pin the inbox queue forever. We don't expose this to
  // the user (no user-facing abort button for an inbox turn);
  // simply give the run a generous deadline.
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    5 * 60 * 1000,
  );
  try {
    await runPrompt({
      ctx,
      userId,
      send,
      content: promptText,
      signal: controller.signal,
      pluginRegistry,
      homeDir: ctx.workspaceDir,
    });
  } finally {
    clearTimeout(deadline);
  }
});

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: true,
  }),
);
app.use(express.json({ limit: "1mb" }));

// /api/health is intentionally outside the tenant middleware so that a
// container orchestrator can liveness-check us before any tenant exists.
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "tianshu",
    version: "0.2.0",
    uptimeSec: Math.round(process.uptime()),
    tenants: globalOps.list().length,
  });
});

// Everything below /api/* needs a tenant context. Default resolver in
// dev mode pins to the bootstrap tenant + user; JWT mode will replace
// this resolver in a later PR.
app.use(
  "/api",
  tenantMiddleware({ ops: globalOps }),
);

app.get("/api/me", (req, res) => {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const { tenant, userId } = req.ctx;
  const def = getDefaultModel(tenant.config);
  res.json({
    tenantId: tenant.tenantId,
    userId,
    config: { branding: tenant.config.branding ?? null },
    defaultModel: def ? { id: def.id, name: def.name, provider: def.providerId } : null,
    devTenant: tenant.tenantId === DEV_TENANT_ID && userId === DEV_USER_ID,
  });
});

app.get("/api/models", (req, res) => {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const list = listModels(req.ctx.tenant.config).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.providerId,
    group: m.group ?? null,
    contextWindow: m.contextWindow,
    reasoning: m.reasoning,
  }));
  res.json({ models: list, defaultModel: req.ctx.tenant.config.defaultModel ?? null });
});

/**
 * Tool catalog for the current tenant. Used by the worker-agents
 * settings page to render an allow-list picker instead of the old
 * comma-separated freetext field.
 *
 * Returns ALL tools the host registry knows about (host built-ins +
 * every active plugin's contributions). Per-agent allow-list
 * filtering happens at the worker; this endpoint is just the
 * universe to pick from.
 */
app.get("/api/tools", (req, res) => {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const entries = pluginRegistry.toolsForTenant(req.ctx.tenant.tenantId);
  // De-dupe by tool name; if two plugins shipped the same name
  // we still only show it once. Stable sort by name for the UI.
  const byName = new Map<
    string,
    { name: string; description: string; pluginId: string }
  >();
  for (const { pluginId, tool } of entries) {
    if (byName.has(tool.schema.name)) continue;
    byName.set(tool.schema.name, {
      name: tool.schema.name,
      description: tool.schema.description ?? "",
      pluginId,
    });
  }
  const tools = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  res.json({ tools });
});

/**
 * Skill catalog for the current tenant. Same role as /api/tools —
 * the universe of skills available, host-shipped + plugin-shipped,
 * for the worker-agents allow-list picker.
 */
app.get("/api/skills", (req, res) => {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const skills = pluginRegistry.skillsForTenant(req.ctx.tenant.tenantId);
  // Same shape as /api/tools — just the bits the picker UI needs.
  // We expose the description (frontmatter) so the picker can
  // render a tooltip; the body markdown stays server-side.
  const out = skills
    .map((s) => ({
      name: s.name,
      description: s.description,
      pluginId: s.source.pluginId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ skills: out });
});

const server = createServer(app);

// Chat over WebSocket. Dev mode pins to the bootstrap tenant + user;
// JWT-mode auth lands in a later PR and will replace the resolver.
const wss = new WebSocketServer({ server, path: "/ws" });

// /api/plugins (GET + PATCH) — see ./plugins-routes.ts.
//
// ADR-0003 §8 originally reserved `PATCH /api/plugins/:id` for v1; we
// ship it in v0 so the bundled Plugin Manager UI can flip
// enable/disable without asking the user to hand-edit
// `<tenant>/config.json`.
//
// We mount this router AFTER the WebSocketServer is built so the
// onPluginsChanged hook can broadcast `plugins_changed` to every
// open chat shell + append a synthetic system message into the
// matching tenant's active session.
app.use(
  "/api",
  buildPluginsRouter({
    registry: pluginRegistry,
    ops: globalOps,
    catalog: catalogClient,
    mcpManager,
    reloadResolver: () => reloadingResolver.reload(),
    onPluginsChanged: (tenantId, delta, direction) => {
      // (a) tell every open chat shell so the UI can redraw
      //     plugin manager state + show a transient banner.
      const wsPayload = JSON.stringify({
        type: "plugins_changed",
        enabled: direction === "enabled" ? [delta] : [],
        disabled: direction === "disabled" ? [delta] : [],
      });
      for (const client of wss.clients) {
        // We don't yet do per-tenant socket bookkeeping (everyone
        // is the dev tenant in v0); when JWT auth lands the
        // wss.clients iteration grows a tenant filter.
        if ((client as { readyState?: number }).readyState === 1) {
          try {
            (client as { send: (s: string) => void }).send(wsPayload);
          } catch {
            // best-effort
          }
        }
      }
      // (b) append a synthetic message to the user's active session
      //     so the next agent turn's history reflects the new
      //     reality (model can't keep hallucinating tools that
      //     just got removed).
      try {
        const ctx = globalOps.open(tenantId);
        const session = ensureActiveSession(ctx, DEV_USER_ID);
        const text = renderPluginsChangedNote(delta, direction);
        // Use role="user" so re-hydration treats it as part of the
        // turn log (the "user" path is the only one that survives
        // for legacy plain-text rows). The bracketed prefix tells
        // both the model and any future routing layer that this
        // is a system note, not a real user message.
        appendMessage(ctx, session, { role: "user", content: text });
      } catch (err) {
        console.warn(
          `[onPluginsChanged] failed to append session note: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  }),
);
wss.on("connection", async (socket) => {
  // Resolve identity. Today: dev tenant + dev user.
  const tenantId = DEV_TENANT_ID;
  const userId = DEV_USER_ID;
  let ctx;
  try {
    ctx = globalOps.open(tenantId);
  } catch (err) {
    socket.send(
      JSON.stringify({
        type: "stream_error",
        reason: `tenant ${tenantId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    socket.close();
    return;
  }
  // Ensure plugins are activated so the agent can see
  // sandbox.shell etc. without waiting for a GET /api/plugins.
  try {
    await pluginRegistry.ensureForTenant(ctx);
  } catch (err) {
    // Plugin activation failures shouldn't kill the chat session;
    // they surface in /api/plugins as `state: failed`. Log and
    // proceed without the capability set.
    // eslint-disable-next-line no-console
    console.warn(
      `[tianshu] plugin activation failed for ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  attachChatHandler({
    ctx,
    userId,
    socket,
    pluginRegistry,
    homeDir: globalOps.homeDir,
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[tianshu] websocket at ws://localhost:${PORT}/ws`);
});

const shutdown = (signal: string) => {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] received ${signal}, shutting down`);
  wss.close();
  server.close(() => {
    globalOps.closePool();
    // Plugin caches die with the process; nothing to clean up here.
    void pluginRegistry;
    process.exit(0);
  });
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

/**
 * Format a one-line system note about a plugin enable/disable for
 * the agent's history log. We use a `[plugin-system]` prefix so the
 * model (and any future log filter) can spot these without a
 * structured-message round trip; the wording is deliberately direct
 * so the model updates its tool-availability mental model on the
 * next turn.
 *
 * Examples:
 *   [plugin-system] Plugin "MicroSandbox" was disabled. The following
 *   tools are no longer available: exec, reset_sandbox, browser_*.
 *   Do not call them.
 *
 *   [plugin-system] Plugin "MicroSandbox" was enabled. New tools
 *   available: exec, reset_sandbox, browser_*. Use them when helpful.
 */
function renderPluginsChangedNote(
  delta: PluginsChangedDelta,
  direction: "enabled" | "disabled",
): string {
  const tools = delta.tools.length ? delta.tools.join(", ") : null;
  const toolsets = delta.toolsets.length ? delta.toolsets.join(", ") : null;
  const surface =
    [tools && `tools: ${tools}`, toolsets && `toolsets: ${toolsets}`]
      .filter(Boolean)
      .join("; ") || "no agent-facing surface";
  if (direction === "enabled") {
    return (
      `[plugin-system] Plugin "${delta.displayName}" (${delta.pluginId}) was just ENABLED. ` +
      `Newly available — ${surface}. ` +
      `Use these when they help; their schemas appear in your tool list from this turn onwards.`
    );
  }
  return (
    `[plugin-system] Plugin "${delta.displayName}" (${delta.pluginId}) was just DISABLED. ` +
    `No longer available — ${surface}. ` +
    `Do not call any of these tools; they will return "unknown tool" errors. ` +
    `Earlier turns in this conversation may reference them; treat that history as stale.`
  );
}
