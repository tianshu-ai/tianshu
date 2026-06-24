// Host-owned tool: `tool_catalog_refresh`.
//
// Use case: the user upgrades the server, opens chat, says "what
// tools do I have?" or "did anything new show up?". The
// per-prompt tool-delta detector (flush-tool-delta.ts) only fires
// when the session's stamped version is strictly older than the
// host's current version. If the session was opened on the same
// version a new tool shipped under, or the user just wants the
// full catalog dumped for reference, the detector stays silent.
//
// This tool lets the main agent **force** a one-shot replay:
//
//   mode = "full"
//     Re-stamp the session to '0.0.0' temporarily, run the delta
//     detector, get every tool with a parseable `since`. Practical
//     effect: a single system note that lists the entire current
//     tool catalog with versions and short descriptions. Default
//     mode — covers "what can I do?" cleanly.
//
//   mode = "since"
//     Re-stamp to the caller-provided `since_version`, run the
//     detector, get tools whose `since > since_version`. For
//     "what's new since I last looked at this".
//
// Worker agents cannot call this (WORKER_DENY_TOOLS); a worker has
// no legitimate reason to broadcast about peer tools.
//
// Failure modes: best-effort. We never want a refresh hiccup to
// fail the user's prompt. Each failure path logs + returns
// `{ ok: false, text: <message> }` and lets the next turn proceed.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
} from "@tianshu-ai/plugin-sdk";
import type { GlobalOps } from "../../core/global-ops.js";
import type { PluginRegistry } from "../../core/plugins/registry.js";
import { getPackageVersion } from "../../setup/repo-root.js";
import {
  computeSessionToolDeltas,
  renderToolDeltaNote,
  type ToolCatalogEntry,
} from "../tool-delta.js";
import { appendMessage } from "../messages.js";

export interface ToolCatalogRefreshDeps {
  /** Resolves a TenantContext from a tenantId. The registry can't
   *  do this on its own (it doesn't hold the tenant pool), so the
   *  host wires a `globalOps.open` shim through. */
  openTenant: (tenantId: string) => {
    db: import("better-sqlite3").Database;
    tenantId: string;
  };
  /** Lazy registry accessor so the tool can be constructed BEFORE
   *  the registry exists (circular-init: the registry's hostTools
   *  list needs the tool, the tool needs the registry). Resolved
   *  at execute() time, by which point the registry is wired. */
  registry: () => PluginRegistry;
}

interface ToolCatalogRefreshArgs {
  mode?: "full" | "since";
  /** Required when mode = "since". Semver string. */
  since_version?: string;
}

export const TOOL_CATALOG_REFRESH_NAME = "tool_catalog_refresh";

export function buildToolCatalogRefreshTool(
  deps: ToolCatalogRefreshDeps,
): AgentTool {
  return {
    schema: {
      name: TOOL_CATALOG_REFRESH_NAME,
      description:
        "Force-inject a fresh tool catalog summary into the current chat session, " +
        "as a system note the model will read on its next turn. Use when the " +
        "user asks 'what tools do I have', 'did anything new ship', or after " +
        "you suspect an upgrade hasn't been advertised. mode=\"full\" (default) " +
        "lists every available tool with version + short description; " +
        "mode=\"since\" + since_version lists only tools whose `since > since_version`. " +
        "Idempotent and read-only against the tool catalog \u2014 only mutation is " +
        "the appended system note + the session's stamped version.",
      parameters: Type.Object({
        mode: Type.Optional(
          Type.Union(
            [Type.Literal("full"), Type.Literal("since")],
            { description: "full (default) lists everything; since lists new-since-version." },
          ),
        ),
        since_version: Type.Optional(
          Type.String({
            description:
              'Required when mode="since". Semver string (e.g. "0.3.18"). Tools whose `since` post-dates this value are listed.',
          }),
        ),
      }),
    },
    execute: (raw, ctx: AgentToolContext) => {
      const args = (raw ?? {}) as ToolCatalogRefreshArgs;
      const mode = args.mode ?? "full";

      const sessionId = ctx.sessionId;
      if (!sessionId) {
        return {
          ok: false,
          text: "tool_catalog_refresh requires a chat session context.",
        };
      }
      const currentVersion = getPackageVersion();
      if (!currentVersion) {
        return {
          ok: false,
          text: "tool_catalog_refresh could not resolve the host package version.",
        };
      }
      // Effective "stamp" we compare against. `0.0.0` for full
      // mode \u2014 every tool with a since > 0.0.0 wins. `since_version`
      // for since mode.
      let effectiveStamp = "0.0.0";
      if (mode === "since") {
        if (!args.since_version || typeof args.since_version !== "string") {
          return {
            ok: false,
            text:
              'tool_catalog_refresh: mode="since" requires a since_version (semver string).',
          };
        }
        effectiveStamp = args.since_version;
      }

      // Pull the live tool catalog from the registry.
      let catalog: ToolCatalogEntry[];
      try {
        catalog = deps.registry().toolCatalogForTenant(ctx.tenantId).map((c) => ({
          toolName: c.toolName,
          pluginId: c.pluginId,
          since: c.since,
          description: c.description,
        }));
      } catch (err) {
        return {
          ok: false,
          text: `tool_catalog_refresh: failed to read catalog: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      if (catalog.length === 0) {
        return {
          ok: false,
          text: "tool_catalog_refresh: no tools registered for this tenant.",
        };
      }

      const deltas = computeSessionToolDeltas({
        currentVersion,
        catalog,
        sessions: [
          { sessionId, createdUnderAppVersion: effectiveStamp },
        ],
      });
      const delta = deltas[0];
      const newTools = delta?.newTools ?? [];
      if (newTools.length === 0) {
        return {
          ok: true,
          text:
            mode === "full"
              ? "tool_catalog_refresh: no tools have a parseable `since` to advertise."
              : `tool_catalog_refresh: no tools have shipped after ${effectiveStamp}.`,
        };
      }

      // Build + append the note. We deliberately go through the
      // same `appendMessage(role:"user", ...)` channel the
      // automatic detector uses, so the next turn's history shows
      // the note as a quasi-user-message (the model already knows
      // this pattern from plugin enable/disable + cross-upgrade
      // notes).
      let owningCtx: ReturnType<typeof deps.openTenant> | null = null;
      try {
        owningCtx = deps.openTenant(ctx.tenantId);
      } catch (err) {
        return {
          ok: false,
          text: `tool_catalog_refresh: cannot open tenant ${ctx.tenantId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
      // Confirm the session row actually exists in this tenant DB
      // before we write anything; otherwise we'd happily insert a
      // dangling message row.
      const exists = owningCtx.db
        .prepare<[string], { id: string }>(
          `SELECT id FROM sessions WHERE id = ?`,
        )
        .get(sessionId);
      if (!exists) {
        return {
          ok: false,
          text: `tool_catalog_refresh: session ${sessionId} not found in tenant.`,
        };
      }

      const note = renderToolDeltaNote({
        fromVersion:
          mode === "full" ? "(catalog refresh)" : effectiveStamp,
        toVersion: currentVersion,
        newTools,
      });
      try {
        appendMessage(
          // appendMessage only reads `db` off ctx, so the partial
          // structural type we built via openTenant satisfies the
          // contract. The cast keeps TypeScript honest about that.
          owningCtx as unknown as import("../../core/index.js").TenantContext,
          // session — we only need .id for appendMessage; build a
          // minimal placeholder.
          {
            id: sessionId,
            userId: ctx.userId,
            parentId: null,
            status: "active",
            kind: "user",
            title: null,
            createdAt: Date.now(),
          },
          { role: "user", content: note },
        );
      } catch (err) {
        return {
          ok: false,
          text: `tool_catalog_refresh: append failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }

      return {
        ok: true,
        text: `Injected catalog refresh note for ${newTools.length} tool${
          newTools.length === 1 ? "" : "s"
        } (mode=${mode}).`,
        data: {
          mode,
          fromVersion: effectiveStamp,
          toVersion: currentVersion,
          tools: newTools.map((t) => ({
            toolName: t.toolName,
            pluginId: t.pluginId,
            since: t.since,
          })),
        },
      };
    },
    available(ctx: AgentToolContext) {
      // Worker-side: silently absent. The pool's WORKER_DENY_TOOLS
      // filter is the real enforcement; this is belt-and-braces in
      // case someone wires a worker through a non-pool code path
      // (e.g. ad-hoc CLI invocation).
      return ctx.agentScope?.kind !== "worker";
    },
  };
}
