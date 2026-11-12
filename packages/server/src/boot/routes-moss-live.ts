/**
 * /api/moss-live/config — GET + PUT for Moss-Live voice settings.
 *
 * Reads/writes the `mossLive` section of the tenant config.
 */

import type { Express } from "express";
import {
  loadTenantConfig,
  writeTenantConfig,
} from "../core/config.js";
import { createLogger } from "../setup/logger.js";

const log = createLogger("moss-live-routes");

export function mountMossLiveRoutes(app: Express): void {
  // GET — read current config (mask API key)
  app.get("/api/moss-live/config", (req, res) => {
    const ctx = (req as any).ctx;
    if (!ctx) return res.status(401).json({ error: "unauthorized" });

    const cfg = ctx.config.mossLive ?? {};
    // Mask the API key for display
    const masked = { ...cfg };
    if (masked.apiKey) {
      masked.apiKey = masked.apiKey.slice(0, 8) + "..." + masked.apiKey.slice(-4);
    }
    res.json(masked);
  });

  // PUT — update config
  app.put("/api/moss-live/config", (req, res) => {
    const ctx = (req as any).ctx;
    if (!ctx) return res.status(401).json({ error: "unauthorized" });

    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== "object") {
      return res.status(400).json({ error: "invalid body" });
    }

    try {
      // Read existing tenant config, merge mossLive section
      const existing = loadTenantConfig(ctx.tenantId, ctx.home);
      const mossLive = { ...(existing.mossLive ?? {}) };

      // Only update fields that are present in the body
      if (body.apiKey !== undefined) {
        // If the key looks masked (contains "..."), skip — don't overwrite with mask
        const key = body.apiKey as string;
        if (key && !key.includes("...")) {
          mossLive.apiKey = key;
        }
      }
      if (body.model !== undefined) mossLive.model = (body.model as string) || undefined;
      if (body.persona !== undefined) mossLive.persona = (body.persona as string) || undefined;
      if (body.instructions !== undefined) mossLive.instructions = (body.instructions as string) || undefined;

      const updated = { ...existing, mossLive };
      writeTenantConfig(ctx.tenantId, updated, ctx.home);
      log.info(`[moss-live] config updated for tenant=${ctx.tenantId}`);
      res.json({ ok: true });
    } catch (err) {
      log.error(`[moss-live] config update failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "failed to save config" });
    }
  });
}
