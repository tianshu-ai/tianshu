// Tianshu server entrypoint.
//
// PR #20 wires up the tenant infrastructure: every API request is
// attached to a TenantContext via middleware, the dev tenant is
// auto-created on first boot, and there's a tiny /api/me endpoint so
// you can see "yes, you really are inside a tenant" in the UI.
//
// Agent runtime, sandbox, and channels are still out of scope.

// Load .env from the repo / install root, not CWD. See
// setup/load-env.ts for why a plain `dotenv/config` is wrong here.
import { loadEnv } from "./setup/load-env.js";
loadEnv();
import { getPackageVersion } from "./setup/repo-root.js";

import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

import {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_USER_ID,
  DEV_RESOLVER_CHAIN,
  GlobalOps,
  McpManager,
  TenantNotFoundError,
  computeServerEffectivePublicUrl,
  ensureTenantConfigDefaults,
  getDefaultModel,
  listModels,
  loadGlobalConfig,
  runIdentityChain,
  tenantMiddleware,
  writeGlobalConfig,
} from "./core/index.js";
import { buildReloadingBuiltinResolver, PluginRegistry } from "./core/plugins/index.js";
import {
  buildToolCatalogRefreshTool,
  TOOL_CATALOG_REFRESH_NAME,
} from "./chat/host-tools/tool-catalog-refresh.js";
import { buildPluginsRouter } from "./plugins-routes.js";
import { CatalogClient } from "./catalog.js";
import {
  ChannelAdapterManager,
  createBinding,
  deleteBinding,
  getBinding,
  listBindingsForTenant,
  startChannelRouter,
} from "./channels/index.js";
import type { ChannelBindingsCapability } from "@tianshu-ai/plugin-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachChatHandler,
  loadHostSkills,
  runPrompt,
} from "./chat/handler.js";
import { appendMessage, ensureActiveSession } from "./chat/messages.js";
import type { PluginsChangedDelta } from "./chat/ws-protocol.js";
import { runAgentLoop } from "./chat/agent-loop.js";
import { getLSPManager } from "./lsp/index.js";
import type {
  AgentLoopRunner,
  AgentLoopRunnerRequest,
  AgentLoopRunnerResult,
  SessionInboxCapability,
  ToolCatalogCapability,
  SkillCatalogCapability,
  ModelCatalogCapability,
  LspCapability,
} from "@tianshu-ai/plugin-sdk";
import {
  enqueue as inboxEnqueue,
  bindIdleRunner,
} from "./chat/session-inbox.js";

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
// Same forward-decl trick for the channel adapter manager: host
// capability factories (host.channelBindings) close over it before
// it's constructed below. Assigning later is safe because the
// closures only resolve `channelManager` at call time — after
// `pluginRegistry` has been built and the adapter manager has been
// instantiated.
let channelManager: ChannelAdapterManager;
pluginRegistry = new PluginRegistry({
  resolver: reloadingResolver,
  mcpManager,
  // Plugin/host skills get mirrored into each tenant's config
  // tree so the agent can read them via `tenant_config_read`
  // exactly like tenant-authored ones — same tool, same path
  // shape. The loader is plumbed through so the registry can
  // collect them at activate-time.
  hostSkillsLoader: () => loadHostSkills(),
  // Host-owned tools surfaced under pluginId="core" in every
  // tenant's toolset. Today: `tool_catalog_refresh` (lets the
  // main agent force-replay the tool-delta detector on demand
  // when the user asks "what tools do I have" or after a
  // suspected silent upgrade). See chat/host-tools/.
  hostTools: [
    {
      name: TOOL_CATALOG_REFRESH_NAME,
      since: "0.3.22",
      tool: buildToolCatalogRefreshTool({
        openTenant: (tenantId) => globalOps.open(tenantId),
        // Late binding: pluginRegistry isn't fully assigned
        // until this `new PluginRegistry(...)` call returns.
        // The tool only resolves the registry at execute-time,
        // so the lazy getter is safe.
        registry: () => pluginRegistry,
      }),
    },
  ],
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
            scope: s.scope,
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
    }),
    // Model catalog — lets worker-creator / model_list pick a
    // modelId without round-tripping through `/api/models`.
    // LSP diagnostics for plugin-side tools that just wrote a
    // file (today: plugins/files's edit_file / write_file). The
    // manager is a host-wide singleton (lazy, see
    // getLSPManager); tenant scoping is enforced inside
    // diagnoseAfterEdit via the tenantId + tenantWorkspaceRoot
    // we close over here. The plugin sees a tiny surface and
    // never touches paths above its tenant's workspace.
    "host.lsp": (ctx): LspCapability => ({
      async diagnoseAfterEdit(input) {
        const mgr = getLSPManager();
        return mgr.diagnoseAfterEdit({
          tenantId: ctx.tenantId,
          tenantWorkspaceRoot: ctx.workspaceDir,
          filePath: input.filePath,
          contents: input.contents,
        });
      },
    }),
    "host.modelCatalog": (ctx): ModelCatalogCapability => ({
      list() {
        const cfg = ctx.config;
        const models = listModels(cfg).map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.providerId,
          group: m.group,
          contextWindow: m.contextWindow,
          reasoning: m.reasoning,
        }));
        return {
          models: models.sort((a, b) => a.id.localeCompare(b.id)),
          defaultModelId: cfg.defaultModel ?? null,
        };
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
            workerSlug: req.workerSlug,
            parentSessionId: req.parentSessionId,
            taskId: req.taskId,
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
    // Channel-binding admin surface for channel plugins. Plugins
    // contribute an adapter through `contributes.channels[]`;
    // when their login flow succeeds they call .create() here so
    // the host both persists the binding row AND starts the
    // adapter in one step. No "register row then somehow nudge
    // the manager" two-step.
    "host.channelBindings": (ctx): ChannelBindingsCapability => ({
      async create(input) {
        const row = createBinding(ctx.db, {
          tenantId: ctx.tenantId,
          channelId: input.channelId,
          pluginId: input.pluginId,
          displayName: input.displayName,
          config: input.config,
          enabled: input.enabled,
        });
        if (row.enabled) {
          // Best-effort start; if the adapter throws, the row
          // remains so the admin can retry / debug. setBindingStatus
          // inside startBinding records the error.
          await channelManager.startBinding(row.id).catch((err) => {
            console.warn(
              `[host.channelBindings] startBinding(${row.id}) failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
        }
        return toView(row);
      },
      list(opts) {
        const rows = listBindingsForTenant(ctx.db, ctx.tenantId).filter(
          (r) => (opts?.channelId ? r.channelId === opts.channelId : true),
        );
        return rows.map(toView);
      },
      async delete(bindingId) {
        const row = getBinding(ctx.db, bindingId);
        if (!row || row.tenantId !== ctx.tenantId) return false;
        await channelManager.stopBinding(bindingId).catch(() => {});
        deleteBinding(ctx.db, bindingId);
        return true;
      },
    }),
  },
});

function toView(row: import("./channels/index.js").ChannelBinding): import("@tianshu-ai/plugin-sdk").ChannelBindingView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    channelId: row.channelId,
    pluginId: row.pluginId,
    displayName: row.displayName,
    enabled: row.enabled,
    status: row.status,
    statusDetail: row.statusDetail,
    config: row.config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Catalog client — fetches the list of installable plugins from the
// `tianshu-ai/plugin-registry` repo. Override URL via
// TIANSHU_CATALOG_URL for self-hosted catalogs.
const catalogClient = new CatalogClient();

// Refuse to start when the user-visible config is plainly broken
// (no LLM provider, missing or unparseable config.json, Node
// older than the SDK requires). The check is fast and IO-only;
// it deliberately does NOT hit the network so dev / docker boots
// stay fast. Operators with intentionally-empty configs (smoke
// tests, image bake) can pass --ignore-setup or set
// TIANSHU_IGNORE_SETUP=1 to bypass.
const ignoreSetupArg = process.argv.includes("--ignore-setup");
const ignoreSetupEnv = (process.env.TIANSHU_IGNORE_SETUP ?? "").trim() !== "";
if (!(ignoreSetupArg || ignoreSetupEnv)) {
  const { runQuickReadinessCheck } = await import("./setup/doctor.js");
  const readiness = await runQuickReadinessCheck();
  if (!readiness.ok) {
    // eslint-disable-next-line no-console
    console.error(
      "\n[tianshu] cannot start \u2014 setup is incomplete:\n",
    );
    for (const group of readiness.blockers) {
      // eslint-disable-next-line no-console
      console.error(`  ${group.title}:`);
      for (const line of group.lines) {
        // eslint-disable-next-line no-console
        console.error(`    \u2717 ${line.text}`);
        if (line.detail) {
          // eslint-disable-next-line no-console
          console.error(`      ${line.detail}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.error(
      [
        "",
        "Fix it with:",
        "  tianshu setup --wizard      (interactive)",
        "  tianshu doctor              (full diagnostic)",
        "",
        "Or pass --ignore-setup / TIANSHU_IGNORE_SETUP=1 to start anyway.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

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

// Backfill any additive `_tenant/config/` content the host ships
// after a tenant was first created. Existing files are never
// overwritten; only missing paths get copied. Cheap (one shallow
// readdir per tenant on boot).
for (const tenantId of globalOps.list()) {
  try {
    ensureTenantConfigDefaults(tenantId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tianshu] ensureTenantConfigDefaults(${tenantId}) failed:`,
      err,
    );
  }
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
//
// `version` is read from the top-level `@tianshu-ai/tianshu`
// package.json at module load (see setup/repo-root.ts). Don't
// hard-code it here — it'll silently fall stale on every
// release and break clients that diff against npm-latest to
// suggest upgrades.
const PACKAGE_VERSION = getPackageVersion() ?? "unknown";
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    name: "tianshu",
    version: PACKAGE_VERSION,
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
      // Surface the frontmatter `scope:` field so the
      // worker-agents-page can hide "scope: main" skills from a
      // worker's effective list. Undefined = visible to both.
      scope: s.scope,
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
    onPluginsChanged: (tenantId, userId, delta, direction) => {
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
        // Use the userId from the plugin-toggle request — not
        // DEV_USER_ID. The plugin manager UI runs scoped to whoever
        // is logged in (alice@alpha, dev@default, ...) and the
        // synthetic session note belongs in *their* active chat.
        const session = ensureActiveSession(ctx, userId);
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
wss.on("connection", async (socket, request) => {
  // Resolve identity for the WS upgrade request. We run the same
  // resolver chain the HTTP middleware uses so a browser opened
  // with `?tenant=alpha&user=alice` (cookie set, see
  // dev-identity-switch PR) gets a WS connection scoped to that
  // identity — not the default dev user. The Express middleware
  // can't run on WS upgrades because it expects res.setHeader /
  // next(); we re-implement the lookup here against the same
  // chain export.
  const { resolution, error: chainError } = runIdentityChain(
    request as unknown as Parameters<typeof runIdentityChain>[0],
    DEV_RESOLVER_CHAIN,
  );
  if (chainError) {
    socket.send(
      JSON.stringify({
        type: "stream_error",
        reason: `identity resolver "${chainError.resolver}" threw: ${chainError.message}`,
      }),
    );
    socket.close();
    return;
  }
  if (!resolution || resolution.kind === "deny") {
    socket.send(
      JSON.stringify({
        type: "stream_error",
        reason:
          resolution?.kind === "deny"
            ? `identity denied by ${resolution.source}: ${resolution.reason}`
            : "no identity resolver claimed this WS upgrade",
      }),
    );
    socket.close();
    return;
  }
  const tenantId = resolution.tenantId;
  const userId = resolution.userId;
  let ctx;
  try {
    ctx = globalOps.open(tenantId);
  } catch (err) {
    // tenant_not_found from a stale cookie — fall back to default
    // so the user lands somewhere usable instead of a closed
    // socket. Mirror of the HTTP middleware's tenant-not-found
    // fallback path.
    if (err instanceof TenantNotFoundError) {
      try {
        ctx = globalOps.open(DEV_TENANT_ID);
        socket.send(
          JSON.stringify({
            type: "identity_fallback",
            requested: tenantId,
            reason: "tenant_not_found",
            source: resolution.source,
          }),
        );
      } catch {
        socket.send(
          JSON.stringify({
            type: "stream_error",
            reason: `tenant ${tenantId} unavailable and default tenant missing`,
          }),
        );
        socket.close();
        return;
      }
    } else {
      socket.send(
        JSON.stringify({
          type: "stream_error",
          reason: `tenant ${tenantId} unavailable: ${err instanceof Error ? err.message : String(err)}`,
        }),
      );
      socket.close();
      return;
    }
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
    // tenantHomeDir is the **per-tenant** root, not the global
    // tianshu home. Mirror the worker-loop call site (host.agentLoop
    // above) which passes ctx.workspaceDir. Passing
    // globalOps.homeDir made tenant_config_* tools land writes
    // under `~/.tianshu/workspace/_tenant/...` instead of
    // `~/.tianshu/tenants/<id>/workspace/_tenant/...` — a
    // tenant-isolation hole. ADR-0001 §2.
    homeDir: ctx.workspaceDir,
  });
});

// Optionally serve the pre-built web UI in the same process.
//
// Dev mode (`npm run dev` from a checkout): vite handles the web
// side on its own port (5183 by default); this block is dormant
// because TIANSHU_WEB_DIST is unset.
//
// Production / global install: the wizard's launchd plist sets
// TIANSHU_WEB_DIST to the bundled web dist directory and the
// server hosts the static files itself, so the user only needs
// one port (3110) instead of two processes.
//
// We mount this AFTER every `/api/*` and `/ws` handler so the
// catch-all only fires for non-API requests. The SPA fallback
// (any unknown path → index.html) is what makes
// `/tenants/foo/users/bar/` work without a real route on the
// filesystem.
const webDistRaw = process.env.TIANSHU_WEB_DIST;
if (webDistRaw && webDistRaw.length > 0) {
  try {
    const path = await import("node:path");
    const fs = await import("node:fs");
    const webDist = path.resolve(webDistRaw);
    if (!fs.existsSync(path.join(webDist, "index.html"))) {
      // eslint-disable-next-line no-console
      console.warn(
        `[tianshu] TIANSHU_WEB_DIST=${webDist} but no index.html there; " +
          "skipping static UI mount.`,
      );
    } else {
      // Two-layer handler:
      // 1. express.static handles `/index.html`, `/assets/*`, etc.
      //    fallthrough: true so requests it doesn't recognize
      //    cascade to the next middleware.
      // 2. SPA fallback: any GET request that wasn't /api or /ws
      //    and wasn't a static asset → serve the pre-read
      //    index.html bytes. The React router on the client
      //    decides what to render.
      //
      // Why we read index.html into a buffer rather than using
      // `res.sendFile()`: under Express 5 + Node 22+'s send
      // module, sendFile() with an absolute path consistently
      // 404'd on our setup even though `existsSync(file)`
      // returned true. We don't fully understand the
      // resolution path send takes; bypassing it with a
      // direct buffer write is simple and works the same on
      // every Node version we test.
      app.use(express.static(webDist, { index: false, fallthrough: true }));
      const indexHtml = fs.readFileSync(
        path.join(webDist, "index.html"),
      );
      app.use((req, res, next) => {
        if (req.path.startsWith("/api/")) return next();
        if (req.path === "/api") return next();
        if (req.path.startsWith("/ws")) return next();
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        // Anything else — / , /tenants/x/users/y/, /admin/foo —
        // gets index.html. The SPA's router handles it.
        res.type("html").send(indexHtml);
      });
      // eslint-disable-next-line no-console
      console.log(`[tianshu] serving web UI from ${webDist}`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[tianshu] failed to mount static web dist: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Whether this process is the one hosting the SPA. Set by
// `bin/serve.mjs` (prod / global install) to the path of the
// bundled web dist; left unset in dev where vite hosts the
// SPA on its own port. We compute this once at boot and
// publish the resulting URL into global config (see below) so
// out-of-process CLI commands can print the right URL.
const spaHosted = Boolean(
  process.env.TIANSHU_WEB_DIST && process.env.TIANSHU_WEB_DIST.length > 0,
);

// Channel system wiring (PR #220 + #221). The router subscribes
// to the hub so inbound platform messages from any plugin
// (wechat / telegram / future) route into the agent; the adapter
// manager owns the binding-row -> adapter-instance lifecycle.
// We boot the manager AFTER server.listen() so it can use the
// already-up plugin registry, but BEFORE accepting traffic, all
// existing-binding adapters are at least attempted.
channelManager = new ChannelAdapterManager({
  globalOps,
  resolveFactory: (pluginId, channelId) => {
    const found = pluginRegistry.channelFactoryFor(pluginId, channelId);
    if (!found) return null;
    return { factory: found.factory, channelId, displayName: found.displayName };
  },
  ensurePluginsActivated: async (tenantId) => {
    const ctx = globalOps.open(tenantId);
    await pluginRegistry.ensureForTenant(ctx);
  },
  stateRoot: globalOps.homeDir,
});
const stopChannelRouter = startChannelRouter({
  globalOps,
  pluginRegistry,
});
// Boot enabled bindings async; never block server.listen.
void channelManager.bootAll().catch((err) => {
  console.warn(
    `[channels] bootAll failed: ${err instanceof Error ? err.message : String(err)}`,
  );
});
// Surface stop hook so future graceful-shutdown work has
// something to call. Today nothing wires this up beyond test
// harnesses.
(globalThis as unknown as { __tianshuStopChannelRouter?: () => void }).__tianshuStopChannelRouter =
  stopChannelRouter;

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[tianshu] server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[tianshu] websocket at ws://localhost:${PORT}/ws`);
  publishEffectivePublicUrl();
});

/**
 * Write `server.effectivePublicUrl` into the global config so
 * out-of-process CLI commands (`tianshu tenant list`, doctor,
 * etc.) can print the URL that actually opens the SPA without
 * having to re-derive dev/prod heuristically.
 *
 * Idempotent: only writes when the value changes. We never
 * touch the operator-declared `server.publicUrl` field — that
 * one is for stable public URLs (Cloudflare tunnel etc.) and
 * outranks the effective URL in `resolvePublicBaseUrl`.
 */
function publishEffectivePublicUrl(): void {
  try {
    const cfg = loadGlobalConfig();
    const url = computeServerEffectivePublicUrl({
      port: PORT,
      hostsSpa: spaHosted,
    });
    if (cfg.server?.effectivePublicUrl === url) return;
    const next = {
      ...cfg,
      server: { ...(cfg.server ?? {}), effectivePublicUrl: url },
    };
    writeGlobalConfig(next);
    // eslint-disable-next-line no-console
    console.log(`[tianshu] published effectivePublicUrl=${url}`);
  } catch (err) {
    // Best-effort: don't crash the server just because we
    // couldn't update a discovery hint.
    // eslint-disable-next-line no-console
    console.warn(
      `[tianshu] failed to publish effectivePublicUrl: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

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
