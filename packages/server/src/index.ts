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


import {
  bootstrapDevTenantIfNeeded,
  DEV_TENANT_ID,
  DEV_RESOLVER_CHAIN,
  GlobalOps,
  McpManager,

  computeServerEffectivePublicUrl,
  ensureTenantConfigDefaults,
  listModels,
  loadGlobalConfig,

  tenantMiddleware,
  writeGlobalConfig,
} from "./core/index.js";
import { buildReloadingBuiltinResolver, PluginRegistry } from "./core/plugins/index.js";
import {
  buildToolCatalogRefreshTool,
  TOOL_CATALOG_REFRESH_NAME,
} from "./chat/host-tools/tool-catalog-refresh.js";
import {
  buildChannelSendFileTool,
  CHANNEL_SEND_FILE_TOOL_NAME,
} from "./chat/host-tools/channel-send-file.js";
import {
  INSPECT_SESSION_TOOL_NAME,
  NUDGE_SESSION_TOOL_NAME,
  READ_SESSION_LOG_TOOL_NAME,
  buildInspectSessionTool,
  buildNudgeSessionTool,
  buildReadSessionLogTool,
} from "./chat/host-tools/recovery-tools.js";
import { buildPluginsRouter } from "./plugins-routes.js";
import { CatalogClient } from "./catalog.js";
import {
  buildChannelStreamSink,
  ChannelAdapterManager,
  channelHub,
  createBinding,
  deleteBinding,
  getBinding,
  listBindingsForUser,
  startChannelRouter,
  updateBinding,
} from "./channels/index.js";
import type { ChannelBindingsCapability } from "@tianshu-ai/plugin-sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostSkills, runPrompt } from "./chat/handler.js";
import { appendMessage } from "./chat/messages.js";
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
  WorkforceSnapshotCapability,
  SolutionsCapability,
} from "@tianshu-ai/plugin-sdk";
import { buildWorkforceSnapshot } from "./workforce/snapshot.js";
import {
  applySolution,
  diffSolution,
  extractSolution,
  getSolution,
  listSolutions,
  removeSolution,
  saveSolution,
} from "./workforce/solutions.js";
import { enqueue as inboxEnqueue } from "./chat/session-inbox.js";
import { installIdleRunner } from "./boot/idle-runner.js";
import { mountChannelRoutes, toView } from "./boot/routes-channels.js";
import { mountCoreRoutes } from "./boot/routes-core.js";
import { installChatWebSocket } from "./boot/ws-upgrade.js";
import { mountStaticSpa, isSpaHosted } from "./boot/static-spa.js";

import {
  broadcastToTenant,
  broadcastToUser,
} from "./chat/active-harnesses.js";

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
    {
      name: CHANNEL_SEND_FILE_TOOL_NAME,
      since: "0.3.50",
      tool: buildChannelSendFileTool(),
    },
    // Recovery agent tool surface. These are *only* useful to the
    // session-recovery agent (chat handler error path spawns one
    // and gates them in via toolsAllow). Regular agents won't get
    // them in their default allow-list, but registering here lets
    // the recovery isolated-session pick them up through the
    // standard plugin registry plumbing.
    //
    // The factories take a resolver that opens the TenantContext
    // from the per-call AgentToolContext.tenantId; we forward to
    // globalOps.open() so the same `tianshu open` path the rest
    // of the host uses also serves recovery.
    {
      name: INSPECT_SESSION_TOOL_NAME,
      since: "0.3.57",
      tool: buildInspectSessionTool({
        openTenant: (tenantId) => globalOps.open(tenantId),
      }),
    },
    {
      name: READ_SESSION_LOG_TOOL_NAME,
      since: "0.3.57",
      tool: buildReadSessionLogTool(),
    },
    {
      name: NUDGE_SESSION_TOOL_NAME,
      since: "0.3.57",
      tool: buildNudgeSessionTool({
        openTenant: (tenantId) => globalOps.open(tenantId),
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
    // Workforce Studio snapshot — a one-call introspection of the
    // tenant's agent configuration (main agent system prompt +
    // tools + skills with body, plus every worker_agent's stored
    // SOUL.md + allow-lists). Powers the read-only Studio admin
    // page + zip export. Editing surfaces land in later phases.
    "host.workforceSnapshot": (ctx): WorkforceSnapshotCapability => ({
      build(userId: string) {
        return buildWorkforceSnapshot({
          ctx,
          userId,
          pluginRegistry,
          tianshuVersion: PACKAGE_VERSION,
        });
      },
    }),
    // Solution store (ADR-0008 Phase 2). Extract / list / get /
    // save / delete / diff. No Apply yet — solutions are inert
    // files until a later phase reconciles them into reality.
    "host.solutions": (ctx): SolutionsCapability => {
      const deps = {
        ctx,
        pluginRegistry,
        tianshuVersion: PACKAGE_VERSION,
      };
      return {
        list: (userId) => listSolutions(deps, userId),
        get: (userId, slug) => getSolution(deps, userId, slug),
        extract: (userId, args) => extractSolution(deps, userId, args),
        save: (userId, input) => saveSolution(deps, userId, input),
        remove: (userId, slug) => removeSolution(deps, userId, slug),
        diff: (userId, args) => diffSolution(deps, userId, args),
        apply: (userId, slug) => applySolution(deps, userId, slug),
      };
    },
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
            projectSlug: req.projectSlug,
            taskTitle: req.taskTitle,
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
        // Each (tenant, user, channel) tuple may have at most one
        // active binding. Channel credentials are personal *and*
        // exclusive — binding wechat twice would mean two adapters
        // racing for the same long-poll, two outbound sends per
        // agent reply, etc. So a fresh create replaces any
        // existing binding for the same (tenant, user, channel):
        // stop its adapter, cascade-delete its sessions + messages
        // + the binding row, then proceed with the new one. This
        // is also the right shape for "re-scan to refresh expired
        // token" — the new scan just supersedes the old.
        const existing = listBindingsForUser(
          ctx.db,
          ctx.tenantId,
          input.ownerUserId,
        ).filter((b) => b.channelId === input.channelId);
        for (const old of existing) {
          await channelManager.stopBinding(old.id).catch(() => {});
          const cascade = ctx.db.transaction(() => {
            ctx.db
              .prepare<[string], unknown>(
                `DELETE FROM messages
                   WHERE session_id IN (
                     SELECT id FROM sessions WHERE channel_binding_id = ?
                   )`,
              )
              .run(old.id);
            ctx.db
              .prepare<[string], unknown>(
                `DELETE FROM sessions WHERE channel_binding_id = ?`,
              )
              .run(old.id);
            deleteBinding(ctx.db, old.id);
          });
          cascade();
        }
        const row = createBinding(ctx.db, {
          tenantId: ctx.tenantId,
          ownerUserId: input.ownerUserId,
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
        const rows = listBindingsForUser(
          ctx.db,
          ctx.tenantId,
          opts.ownerUserId,
        ).filter(
          (r) => (opts.channelId ? r.channelId === opts.channelId : true),
        );
        return rows.map(toView);
      },
      async delete(bindingId, ownerUserId) {
        const row = getBinding(ctx.db, bindingId);
        if (
          !row ||
          row.tenantId !== ctx.tenantId ||
          row.ownerUserId !== ownerUserId
        ) {
          return false;
        }
        await channelManager.stopBinding(bindingId).catch(() => {});
        // Cascade: delete the binding row and every session/message
        // tied to it. Without this, the channel sessions linger in
        // the sidebar even after the bot is unbound. Messages are
        // gone too because their context_token is meaningless once
        // the binding's adapter can't reply through it anyway.
        // The transaction keeps the four deletes atomic so a
        // crash mid-way doesn't strand half the rows.
        const txn = ctx.db.transaction(() => {
          ctx.db
            .prepare<[string], unknown>(
              `DELETE FROM messages
                 WHERE session_id IN (
                   SELECT id FROM sessions WHERE channel_binding_id = ?
                 )`,
            )
            .run(bindingId);
          ctx.db
            .prepare<[string], unknown>(
              `DELETE FROM sessions WHERE channel_binding_id = ?`,
            )
            .run(bindingId);
          deleteBinding(ctx.db, bindingId);
        });
        txn();
        return true;
      },
    }),
  },
});

// toView moved to boot/routes-channels.ts (imported above) so the
// channel-routes module owns both the view shape and the routes that
// render it. host.channelBindings capability factories below still
// call toView; nothing else has changed.

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

// Wire the session-inbox idle runner. See boot/idle-runner.ts for
// the body — it's the bind-once at-boot edge between the chat
// inbox (which can't import the host registry) and the host's
// pluginRegistry + globalOps. Lives in boot/ rather than chat/
// because the dispatch on "is this session channel-bound" needs
// channelHub + GlobalOps, which are host-level concerns.
installIdleRunner({ globalOps, pluginRegistry });

// === legacy idle-runner body removed; see boot/idle-runner.ts ===

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

// `/api/channel-sessions/*` + `/api/channel-bindings/:id/model`
// — see boot/routes-channels.ts for the bodies.
mountChannelRoutes(app);

// /api/me, /api/models, /api/tools, /api/skills — see
// boot/routes-core.ts for the bodies. Identity badge / model picker /
// worker-agents allow-list pickers consume these.
mountCoreRoutes(app, { pluginRegistry });

const server = createServer(app);

// Chat over WebSocket. See boot/ws-upgrade.ts for the connection
// handler body (identity resolution + tenant open + plugin
// activation + attachChatHandler). We keep the WSS handle here so
// other host hooks (onPluginsChanged broadcast, shutdown wss.close)
// can still touch it.
const wss = installChatWebSocket({ server, globalOps, pluginRegistry });

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
      // (a) Broadcast to every chat WebSocket inside this tenant.
      //     Same payload reaches every member's UI so plugin
      //     manager state redraws + a transient banner fires for
      //     all of them, not just the user who flipped the
      //     switch. broadcastToTenant looks up the per-tenant
      //     channel map built by registerUserSendChannel on each
      //     WS connection.
      broadcastToTenant(tenantId, {
        type: "plugins_changed",
        enabled: direction === "enabled" ? [delta] : [],
        disabled: direction === "disabled" ? [delta] : [],
      });
      // (b) Append a synthetic history note to EVERY active session
      //     in this tenant — webchat sessions, channel sessions
      //     (wechat / telegram threads), all of them — so the
      //     agent's next turn on any of those threads picks up the
      //     new reality from history. Without this, the model on
      //     alice's wechat thread would happily keep calling a
      //     tool that bob just disabled.
      //
      //     Scoping:
      //       - status = 'active'  (skip compacted/archived; their
      //         history is frozen anyway).
      //       - kind   = 'user'    (workers spawn ephemeral session
      //         rows and rebuild context from scratch each task).
      //     One row per user per channel-binding pair at any time,
      //     so the write volume is bounded by tenant member count.
      try {
        const ctx = globalOps.open(tenantId);
        const text = renderPluginsChangedNote(delta, direction);
        const activeSessions = ctx.db
          .prepare<
            [],
            {
              id: string;
              user_id: string;
              kind: "user" | "worker" | "system";
              status: "active" | "compacted" | "archived";
              parent_id: string | null;
              title: string | null;
              created_at: number;
            }
          >(
            `SELECT id, user_id, kind, status, parent_id, title, created_at
               FROM sessions
              WHERE status = 'active' AND kind = 'user'`,
          )
          .all();
        for (const row of activeSessions) {
          try {
            // Use role="user" so re-hydration treats it as part of
            // the turn log (the "user" path is the only one that
            // survives for legacy plain-text rows). The bracketed
            // prefix in renderPluginsChangedNote tells both the
            // model and any future routing layer that this is a
            // system note, not a real user message.
            appendMessage(
              ctx,
              {
                id: row.id,
                userId: row.user_id,
                kind: row.kind,
                status: row.status,
                parentId: row.parent_id,
                title: row.title,
                createdAt: row.created_at,
              },
              { role: "user", content: text },
            );
          } catch (err) {
            console.warn(
              `[onPluginsChanged] append failed for session ${row.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        // If the operating user has no active session yet, the new
        // session their next visit creates will pick up the change
        // through flushToolDeltaForSession on the first prompt.
        void userId;
      } catch (err) {
        console.warn(
          `[onPluginsChanged] failed to append session notes: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  }),
);

// Optionally serve the pre-built web UI in the same process — see
// boot/static-spa.ts for the body. Dev mode skips this (vite hosts);
// production / global install activates it via TIANSHU_WEB_DIST.
await mountStaticSpa(app);
const spaHosted = isSpaHosted();

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
