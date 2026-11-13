/**
 * /api/moss-live/config — GET + PUT for Moss-Live voice settings.
 *
 * Two-level API key:
 *   - Tenant level: stored in tenant config.json (admin sets for all users)
 *   - User level: stored in user_preferences (individual user overrides)
 *   - Resolution: user key wins if present, else tenant key
 *
 * Other settings (model, persona, instructions) are tenant-level only.
 */

import type { Express, Request, Response } from "express";
import {
  loadTenantConfig,
  writeTenantConfig,
} from "../core/config.js";
import { createLogger } from "../setup/logger.js";

const log = createLogger("moss-live-routes");

const USER_KEY_PREF = "mossLiveApiKey";

function mask(key: string): string {
  if (key.length < 12) return "***";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

/** Resolve the effective API key: user-level wins over tenant-level. */
export function resolveApiKey(ctx: { tenant: any; userId: string }): string | null {
  // User-level key
  const row = ctx.tenant.db
    .prepare(
      "SELECT value FROM user_preferences WHERE user_id = ? AND key = ?",
    )
    .get(ctx.userId, USER_KEY_PREF) as { value: string | null } | undefined;
  if (row?.value) return row.value;

  // Tenant-level key
  return ctx.tenant.config.mossLive?.apiKey || null;
}

export function mountMossLiveRoutes(app: Express): void {
  // GET — read current config (mask API keys)
  app.get("/api/moss-live/config", (req: Request, res: Response) => {
    const ctx = (req as any).ctx;
    if (!ctx?.tenant) return res.status(401).json({ error: "unauthorized" });

    const tenantCfg = ctx.tenant.config.mossLive ?? {};

    // User-level key
    const userKeyRow = ctx.tenant.db
      .prepare(
        "SELECT value FROM user_preferences WHERE user_id = ? AND key = ?",
      )
      .get(ctx.userId, USER_KEY_PREF) as { value: string | null } | undefined;
    const userKey = userKeyRow?.value || null;

    // Effective key: user wins
    const effectiveKey = userKey || tenantCfg.apiKey || null;

    res.json({
      ...tenantCfg,
      // Masked keys for display
      apiKey: tenantCfg.apiKey ? mask(tenantCfg.apiKey) : null,
      userApiKey: userKey ? mask(userKey) : null,
      // Whether voice mode is available (effective key exists)
      available: !!effectiveKey,
      // Which level is active
      keySource: userKey ? "user" : tenantCfg.apiKey ? "tenant" : null,
    });
  });

  // PUT — update tenant-level config (admin)
  app.put("/api/moss-live/config", (req: Request, res: Response) => {
    const ctx = (req as any).ctx;
    if (!ctx?.tenant) return res.status(401).json({ error: "unauthorized" });
    const tenant = ctx.tenant;

    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid body" });
    }

    try {
      const existing = loadTenantConfig(tenant.tenantId, tenant.home);
      const mossLive = { ...(existing.mossLive ?? {}) };

      if (body.apiKey !== undefined) {
        const key = body.apiKey as string;
        if (key && !key.includes("...")) {
          mossLive.apiKey = key;
        } else if (key === "") {
          // Explicitly clear tenant key
          delete mossLive.apiKey;
        }
      }
      if (body.model !== undefined) mossLive.model = (body.model as string) || undefined;
      if (body.persona !== undefined) mossLive.persona = (body.persona as string) || undefined;
      if (body.instructions !== undefined) mossLive.instructions = (body.instructions as string) || undefined;

      const updated = { ...existing, mossLive };
      writeTenantConfig(tenant.tenantId, updated, tenant.home);
      log.info(`[moss-live] tenant config updated for tenant=${tenant.tenantId}`);
      res.json({ ok: true });
    } catch (err) {
      log.error(`[moss-live] tenant config update failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "failed to save config" });
    }
  });

  // PUT — update user-level API key
  app.put("/api/moss-live/user-key", (req: Request, res: Response) => {
    const ctx = (req as any).ctx;
    if (!ctx?.tenant) return res.status(401).json({ error: "unauthorized" });

    const body = req.body as { apiKey?: string };
    const key = body?.apiKey ?? "";

    if (key && key.includes("...")) {
      // Masked key — don't overwrite
      return res.json({ ok: true });
    }

    if (key) {
      ctx.tenant.db
        .prepare("INSERT OR REPLACE INTO user_preferences (user_id, key, value) VALUES (?, ?, ?)")
        .run(ctx.userId, USER_KEY_PREF, key);
      log.info(`[moss-live] user key set for user=${ctx.userId}`);
    } else {
      // Clear user key
      ctx.tenant.db
        .prepare("DELETE FROM user_preferences WHERE user_id = ? AND key = ?")
        .run(ctx.userId, USER_KEY_PREF);
      log.info(`[moss-live] user key cleared for user=${ctx.userId}`);
    }

    res.json({ ok: true });
  });
}
