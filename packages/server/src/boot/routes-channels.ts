// Channel admin routes: read-only `/api/channel-sessions/*` for the
// sidebar + UI controls, plus `PATCH /api/channel-bindings/:id/model`
// so a user can flip the LLM behind their wechat / telegram thread
// without re-binding.
//
// These all live behind the tenant middleware so `req.ctx` is
// available; each route enforces user scoping (sessions.user_id /
// bindings.owner_user_id) so two users in the same tenant can't read
// each other's channel state.

import type { Express, Request, Response } from "express";
import { getBinding, updateBinding } from "../channels/index.js";
import type { ChannelBinding } from "../channels/index.js";
import type { ChannelBindingView } from "@tianshu-ai/plugin-sdk";

/** Map an internal binding row to the SDK-shaped view. Same wire
 *  shape host.channelBindings.list() emits, so plugin UIs and admin
 *  routes don't diverge. */
export function toView(row: ChannelBinding): ChannelBindingView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
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

/**
 * Mount all `/api/channel-{sessions,bindings}/*` routes on the
 * provided Express app. Call once during boot, after the tenant
 * middleware has been installed (these routes assume `req.ctx`
 * exists).
 */
export function mountChannelRoutes(app: Express): void {
  app.get("/api/channel-sessions", listChannelSessions);
  app.get(
    "/api/channel-sessions/:sessionId/binding",
    getChannelSessionBinding,
  );
  app.patch(
    "/api/channel-bindings/:bindingId/model",
    patchChannelBindingModel,
  );
}

function listChannelSessions(req: Request, res: Response): void {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  // Scope to the calling user: channel sessions are personal (one
  // user's wechat scan shouldn't surface to other users on the same
  // tenant). user_id on the session row already tracks this because
  // ensureChannelSession stamps it from the binding's owner_user_id.
  const rows = req.ctx.tenant.db
    .prepare<
      [string],
      {
        id: string;
        channel_id: string;
        channel_chat_id: string;
        channel_binding_id: string | null;
        title: string | null;
        created_at: number;
      }
    >(
      `SELECT id, channel_id, channel_chat_id, channel_binding_id,
              title, created_at
         FROM sessions
        WHERE channel_id IS NOT NULL
          AND kind = 'user'
          AND user_id = ?
        ORDER BY created_at DESC`,
    )
    .all(req.ctx.userId);
  res.json({
    sessions: rows.map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      channelChatId: r.channel_chat_id,
      channelBindingId: r.channel_binding_id,
      title: r.title,
      createdAt: r.created_at,
    })),
  });
}

/**
 * Return the binding row a channel session belongs to. Channel UIs
 * use this to populate per-session controls (model selector, etc.)
 * keyed off the session the user is viewing. Filtered by user_id so
 * users can't read each other's bindings.
 */
function getChannelSessionBinding(req: Request, res: Response): void {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const rawSid = req.params.sessionId;
  const sessionId = Array.isArray(rawSid) ? rawSid[0] : rawSid;
  if (!sessionId) {
    res.status(400).json({ error: "missing session id" });
    return;
  }
  const row = req.ctx.tenant.db
    .prepare<[string, string], { binding_id: string | null }>(
      `SELECT channel_binding_id AS binding_id
         FROM sessions
        WHERE id = ? AND user_id = ?
        LIMIT 1`,
    )
    .get(sessionId, req.ctx.userId);
  if (!row?.binding_id) {
    res.status(404).json({ error: "no binding for session" });
    return;
  }
  const binding = getBinding(req.ctx.tenant.db, row.binding_id);
  if (
    !binding ||
    binding.tenantId !== req.ctx.tenant.tenantId ||
    binding.ownerUserId !== req.ctx.userId
  ) {
    res.status(404).json({ error: "binding not found" });
    return;
  }
  res.json({
    binding: {
      id: binding.id,
      channelId: binding.channelId,
      modelId:
        typeof binding.config.modelId === "string" &&
        binding.config.modelId.trim().length > 0
          ? binding.config.modelId.trim()
          : null,
    },
  });
}

/**
 * Update a binding's model. PATCH so the body is the partial we
 * want to merge. Only `modelId` is patchable through this route
 * today; future channel-config edits can land on the same surface.
 */
function patchChannelBindingModel(req: Request, res: Response): void {
  if (!req.ctx) {
    res.status(500).json({ error: "no_ctx" });
    return;
  }
  const rawBid = req.params.bindingId;
  const bindingId = Array.isArray(rawBid) ? rawBid[0] : rawBid;
  if (!bindingId) {
    res.status(400).json({ error: "missing binding id" });
    return;
  }
  const body = (req.body ?? {}) as { modelId?: string | null };
  const newModelId =
    typeof body.modelId === "string" && body.modelId.trim().length > 0
      ? body.modelId.trim()
      : null;

  const binding = getBinding(req.ctx.tenant.db, bindingId);
  if (
    !binding ||
    binding.tenantId !== req.ctx.tenant.tenantId ||
    binding.ownerUserId !== req.ctx.userId
  ) {
    res.status(404).json({ error: "binding not found" });
    return;
  }
  const nextConfig = { ...binding.config };
  if (newModelId) nextConfig.modelId = newModelId;
  else delete nextConfig.modelId;
  updateBinding(req.ctx.tenant.db, bindingId, { config: nextConfig });
  res.json({ ok: true, modelId: newModelId });
}
