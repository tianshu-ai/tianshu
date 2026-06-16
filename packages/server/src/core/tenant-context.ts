// A TenantContext is the per-request "everything you need to do work for
// this tenant" handle. Routes don't take a tenantId string — they take
// a TenantContext, so by construction they cannot accidentally swap
// tenants halfway through a handler.

import type { Database as DB } from "better-sqlite3";
import { resolveTenantConfig, type ResolvedConfig } from "./config.js";
import {
  getTenantLogsDir,
  getTenantRoot,
  getTenantSecretsDir,
  getTenantSharedDir,
  getTenantWorkspaceDir,
  getUserHomeDir,
} from "./paths.js";

export class TenantContext {
  constructor(
    public readonly tenantId: string,
    public readonly db: DB,
    public readonly config: ResolvedConfig,
    public readonly home: string,
  ) {}

  get root(): string {
    return getTenantRoot(this.tenantId, this.home);
  }

  get workspaceDir(): string {
    return getTenantWorkspaceDir(this.tenantId, this.home);
  }

  get sharedDir(): string {
    return getTenantSharedDir(this.tenantId, this.home);
  }

  get secretsDir(): string {
    return getTenantSecretsDir(this.tenantId, this.home);
  }

  get logsDir(): string {
    return getTenantLogsDir(this.tenantId, this.home);
  }

  userHomeDir(userId: string): string {
    return getUserHomeDir(this.tenantId, userId, this.home);
  }
}

/** Build a TenantContext given a freshly-opened DB and the tenantId. */
export function buildTenantContext(
  tenantId: string,
  db: DB,
  home: string,
): TenantContext {
  const config = resolveTenantConfig(tenantId, home);
  return new TenantContext(tenantId, db, config, home);
}
