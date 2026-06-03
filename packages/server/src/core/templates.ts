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
