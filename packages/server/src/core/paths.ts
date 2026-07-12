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

/** Global auth database: local password users + per-tenant roles.
 *  Global (not per-tenant) because users are platform-level entities
 *  that exist BEFORE any tenant context — you log in, THEN we know
 *  which tenant(s) you belong to. */
export function getAuthDbPath(home: string = getTianshuHome()): string {
  return path.join(home, "auth.db");
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

/** Per-tenant logs directory. Sibling to `db.sqlite`, not under
 *  `workspace/`, so that tenant-visible workspace tools never see
 *  these files. Created lazily on first write. */
export function getTenantLogsDir(tenantId: string, home?: string): string {
  return path.join(getTenantRoot(tenantId, home), "logs");
}

/** Per-tenant agent-config root, where SKILL.md trees, SOUL.md and
 *  related agent-facing files live. The chat handler scans this on
 *  every turn (no host restart required for new skills).
 *
 *  Layout:
 *    _tenant/config/skills/<name>/SKILL.md             — shared skills
 *    _tenant/config/main/skills/<name>/SKILL.md        — main agent only
 *    _tenant/config/workers/<kind>/skills/<name>/SKILL.md
 *                                                       — worker-kind only
 *  (More files like SOUL.md / MEMORY.md are reserved for follow-up
 *  changes; the directory shape is intentionally future-compatible.)
 */
export function getTenantConfigDir(tenantId: string, home?: string): string {
  return path.join(getTenantSharedDir(tenantId, home), "config");
}

export function getTenantSharedSkillsDir(
  tenantId: string,
  home?: string,
): string {
  return path.join(getTenantConfigDir(tenantId, home), "skills");
}

/** Per-tenant Solutions directory (ADR-0008). Each subdirectory is
 *  one solution slug:
 *    _tenant/solutions/<slug>/solution.json
 *    _tenant/solutions/<slug>/main-agent/prompt.md
 *    _tenant/solutions/<slug>/workers/<slug>/SOUL.md
 *  Sibling to config/ under _tenant/ so solutions travel with the
 *  tenant's shared area but stay distinct from live config. */
export function getTenantSolutionsDir(tenantId: string, home?: string): string {
  return path.join(getTenantSharedDir(tenantId, home), "solutions");
}

export function getTenantMainSkillsDir(
  tenantId: string,
  home?: string,
): string {
  return path.join(getTenantConfigDir(tenantId, home), "main", "skills");
}

/** Main-agent config directory: holds the applied solution's
 *  main-agent overrides (main-agent.json + prompt.md +
 *  override/fragment sidecars). Sibling to main/skills. */
export function getTenantMainConfigDir(tenantId: string, home?: string): string {
  return path.join(getTenantConfigDir(tenantId, home), "main");
}

export function getTenantWorkerSkillsDir(
  tenantId: string,
  workerKind: string,
  home?: string,
): string {
  return path.join(
    getTenantConfigDir(tenantId, home),
    "workers",
    workerKind,
    "skills",
  );
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
