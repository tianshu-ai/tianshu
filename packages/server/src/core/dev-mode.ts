// Dev-mode bootstrap.
//
// On first boot, if no tenants exist and the global config allows it, we
// auto-create a `default` tenant with a single dev user. This is what
// makes `git clone && npm run dev` work without any setup —
// the user opens http://localhost:5173, hits /api/health, and there's a
// real (if empty) tenant context backing them.
//
// The dev user has a fixed id `dev`. JWT-mode deployments must turn
// this off in global config (`autoCreateDefault: false`).

import {
  loadGlobalConfig,
  loadTenantConfig,
  writeTenantConfig,
  type GlobalConfig,
} from "./config.js";
import { GlobalOps } from "./global-ops.js";
import { getTianshuHome } from "./paths.js";

export const DEV_TENANT_ID = "default";
export const DEV_USER_ID = "dev";
export const DEV_USER_EXTERNAL_ID = "dev@local";
export const DEV_USER_PROVIDER = "dev";

export interface BootstrapResult {
  created: boolean;
  tenantId: string | null;
  userId: string | null;
}

export function bootstrapDevTenantIfNeeded(
  ops?: GlobalOps,
  cfg?: GlobalConfig,
): BootstrapResult {
  const home = getTianshuHome();
  const globalOps = ops ?? new GlobalOps({ home });
  const config = cfg ?? loadGlobalConfig(home);

  const allow = config.autoCreateDefault ?? true;
  if (!allow) return { created: false, tenantId: null, userId: null };

  const existing = globalOps.list();
  if (existing.length > 0) {
    return { created: false, tenantId: null, userId: null };
  }

  const ctx = globalOps.create(DEV_TENANT_ID);
  globalOps.ensureUser(ctx, {
    userId: DEV_USER_ID,
    provider: DEV_USER_PROVIDER,
    externalId: DEV_USER_EXTERNAL_ID,
    displayName: "Dev User",
  });

  // Pre-enable the `files` builtin plugin so a fresh dev tenant has
  // the basic chat workflow (browse + attach files — the files
  // plugin contributes both the right-side panel and the composer
  // paperclip button) out of the box. Per ADR-0003 §11, the other
  // builtin plugins ship opt-in (browser / task-board / ...).
  const tenantConfig = loadTenantConfig(DEV_TENANT_ID, home);
  writeTenantConfig(
    DEV_TENANT_ID,
    {
      ...tenantConfig,
      plugins: {
        ...(tenantConfig.plugins ?? {}),
        files: { enabled: true, ...(tenantConfig.plugins?.files ?? {}) },
      },
    },
    home,
  );

  return { created: true, tenantId: DEV_TENANT_ID, userId: DEV_USER_ID };
}
