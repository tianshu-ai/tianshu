// Thin REST helpers. Keeps fetch boilerplate out of components.

export interface Me {
  tenantId: string;
  userId: string;
  /** Human-friendly label: name → email → userId. */
  displayName?: string;
  email?: string | null;
  provider?: string | null;
  role?: "admin" | "member";
  /** Tenants this user may enter (for the tenant switcher). */
  tenants?: string[];
  config: { branding: { name?: string; emoji?: string } | null };
  defaultModel: { id: string; name: string; provider: string } | null;
  devTenant: boolean;
}

export interface ModelListEntry {
  id: string;
  name: string;
  provider: string;
  group: string | null;
  contextWindow: number;
  reasoning: boolean;
}

// Plugin Manager types — mirrored from server `PluginListEntry`
// (ADR-0003 §8). Keep these in sync if the server shape changes.
export type PluginState = "active" | "disabled" | "failed" | "client-bundle-missing";

export interface PluginConfigFieldGroup {
  id: string;
  label: string;
  badge?: string;
  description?: string;
}

interface PluginConfigFieldBase {
  key: string;
  label: string;
  description?: string;
  group?: PluginConfigFieldGroup;
}

export type PluginConfigField =
  | (PluginConfigFieldBase & { kind: "boolean"; default?: boolean })
  | (PluginConfigFieldBase & {
      kind: "number";
      default?: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    })
  | (PluginConfigFieldBase & {
      kind: "string";
      default?: string;
      placeholder?: string;
      multiline?: boolean;
    })
  | (PluginConfigFieldBase & {
      kind: "secret";
      placeholder?: string;
    })
  | (PluginConfigFieldBase & {
      kind: "select";
      default?: string;
      // Server always populates `options` (static, or resolved from a
      // dynamic `optionsSource` before serving). `optionsSource` is
      // informational for the UI.
      options?: Array<{ label: string; value: string }>;
      optionsSource?: string;
    });

export interface PluginConfigSchema {
  fields: PluginConfigField[];
}

export interface PluginListEntry {
  id: string;
  version: string;
  displayName: string;
  description: string | null;
  source: "builtin" | "tenant";
  state: PluginState;
  failedReason: string | null;
  contributes: Record<string, unknown>;
  /** manifest.client.entry — null when the plugin has no client side. */
  clientEntry: string | null;
  /** Declarative form schema; null when the plugin doesn't accept
   *  user-editable config. */
  configSchema: PluginConfigSchema | null;
  /** Persisted user-supplied config object. Empty when defaults. */
  config: Record<string, unknown>;
  /** ADR-0004 §3. Capabilities the plugin provides / requires, plus
   *  any required ones that no provider satisfied (only non-empty for
   *  failed plugins). */
  capabilities: {
    provided: string[];
    requires: string[];
    missing: string[];
  };
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  description: string;
  author: string;
  verified: boolean;
  repository: string;
  homepage?: string;
  license?: string;
  tags: string[];
  latestVersion: string;
  tarballUrl: string;
  tarballSha256: string;
  tarballSize?: number;
  tianshuRange: string;
}

export interface CatalogSnapshot {
  source: string;
  fetchedAt: string;
  catalogUpdatedAt: string | null;
  entries: CatalogEntry[];
  entriesDropped: number;
}

/**
 * When auth is enabled, an unauthenticated /api call 401s. Bounce the
 * user to the login page rather than surfacing a raw error deep in some
 * component. We only redirect once (guard flag) and skip when already
 * on /login to avoid loops. `/api/auth/*` and `/api/me` opt out so the
 * login page + boot probe can read a 401 without redirecting.
 */
let redirecting = false;
function maybeRedirectToLogin(status: number, path: string): void {
  if (status !== 401) return;
  if (redirecting) return;
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  if (path.startsWith("/api/auth/")) return;
  redirecting = true;
  window.location.assign("/login");
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) {
    maybeRedirectToLogin(r.status, path);
    throw new Error(`${path} → ${r.status}`);
  }
  const text = await r.text();
  if (!text) throw new Error(`${path} returned empty body`);
  return JSON.parse(text) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return mutateJson<T>(path, "PATCH", body);
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  return mutateJson<T>(path, "POST", body);
}

async function mutateJson<T>(
  path: string,
  method: "PATCH" | "POST" | "PUT" | "DELETE",
  body?: unknown,
): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    maybeRedirectToLogin(r.status, path);
    let message = `${path} → ${r.status}`;
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        message = `${message} (${(parsed as { error: string }).error})`;
      }
    } catch {
      /* swallow JSON parse errors — keep the status-code message */
    }
    throw new Error(message);
  }
  return JSON.parse(text) as T;
}

/** A session row that lives on the chat shell's sidebar because
 *  it's the persistent thread for a channel (wechat / telegram /
 *  etc.). The chat-store fetches these on init + on /admin/wechat
 *  changes (handled by refreshChannelSessions). */
export interface ChannelSessionEntry {
  id: string;
  channelId: string;
  channelChatId: string;
  channelBindingId: string | null;
  title: string | null;
  createdAt: number;
}

export const api = {
  me: () => getJson<Me>("/api/me"),
  channelSessions: () =>
    getJson<{ sessions: ChannelSessionEntry[] }>("/api/channel-sessions").then(
      (r) => r.sessions,
    ),
  models: () => getJson<{ models: ModelListEntry[]; defaultModel: string | null }>("/api/models"),
  plugins: () => getJson<{ plugins: PluginListEntry[] }>("/api/plugins"),
  setPluginEnabled: (id: string, enabled: boolean) =>
    patchJson<{ plugins: PluginListEntry[] }>(`/api/plugins/${encodeURIComponent(id)}`, {
      enabled,
    }),
  setPluginConfig: (id: string, config: Record<string, unknown>) =>
    patchJson<{ plugins: PluginListEntry[] }>(`/api/plugins/${encodeURIComponent(id)}`, {
      config,
    }),
  /** ADR-0004 §16: explicit re-discovery of on-disk plugins. */
  refreshPlugins: () => postJson<{ plugins: PluginListEntry[] }>("/api/plugins/refresh"),
  pluginCatalog: () => getJson<CatalogSnapshot>("/api/plugins/catalog"),
  refreshPluginCatalog: () => postJson<CatalogSnapshot>("/api/plugins/catalog/refresh"),

  // ── Auth ──
  /** Public: is auth on + which providers to show on the login page. */
  authConfig: () =>
    getJson<AuthPublicConfig>("/api/auth/config"),
  /** Local password login. */
  login: (username: string, password: string) =>
    postJson<{ ok: boolean; userId: string; tenantId: string }>("/api/auth/login", {
      username,
      password,
    }),
  /** Self-registration (when allowRegistration). */
  register: (username: string, password: string, email?: string) =>
    postJson<{ ok: boolean; userId: string }>("/api/auth/register", { username, password, email }),
  /** Admin: existing tenants + disabled state. */
  adminTenants: () =>
    getJson<{ tenants: string[]; detail: AdminTenant[] }>("/api/admin/tenants"),
  /** Super-admin: create a tenant (new agent+workers instance). */
  adminCreateTenant: (id: string) =>
    postJson<{ ok: boolean; id: string }>("/api/admin/tenants", { id }),
  /** Super-admin: enable/disable a tenant (soft off-switch). */
  adminSetTenantDisabled: (id: string, disabled: boolean) =>
    mutateJson<{ ok: boolean; id: string; disabled: boolean }>(
      `/api/admin/tenants/${encodeURIComponent(id)}`,
      "PATCH",
      { disabled },
    ),
  /** Admin: list local users + their per-tenant roles. */
  adminUsers: () => getJson<{ users: AdminLocalUser[] }>("/api/admin/users"),
  adminCreateUser: (username: string, password: string, email?: string) =>
    postJson<{ ok: boolean; id: string }>("/api/admin/users", { username, password, email }),
  adminSetPassword: (id: string, password: string) =>
    patchJson<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(id)}/password`, { password }),
  adminDeleteUser: (id: string) =>
    mutateJson<{ ok: boolean }>(`/api/admin/users/${encodeURIComponent(id)}`, "DELETE"),
  adminSetRole: (id: string, tenantId: string, role: "admin" | "member") =>
    mutateJson<{ ok: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}/roles/${encodeURIComponent(tenantId)}`,
      "PUT",
      { role },
    ),
  adminRemoveRole: (id: string, tenantId: string) =>
    mutateJson<{ ok: boolean }>(
      `/api/admin/users/${encodeURIComponent(id)}/roles/${encodeURIComponent(tenantId)}`,
      "DELETE",
    ),
  /** Admin: full auth config (secrets redacted to *Set booleans). */
  adminAuth: () => getJson<AdminAuthConfig>("/api/admin/auth"),
  /** Admin: patch auth config; server re-arms the chain on next request. */
  patchAdminAuth: (patch: Partial<AdminAuthPatch>) =>
    patchJson<{ ok: boolean; enabled: boolean }>("/api/admin/auth", patch),
  /** Clear the session cookie. */
  logout: () => postJson<{ ok: boolean }>("/api/auth/logout"),
  /** Switch the session to another tenant the user has access to. */
  switchTenant: (tenantId: string) =>
    postJson<{ ok: boolean; tenantId: string }>("/api/auth/switch-tenant", { tenantId }),
};

export interface AuthPublicConfig {
  enabled: boolean;
  providers: Array<{ id: string; displayName: string }>;
  localLogin: boolean;
  allowRegistration: boolean;
}

export interface AdminTenant {
  id: string;
  disabled: boolean;
}

export interface AdminLocalUser {
  id: string;
  username: string;
  email: string | null;
  createdAt: number;
  roles: Array<{ tenantId: string; role: "admin" | "member" }>;
  /** Config-declared super-admin: all permissions across all tenants
   *  (empty `roles` is expected — authority comes from config). */
  superAdmin: boolean;
}

export interface AdminAuthProvider {
  id: string;
  displayName: string;
  issuer: string | null;
  authorizeUrl: string | null;
  tokenUrl: string | null;
  userInfoUrl: string | null;
  clientId: string;
  clientSecretSet: boolean;
  scopes: string[] | null;
  claims: { subject?: string; email?: string; name?: string } | null;
}

export interface AdminAuthConfig {
  enabled: boolean;
  allowRegistration: boolean;
  viewerIsSuperAdmin: boolean;
  admins: string[];
  sessionSecretSet: boolean;
  providers: AdminAuthProvider[];
}

export interface AdminAuthPatch {
  enabled: boolean;
  sessionSecret: string;
  admins: string[];
  providers: unknown[];
  allowRegistration: boolean;
  sessionTtlSec: number;
}
