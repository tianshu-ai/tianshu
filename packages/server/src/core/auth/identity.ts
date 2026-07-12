// Deriving a stable tianshu identity (userId + tenantId + role) from a
// provider identity + the auth config. Pure functions, no I/O — easy to
// unit test.

import { createHash } from "node:crypto";
import type { AuthConfig } from "../config.js";
import type { ProviderIdentity } from "./oauth.js";
import type { TenantRole, UserStore } from "./user-store.js";

/**
 * Is this identity a GLOBAL super-admin (all permissions, all tenants)?
 * Super-admins are config-declared: by OAuth email (`auth.admins`) or by
 * local username (`auth.superAdmins`). This overrides any per-tenant role.
 */
export function isSuperAdmin(
  cfg: AuthConfig,
  who: { email?: string | null; username?: string | null },
): boolean {
  if (who.email) {
    const admins = (cfg.admins ?? []).map((e) => e.trim().toLowerCase());
    if (admins.includes(who.email.trim().toLowerCase())) return true;
  }
  if (who.username) {
    const supers = (cfg.superAdmins ?? []).map((s) => s.username.trim().toLowerCase());
    if (supers.includes(who.username.trim().toLowerCase())) return true;
  }
  return false;
}

/** @deprecated use `isSuperAdmin` — kept for the existing OAuth email path. */
export function roleForEmail(email: string, cfg: AuthConfig): "admin" | "member" {
  return isSuperAdmin(cfg, { email }) ? "admin" : "member";
}

/**
 * Resolve a user's effective role IN A GIVEN TENANT.
 *
 * Precedence:
 *   1. config super-admin (email or username) → "admin" everywhere.
 *   2. auth.db tenant_roles(userId, tenantId) → that role.
 *   3. nothing → "member" (a signed-in user with no explicit grant is a
 *      plain member of the tenant they resolved into).
 */
export function resolveTenantRole(
  cfg: AuthConfig,
  store: Pick<UserStore, "getRole">,
  who: { userId: string; tenantId: string; email?: string | null; username?: string | null },
): TenantRole {
  if (isSuperAdmin(cfg, who)) return "admin";
  return store.getRole(who.userId, who.tenantId) ?? "member";
}

/**
 * Stable userId for a provider identity. We hash `provider:subject` so
 * the id is opaque, provider-scoped (no collision across providers),
 * and safe as a filesystem/id token. Prefixed `u_` + 24 hex chars.
 */
export function deriveUserId(providerId: string, subject: string): string {
  const h = createHash("sha256").update(`${providerId}:${subject}`).digest("hex");
  return `u_${h.slice(0, 24)}`;
}

/**
 * Tenant assignment for a freshly-authed user.
 *   "single" → everyone lands in `singleTenant` (default "default").
 *   "email"  → one tenant per user, derived from the email local-part,
 *              sanitized to the tenant-id charset. Falls back to a hash
 *              suffix if the local-part sanitizes to something invalid.
 */
export function deriveTenantId(identity: ProviderIdentity, cfg: AuthConfig): string {
  const strategy = cfg.tenantStrategy ?? "single";
  if (strategy === "single") {
    return cfg.singleTenant ?? "default";
  }
  // "email" strategy.
  const local = identity.email.split("@")[0] ?? "";
  let candidate = local.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  candidate = candidate.replace(/^-+/, "").replace(/-+$/, "");
  // tenant-id rules: 2..32 chars, can't start with "_". Pad/trim + hash
  // fallback keeps it valid without colliding across different emails.
  if (candidate.length < 2 || /^_/.test(candidate)) {
    const h = createHash("sha256").update(identity.email).digest("hex").slice(0, 8);
    candidate = `u-${h}`;
  }
  return candidate.slice(0, 32);
}
