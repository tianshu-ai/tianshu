// Deriving a stable tianshu identity (userId + tenantId + role) from a
// provider identity + the auth config. Pure functions, no I/O — easy to
// unit test.

import { createHash } from "node:crypto";
import type { AuthConfig } from "../config.js";
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
 * The set of tenants a user may enter, in the tianshu model where
 *   tenant = one agent + its workers (an "instance"/workspace)
 *   user   = a session inside that instance (many users share the
 *            same agent/workers/workspace, each with their own chat).
 *
 * Membership — not a global strategy — decides which tenant(s) a login
 * lands in:
 *   - super-admin  → every existing tenant (they can enter anything).
 *   - otherwise    → the tenants they have a `tenant_roles` grant for.
 *
 * Returns the candidate tenant ids. The caller picks:
 *   1 → enter it; N → let the user choose; 0 → reject (needs an admin
 *   to grant access first).
 */
export function tenantsForUser(
  cfg: AuthConfig,
  store: Pick<UserStore, "rolesForUser">,
  who: { userId: string; email?: string | null; username?: string | null },
  allTenants: () => string[],
  isDisabled: (tenantId: string) => boolean = () => false,
): string[] {
  const candidates = isSuperAdmin(cfg, who)
    ? allTenants()
    : store.rolesForUser(who.userId).map((r) => r.tenantId);
  // A disabled tenant can't be entered by anyone — filter it out of the
  // login candidate set so the picker never offers it.
  return candidates.filter((t) => !isDisabled(t));
}
