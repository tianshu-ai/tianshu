// Workspace seeding from templates/.
//
// When a tenant is created, we copy `templates/tenant-workspace/` into
// `<tenant>/workspace/_tenant/`. When a user is added to a tenant, we
// copy `templates/user-workspace/` into `<tenant>/workspace/users/<userId>/`.
//
// Templates ship in the server package's source tree (and dist tree after
// build). The TIANSHU_TEMPLATES_DIR env var overrides for tests / Docker.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTenantSharedDir,
  getTenantWorkspaceDir,
  getUserHomeDir,
} from "./paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve where the on-disk templates directory lives. */
export function getTemplatesDir(): string {
  const env = process.env.TIANSHU_TEMPLATES_DIR?.trim();
  if (env) return path.resolve(env);
  // src/core/templates.ts → ../../templates (relative to packages/server/src)
  return path.resolve(__dirname, "..", "..", "templates");
}

export const TENANT_TEMPLATE = "tenant-workspace";
export const USER_TEMPLATE = "user-workspace";

function copyDirRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) {
    // Templates not shipped (e.g. in some test setups) — leave the
    // destination empty rather than crashing. Higher-level code can
    // recover by lazily creating files when first accessed.
    fs.mkdirSync(dest, { recursive: true });
    return;
  }
  fs.cpSync(src, dest, { recursive: true });
}

/** Seed the tenant-shared `_tenant/` workspace. Idempotent on already-existing dirs. */
export function seedTenantWorkspace(tenantId: string, home?: string): void {
  const sharedDir = getTenantSharedDir(tenantId, home);
  if (fs.existsSync(sharedDir)) return;
  const templates = getTemplatesDir();
  copyDirRecursive(path.join(templates, TENANT_TEMPLATE), sharedDir);

  // Always ensure users/ container exists alongside _tenant/.
  const usersDir = path.join(getTenantWorkspaceDir(tenantId, home), "users");
  fs.mkdirSync(usersDir, { recursive: true });
}

/** Seed a user's home dir under workspace/users/<userId>/. Idempotent. */
export function seedUserWorkspace(tenantId: string, userId: string, home?: string): void {
  const userHome = getUserHomeDir(tenantId, userId, home);
  if (fs.existsSync(userHome)) return;
  const templates = getTemplatesDir();
  copyDirRecursive(path.join(templates, USER_TEMPLATE), userHome);
}

/**
 * Backfill missing template subtrees into an existing tenant.
 *
 * `seedTenantWorkspace` only fires the first time a tenant is
 * created — once `_tenant/` exists it bails out. That's correct
 * for SOUL.md / MEMORY.md (user may have edited them) but wrong
 * for additive config the host ships later, e.g. the
 * `_tenant/config/main/skills/skill-creator/` bundle that backs
 * the agent-managed skill workflow.
 *
 * `ensureTenantConfigDefaults` walks the template's `config/` tree
 * and copies each *missing* file/dir into the tenant. Existing
 * files are left alone, so a user-edited skill is never
 * overwritten. Skills the user removed will be re-seeded — that's
 * intentional; if you want to disable a builtin skill, set
 * `enabled: false` in its frontmatter rather than deleting the
 * directory.
 */
export function ensureTenantConfigDefaults(
  tenantId: string,
  home?: string,
): void {
  const templates = getTemplatesDir();
  const tenantConfigSrc = path.join(templates, TENANT_TEMPLATE, "config");
  if (!fs.existsSync(tenantConfigSrc)) return;
  const tenantConfigDst = path.join(
    getTenantSharedDir(tenantId, home),
    "config",
  );
  fs.mkdirSync(tenantConfigDst, { recursive: true });
  copyMissing(tenantConfigSrc, tenantConfigDst);
}

/** Copy files/dirs from `src` into `dst`, skipping anything already
 *  present at the destination. Symlinks are followed but not copied
 *  as symlinks — the tenant config tree is treated as plain data. */
function copyMissing(src: string, dst: string): void {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(dstPath)) {
        fs.cpSync(srcPath, dstPath, { recursive: true });
      } else {
        copyMissing(srcPath, dstPath);
      }
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (!fs.existsSync(dstPath)) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}
