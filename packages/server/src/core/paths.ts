// Filesystem layout for Tianshu, per ADR-0001.
//
//   <TIANSHU_HOME>/
//   ├── config.json
//   └── tenants/
//       ├── <tenantId>/
//       │   ├── config.json
//       │   ├── db.sqlite
//       │   ├── secrets/
//       │   └── workspace/
//       └── <tenantId>.deleted/
//
// Default TIANSHU_HOME is ~/.tianshu but every test, every CLI invocation,
// and every container deploy can override it via the env var. Centralising
// path math here keeps the rest of the server code from sprinkling
// path.join(...) and lets tests use isolated temp dirs trivially.

import os from "node:os";
import path from "node:path";

export const SOFT_DELETE_SUFFIX = ".deleted";

const SYSTEM_PREFIX = "_";

/** Reserved tenant ids that must not be allowed even if the regex passes. */
const RESERVED_TENANT_IDS = new Set(["", ".", "..", "tenants", "config", "global"]);

/** Resolve TIANSHU_HOME at call time so tests can monkey-patch process.env. */
export function getTianshuHome(): string {
  const env = process.env.TIANSHU_HOME?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".tianshu");
}

export function getGlobalConfigPath(home: string = getTianshuHome()): string {
  return path.join(home, "config.json");
}

export function getTenantsRoot(home: string = getTianshuHome()): string {
  return path.join(home, "tenants");
}

export function getTenantRoot(tenantId: string, home: string = getTianshuHome()): string {
  return path.join(getTenantsRoot(home), tenantId);
}

export function getTenantConfigPath(tenantId: string, home?: string): string {
  return path.join(getTenantRoot(tenantId, home), "config.json");
}

export function getTenantDbPath(tenantId: string, home?: string): string {
  return path.join(getTenantRoot(tenantId, home), "db.sqlite");
}

export function getTenantSecretsDir(tenantId: string, home?: string): string {
  return path.join(getTenantRoot(tenantId, home), "secrets");
}

export function getTenantWorkspaceDir(tenantId: string, home?: string): string {
  return path.join(getTenantRoot(tenantId, home), "workspace");
}

export function getTenantSharedDir(tenantId: string, home?: string): string {
  return path.join(getTenantWorkspaceDir(tenantId, home), "_tenant");
}

export function getTenantUsersDir(tenantId: string, home?: string): string {
  return path.join(getTenantWorkspaceDir(tenantId, home), "users");
}

export function getUserHomeDir(tenantId: string, userId: string, home?: string): string {
  return path.join(getTenantUsersDir(tenantId, home), userId);
}

export function getDeletedTenantPath(
  tenantId: string,
  timestamp: number,
  home: string = getTianshuHome(),
): string {
  return path.join(getTenantsRoot(home), `${tenantId}.deleted.${timestamp}`);
}

/** True for any soft-deleted directory name like `myorg.deleted` or `myorg.deleted.171…`. */
export function isSoftDeletedDirName(name: string): boolean {
  return name === SOFT_DELETE_SUFFIX.slice(1) // edge case: literally ".deleted"
    ? false
    : name.includes(SOFT_DELETE_SUFFIX);
}

/** True iff a name starts with the system-reserved underscore prefix. */
export function isSystemReserved(name: string): boolean {
  return name.startsWith(SYSTEM_PREFIX);
}

/**
 * Validate a path is within `root` after canonicalisation.
 *
 * Used by every tool / API endpoint that takes a user-supplied path.
 * Returns the resolved absolute path on success, or throws.
 *
 * Note we do NOT call fs.realpath because (a) the path may not exist yet
 * and (b) we explicitly do not want to follow symlinks out of root.
 */
export function ensureInside(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);

  // path.relative gives "../something" when escaping; absolute paths get
  // resolved first so an absolute candidate that doesn't start with root
  // is also caught.
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return resolved;
  }
  throw new Error(`path escapes root: ${candidate} (root=${resolvedRoot})`);
}

export const __forTest = { RESERVED_TENANT_IDS, SYSTEM_PREFIX };
