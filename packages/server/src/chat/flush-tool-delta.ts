// Per-prompt tool-delta flush.
//
// Called once at the top of every `runPrompt` turn before we
// build the system prompt + toolset. If the session was opened
// under an older app version and there are tools whose `since`
// post-dates that stamp, we drop a synthetic `role: "user"`
// system note into the session so the model's history reflects
// the change. After the note is appended we bump the session's
// stamp to the current version so the same note doesn't fire
// again on the next turn.
//
// Why per-prompt and not on server boot:
//   - boot would require enumerating every active session in
//     every tenant + activating every tenant's plugin registry
//     up-front; per-prompt is naturally lazy
//   - no risk of writing notifications nobody ever reads
//   - the model sees the note on the very turn it would have
//     needed the new tool, not "next time you come back"

import type { TenantContext } from "../core/index.js";
import type { PluginRegistry } from "../core/plugins/registry.js";
import { getPackageVersion } from "../setup/repo-root.js";
import { appendMessage, type ChatSession } from "./messages.js";
import {
  computeSessionToolDeltas,
  renderToolDeltaNote,
  type ToolCatalogEntry,
} from "./tool-delta.js";

interface FlushOpts {
  ctx: TenantContext;
  session: ChatSession;
  pluginRegistry?: PluginRegistry;
}

interface SessionVersionRow {
  created_under_app_version: string | null;
}

/** Look up the stamped version. Separate from session loading so we
 *  don't have to thread an extra field through every ChatSession
 *  consumer; the column is only relevant to this code path. */
function readSessionAppVersion(
  ctx: TenantContext,
  sessionId: string,
): string | null {
  const row = ctx.db
    .prepare<[string], SessionVersionRow>(
      `SELECT created_under_app_version FROM sessions WHERE id = ?`,
    )
    .get(sessionId);
  return row?.created_under_app_version ?? null;
}

function bumpSessionAppVersion(
  ctx: TenantContext,
  sessionId: string,
  version: string,
): void {
  ctx.db
    .prepare<[string, string], unknown>(
      `UPDATE sessions SET created_under_app_version = ? WHERE id = ?`,
    )
    .run(version, sessionId);
}

/**
 * Side-effecting flush: returns true iff a note was appended.
 *
 * Failure modes are best-effort: we never want a tool-delta hiccup
 * to block the user's prompt from running. Every error path logs
 * and returns false, letting the caller proceed normally.
 */
export function flushToolDeltaForSession(opts: FlushOpts): boolean {
  const { ctx, session, pluginRegistry } = opts;
  // Only user-facing sessions get the note. Worker sessions are
  // ephemeral per task and rebuild context from scratch each run.
  if (session.kind !== "user") return false;
  const currentVersion = getPackageVersion();
  if (!currentVersion) return false;

  let stamped: string | null;
  try {
    stamped = readSessionAppVersion(ctx, session.id);
  } catch (err) {
    console.warn(
      `[flush-tool-delta] read failed for ${session.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }

  // Pre-009 sessions (NULL stamp): claim them as "current" without
  // a notification so successive restarts don't keep re-checking.
  if (stamped == null) {
    try {
      bumpSessionAppVersion(ctx, session.id, currentVersion);
    } catch (err) {
      // non-fatal
      console.warn(
        `[flush-tool-delta] bump (null path) failed for ${session.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return false;
  }

  if (stamped === currentVersion) return false;

  // Catalog comes straight from the plugin registry. No registry
  // (e.g. tests that don't pass one) → no notification.
  if (!pluginRegistry) return false;
  let catalog: ToolCatalogEntry[] = [];
  try {
    catalog = pluginRegistry
      .toolCatalogForTenant(ctx.tenantId)
      .map((c) => ({
        toolName: c.toolName,
        pluginId: c.pluginId,
        since: c.since,
        description: c.description,
      }));
  } catch (err) {
    console.warn(
      `[flush-tool-delta] catalog read failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  if (catalog.length === 0) return false;

  const deltas = computeSessionToolDeltas({
    currentVersion,
    catalog,
    sessions: [
      { sessionId: session.id, createdUnderAppVersion: stamped },
    ],
  });
  const delta = deltas[0];
  if (!delta || delta.newTools.length === 0) {
    // No new-since-stamp tools; just bump so we don't compute this
    // again on the next turn.
    try {
      bumpSessionAppVersion(ctx, session.id, currentVersion);
    } catch (err) {
      console.warn(
        `[flush-tool-delta] bump (empty-delta path) failed for ${session.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return false;
  }

  const text = renderToolDeltaNote({
    fromVersion: stamped,
    toVersion: currentVersion,
    newTools: delta.newTools,
  });
  try {
    // Same `role: "user"` convention `renderPluginsChangedNote`
    // uses (see index.ts onPluginsChanged) so the rehydrated
    // history treats it as a real turn the model will read.
    appendMessage(ctx, session, { role: "user", content: text });
    bumpSessionAppVersion(ctx, session.id, currentVersion);
  } catch (err) {
    console.warn(
      `[flush-tool-delta] append/bump failed for ${session.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
  return true;
}

/**
 * Peek at the tool-catalog drift for a session WITHOUT touching the
 * session row or appending any message. Used by the WS attach path
 * to push a transient `tool_catalog_changed` event to the connecting
 * client; the side-effecting flush still runs on the next prompt.
 *
 * Returns the delta when there's anything new to advertise, or null
 * when the session is already up to date / there's nothing useful
 * to surface.
 */
export function peekToolCatalogDelta(opts: FlushOpts): {
  fromVersion: string | null;
  toVersion: string;
  newTools: ReadonlyArray<{ name: string; pluginId: string }>;
} | null {
  const { ctx, session, pluginRegistry } = opts;
  if (session.kind !== "user") return null;
  const currentVersion = getPackageVersion();
  if (!currentVersion) return null;
  let stamped: string | null;
  try {
    stamped = readSessionAppVersion(ctx, session.id);
  } catch {
    return null;
  }
  // Pre-009 sessions (NULL stamp) report as 'unknown -> current'
  // so the UI can still flag the upgrade window. The real flush
  // path adopts them silently on the next prompt; we just want
  // the client banner to fire once.
  if (stamped == null) {
    return {
      fromVersion: null,
      toVersion: currentVersion,
      newTools: [],
    };
  }
  if (stamped === currentVersion) return null;
  if (!pluginRegistry) return null;
  let catalog: ToolCatalogEntry[] = [];
  try {
    catalog = pluginRegistry
      .toolCatalogForTenant(ctx.tenantId)
      .map((c) => ({
        toolName: c.toolName,
        pluginId: c.pluginId,
        since: c.since,
        description: c.description,
      }));
  } catch {
    return null;
  }
  if (catalog.length === 0) return null;
  const deltas = computeSessionToolDeltas({
    currentVersion,
    catalog,
    sessions: [
      { sessionId: session.id, createdUnderAppVersion: stamped },
    ],
  });
  const delta = deltas[0];
  if (!delta) return null;
  // Even if newTools is empty (e.g. tools were only removed) we
  // still surface the version delta so the banner fires once.
  return {
    fromVersion: stamped,
    toVersion: currentVersion,
    newTools: delta.newTools.map((t) => ({
      name: t.toolName,
      pluginId: t.pluginId,
    })),
  };
}
