// Auth admin page (Settings → Admin). Host-shipped core page.
//
// What it does:
//   - Master switch: turn user-authentication on/off (writes
//     config.json → auth.enabled; the server re-arms the resolver
//     chain on the next request).
//   - Session secret: shows whether one is set; lets you set/replace it
//     (write-only; the value never comes back to the browser).
//   - Tenant strategy: single vs. email.
//   - Admin allow-list: READ-ONLY here — per project decision, admins
//     live in the config file (`auth.admins`). We show them + a note.
//   - OAuth providers: fully config-driven, generic OAuth2/OIDC. Add /
//     edit / remove providers by endpoint or OIDC issuer. Secrets are
//     write-only (mask sentinel, same pattern as the Models page).
//
// GET  /api/admin/auth   → load (secrets redacted to *Set booleans)
// PATCH /api/admin/auth  → save

import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  UserPlus,
  ShieldPlus,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import {
  api,
  type AdminAuthConfig,
  type AdminAuthProvider,
  type AdminLocalUser,
} from "../../lib/api";

const SECRET_MASK = "__stored__";

interface ProviderDraft {
  id: string;
  displayName: string;
  clientId: string;
  clientSecret: string; // mask sentinel on load
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string; // space/comma separated in the UI
  claimsSubject: string;
  claimsEmail: string;
  claimsName: string;
}

function toDraft(p: AdminAuthProvider): ProviderDraft {
  return {
    id: p.id,
    displayName: p.displayName ?? "",
    clientId: p.clientId ?? "",
    clientSecret: p.clientSecretSet ? SECRET_MASK : "",
    issuer: p.issuer ?? "",
    authorizeUrl: p.authorizeUrl ?? "",
    tokenUrl: p.tokenUrl ?? "",
    userInfoUrl: p.userInfoUrl ?? "",
    scopes: (p.scopes ?? []).join(" "),
    claimsSubject: p.claims?.subject ?? "",
    claimsEmail: p.claims?.email ?? "",
    claimsName: p.claims?.name ?? "",
  };
}

function draftToWire(d: ProviderDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id.trim(),
    clientId: d.clientId.trim(),
  };
  if (d.displayName.trim()) out.displayName = d.displayName.trim();
  // Secret: keep stored (mask) → omit; empty → omit; new value → send.
  if (d.clientSecret && d.clientSecret !== SECRET_MASK) out.clientSecret = d.clientSecret;
  else if (d.clientSecret === SECRET_MASK) out.clientSecret = SECRET_MASK; // server keeps existing
  if (d.issuer.trim()) out.issuer = d.issuer.trim();
  if (d.authorizeUrl.trim()) out.authorizeUrl = d.authorizeUrl.trim();
  if (d.tokenUrl.trim()) out.tokenUrl = d.tokenUrl.trim();
  if (d.userInfoUrl.trim()) out.userInfoUrl = d.userInfoUrl.trim();
  const scopes = d.scopes.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (scopes.length) out.scopes = scopes;
  const claims: Record<string, string> = {};
  if (d.claimsSubject.trim()) claims.subject = d.claimsSubject.trim();
  if (d.claimsEmail.trim()) claims.email = d.claimsEmail.trim();
  if (d.claimsName.trim()) claims.name = d.claimsName.trim();
  if (Object.keys(claims).length) out.claims = claims;
  return out;
}

/** Shared page shell: title bar + Reload/Save + error/saved banners. */
function PageShell({
  title,
  onReload,
  onSave,
  saving,
  error,
  saved,
  children,
}: {
  title: string;
  onReload?: () => void;
  onSave?: () => void;
  saving?: boolean;
  error?: string | null;
  saved?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} className="text-brand-400" />
          <h1 className="text-lg font-semibold text-fg-default">{title}</h1>
        </div>
        {(onReload || onSave) && (
          <div className="flex items-center gap-2">
            {onReload && (
              <button
                type="button"
                onClick={onReload}
                className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm text-fg-muted hover:text-fg-default"
              >
                <RefreshCw size={14} /> Reload
              </button>
            )}
            {onSave && (
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-60"
              >
                <Save size={14} /> {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      {saved && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-emerald-700/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
          <CheckCircle2 size={14} /> Saved. The server re-arms auth on the next request.
        </div>
      )}
      {children}
    </div>
  );
}

// ── Tab 1: Settings — master switch, session secret, registration,
//    super-admins (read-only). PATCHes only its own fields. ──
export function AuthSettingsPage() {
  const [cfg, setCfg] = useState<AdminAuthConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [allowRegistration, setAllowRegistration] = useState(false);
  const [sessionSecret, setSessionSecret] = useState("");
  const [sessionSecretSet, setSessionSecretSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await api.adminAuth();
      setCfg(c);
      setEnabled(c.enabled);
      setAllowRegistration(c.allowRegistration);
      setSessionSecretSet(c.sessionSecretSet);
      setSessionSecret(c.sessionSecretSet ? SECRET_MASK : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const patch: Record<string, unknown> = { enabled, allowRegistration };
      if (sessionSecret && sessionSecret !== SECRET_MASK) patch.sessionSecret = sessionSecret;
      await api.patchAdminAuth(patch);
      setSaved(true);
      await load();
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [enabled, allowRegistration, sessionSecret, load]);

  if (loading) return <div className="p-6 text-sm text-fg-faint">Loading…</div>;

  return (
    <PageShell
      title="Auth · Settings"
      onReload={() => void load()}
      onSave={() => void save()}
      saving={saving}
      error={error}
      saved={saved}
    >
      {/* Master switch */}
      <section className="mb-6 rounded-xl border border-border-subtle bg-bg-elevated p-4">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium text-fg-default">Require sign-in</span>
            <span className="block text-xs text-fg-faint">
              When on, unauthenticated requests are rejected and users must log
              in. When off, the app runs in open dev mode.
            </span>
          </span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-5 w-5 accent-brand-500"
          />
        </label>

        {enabled && (
          <div className="mt-4 grid gap-3 border-t border-border-subtle pt-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-xs text-fg-faint">Session secret</span>
              <input
                type="password"
                value={sessionSecret}
                onChange={(e) => setSessionSecret(e.target.value)}
                placeholder={sessionSecretSet ? "(stored — type to replace)" : "set a secret or ${VAR}"}
                className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-fg-default"
              />
            </label>
            <label className="flex items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                checked={allowRegistration}
                onChange={(e) => setAllowRegistration(e.target.checked)}
                className="h-4 w-4 accent-brand-500"
              />
              <span className="text-fg-default">Allow self-registration</span>
            </label>
            <p className="text-xs text-fg-faint sm:col-span-2">
              A tenant = one agent + its workers. A user is a session inside it;
              which tenant(s) a login can enter is decided by per-tenant roles
              (see Users), not a global rule.
            </p>
          </div>
        )}
      </section>

      {/* Super-admins (read-only, config-declared) */}
      <section className="rounded-xl border border-border-subtle bg-bg-elevated p-4">
        <div className="mb-2 text-sm font-medium text-fg-default">Super-admins</div>
        <p className="mb-2 text-xs text-fg-faint">
          Global admins with all permissions across all tenants. Declared in
          the config file (<code className="rounded bg-bg-raised px-1">auth.admins</code> by
          OAuth email, <code className="rounded bg-bg-raised px-1">auth.superAdmins</code> for
          local accounts). Edit <code className="rounded bg-bg-raised px-1">~/.tianshu/config.json</code>.
        </p>
        {cfg && cfg.admins.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5">
            {cfg.admins.map((a) => (
              <li key={a} className="rounded-full border border-border-default bg-bg-raised px-2.5 py-0.5 text-xs text-fg-muted">
                {a}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-fg-fainter">no OAuth super-admin emails configured</span>
        )}
      </section>
    </PageShell>
  );
}

// ── Tab 2: Providers — OAuth/OIDC. PATCHes only providers. ──
export function AuthProvidersPage() {
  const [providers, setProviders] = useState<ProviderDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await api.adminAuth();
      setProviders(c.providers.map(toDraft));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.patchAdminAuth({ providers: providers.map(draftToWire) });
      setSaved(true);
      await load();
      window.setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [providers, load]);

  const addProvider = () =>
    setProviders((prev) => [
      ...prev,
      {
        id: "", displayName: "", clientId: "", clientSecret: "", issuer: "",
        authorizeUrl: "", tokenUrl: "", userInfoUrl: "",
        scopes: "openid email profile", claimsSubject: "", claimsEmail: "", claimsName: "",
      },
    ]);
  const patchProvider = (i: number, patch: Partial<ProviderDraft>) =>
    setProviders((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const removeProvider = (i: number) =>
    setProviders((prev) => prev.filter((_, idx) => idx !== i));

  if (loading) return <div className="p-6 text-sm text-fg-faint">Loading…</div>;

  return (
    <PageShell
      title="Auth · Providers"
      onReload={() => void load()}
      onSave={() => void save()}
      saving={saving}
      error={error}
      saved={saved}
    >
      <section className="rounded-xl border border-border-subtle bg-bg-elevated p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-fg-default">OAuth / OIDC providers</div>
            <div className="text-xs text-fg-faint">
              Generic + config-driven. Give an OIDC issuer (discovery) or explicit
              endpoints. GitHub, Google, Lark, Keycloak … are all just a config entry.
            </div>
          </div>
          <button
            type="button"
            onClick={addProvider}
            className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm text-fg-muted hover:text-fg-default"
          >
            <Plus size={14} /> Add
          </button>
        </div>

        {providers.length === 0 && (
          <div className="rounded-md border border-border-subtle bg-bg-raised/40 px-3 py-3 text-center text-xs text-fg-faint">
            No providers configured yet.
          </div>
        )}

        <div className="flex flex-col gap-3">
          {providers.map((p, i) => (
            <div key={i} className="rounded-lg border border-border-subtle bg-bg-base p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-mono text-fg-muted">{p.id || "(new provider)"}</span>
                <button
                  type="button"
                  onClick={() => removeProvider(i)}
                  className="text-fg-fainter hover:text-danger"
                  title="Remove"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="id" value={p.id} onChange={(v) => patchProvider(i, { id: v })} placeholder="my-sso" />
                <Field label="display name" value={p.displayName} onChange={(v) => patchProvider(i, { displayName: v })} placeholder="Company SSO" />
                <Field label="client id" value={p.clientId} onChange={(v) => patchProvider(i, { clientId: v })} placeholder="${OIDC_CLIENT_ID}" />
                <Field label="client secret" type="password" value={p.clientSecret} onChange={(v) => patchProvider(i, { clientSecret: v })} placeholder="${OIDC_CLIENT_SECRET}" />
                <Field label="issuer (OIDC discovery)" value={p.issuer} onChange={(v) => patchProvider(i, { issuer: v })} placeholder="https://sso.example.com/realms/main" />
                <Field label="scopes" value={p.scopes} onChange={(v) => patchProvider(i, { scopes: v })} placeholder="openid email profile" />
                <Field label="authorize url (or use issuer)" value={p.authorizeUrl} onChange={(v) => patchProvider(i, { authorizeUrl: v })} placeholder="https://github.com/login/oauth/authorize" />
                <Field label="token url" value={p.tokenUrl} onChange={(v) => patchProvider(i, { tokenUrl: v })} placeholder="https://github.com/login/oauth/access_token" />
                <Field label="userinfo url" value={p.userInfoUrl} onChange={(v) => patchProvider(i, { userInfoUrl: v })} placeholder="https://api.github.com/user" />
                <Field label="claim: subject" value={p.claimsSubject} onChange={(v) => patchProvider(i, { claimsSubject: v })} placeholder="sub" />
                <Field label="claim: email" value={p.claimsEmail} onChange={(v) => patchProvider(i, { claimsEmail: v })} placeholder="email" />
                <Field label="claim: name" value={p.claimsName} onChange={(v) => patchProvider(i, { claimsName: v })} placeholder="name" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </PageShell>
  );
}

// ── Tab 3: Users — local accounts + per-tenant roles. ──
export function AuthUsersPage() {
  return (
    <PageShell title="Auth · Users">
      <LocalUsersSection />
    </PageShell>
  );
}

// ── Tab 4: Tenants — super-admin only. ──
export function AuthTenantsPage() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .adminAuth()
      .then((c) => {
        if (!cancelled) setAllowed(c.viewerIsSuperAdmin);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  if (allowed === null) return <div className="p-6 text-sm text-fg-faint">Loading…</div>;
  return (
    <PageShell title="Auth · Tenants">
      {allowed ? (
        <TenantsSection />
      ) : (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-3 text-sm text-amber-200">
          Tenant management is restricted to super-admins.
        </div>
      )}
    </PageShell>
  );
}

function TenantsSection() {
  const [tenants, setTenants] = useState<import("../../lib/api").AdminTenant[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.adminTenants();
      setTenants(r.detail);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.adminCreateTenant(newId.trim());
      setNewId("");
      setCreating(false);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (id: string, disabled: boolean) => {
    setErr(null);
    try {
      await api.adminSetTenantDisabled(id, disabled);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="mb-6 rounded-xl border border-border-subtle bg-bg-elevated p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-fg-default">Tenants</div>
          <div className="text-xs text-fg-faint">
            A tenant = one agent + its workers. Super-admin only. Disabling
            is a soft off-switch (logins can’t enter, in-flight requests are
            rejected) — on-disk data is untouched. To really delete a tenant,
            remove its directory under ~/.tianshu/tenants/ by hand.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
        >
          <Plus size={15} /> Create tenant
        </button>
      </div>

      {err && (
        <div className="mb-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">
          {err}
        </div>
      )}

      {tenants.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-fg-fainter">
          No tenants.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tenants.map((t) => (
            <div
              key={t.id}
              className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-base p-3"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-fg-default">{t.id}</span>
                {t.disabled && (
                  <span className="rounded-full border border-amber-700/40 bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-200">
                    disabled
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void toggle(t.id, !t.disabled)}
                className={
                  "rounded-md border px-2.5 py-1 text-xs " +
                  (t.disabled
                    ? "border-border-default text-fg-muted hover:bg-bg-raised hover:text-fg-default"
                    : "border-border-default text-fg-muted hover:border-amber-700/60 hover:text-amber-200")
                }
              >
                {t.disabled ? "Enable" : "Disable"}
              </button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal isOpen onClose={() => setCreating(false)} title="Create tenant" size="sm" allowMaximize={false}>
          <div className="flex flex-col gap-3 p-1">
            <p className="text-xs text-fg-faint">
              Creates a new agent + workers instance (dirs, db, workspace seed).
              Id: 2–32 chars, lowercase letters/digits/-/_, no leading _.
            </p>
            <Field label="Tenant id" value={newId} onChange={setNewId} placeholder="acme" />
            <div className="mt-1 flex justify-end gap-2">
              <ModalBtn kind="ghost" onClick={() => setCreating(false)}>Cancel</ModalBtn>
              <ModalBtn kind="primary" disabled={newId.trim().length < 2 || busy} onClick={() => void create()}>
                {busy ? "Creating…" : "Create"}
              </ModalBtn>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function LocalUsersSection() {
  const [users, setUsers] = useState<AdminLocalUser[]>([]);
  const [tenants, setTenants] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Which modal is open (null = none). Buttons open these; no window.prompt.
  const [creating, setCreating] = useState(false);
  const [pwUser, setPwUser] = useState<AdminLocalUser | null>(null);
  const [roleUser, setRoleUser] = useState<AdminLocalUser | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [u, t] = await Promise.all([api.adminUsers(), api.adminTenants()]);
      setUsers(u.users);
      setTenants(t.tenants);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const del = async (u: AdminLocalUser) => {
    if (!window.confirm(`Delete user "${u.username}"? This removes all their tenant roles.`)) return;
    await api.adminDeleteUser(u.id);
    await load();
  };
  const rmRole = async (id: string, tenantId: string) => {
    await api.adminRemoveRole(id, tenantId);
    await load();
  };

  return (
    <section className="mb-6 rounded-xl border border-border-subtle bg-bg-elevated p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-fg-default">Local users</div>
          <div className="text-xs text-fg-faint">
            Username/password accounts. Roles are per tenant — a user can be
            admin in one tenant and member in another. Super-admins override
            these everywhere.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
        >
          <UserPlus size={15} /> Add user
        </button>
      </div>

      {err && (
        <div className="mb-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">
          {err}
        </div>
      )}

      {users.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-fg-fainter">
          No local users yet. Click “Add user” to create one.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {users.map((u) => (
            <div key={u.id} className="rounded-lg border border-border-subtle bg-bg-base p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-fg-default">{u.username}</div>
                  {u.email && <div className="truncate text-xs text-fg-faint">{u.email}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setRoleUser(u)}
                    className="flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted hover:bg-bg-raised hover:text-fg-default"
                  >
                    <ShieldPlus size={13} /> Roles
                  </button>
                  <button
                    type="button"
                    onClick={() => setPwUser(u)}
                    className="flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted hover:bg-bg-raised hover:text-fg-default"
                  >
                    <KeyRound size={13} /> Password
                  </button>
                  <button
                    type="button"
                    onClick={() => void del(u)}
                    className="flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted hover:border-rose-700/60 hover:text-danger"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              </div>
              {/* Per-tenant roles */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {u.superAdmin ? (
                  <span className="rounded-full border border-brand-500/40 bg-brand-600/15 px-2 py-0.5 text-[11px] font-medium text-brand-300">
                    super-admin · all tenants
                  </span>
                ) : u.roles.length === 0 ? (
                  <span className="text-[11px] text-fg-fainter">no tenant roles — can’t sign in until granted one</span>
                ) : (
                  u.roles.map((r) => (
                    <span
                      key={r.tenantId}
                      className="flex items-center gap-1.5 rounded-full border border-border-default bg-bg-raised px-2 py-0.5 text-[11px] text-fg-muted"
                    >
                      <span className="font-mono">{r.tenantId}</span>
                      <span className={r.role === "admin" ? "font-medium text-brand-400" : ""}>{r.role}</span>
                      <button
                        type="button"
                        onClick={() => void rmRole(u.id, r.tenantId)}
                        className="ml-0.5 text-fg-fainter hover:text-danger"
                        title="Remove role"
                      >
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create-user modal */}
      {creating && (
        <CreateUserModal
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void load();
          }}
        />
      )}
      {/* Reset-password modal */}
      {pwUser && (
        <SetPasswordModal
          user={pwUser}
          onClose={() => setPwUser(null)}
          onDone={() => setPwUser(null)}
        />
      )}
      {/* Assign-role modal */}
      {roleUser && (
        <AssignRoleModal
          user={roleUser}
          tenants={tenants}
          onClose={() => setRoleUser(null)}
          onDone={() => {
            setRoleUser(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function CreateUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = username.trim().length >= 2 && password.length >= 6;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.adminCreateUser(username.trim(), password, email.trim() || undefined);
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Add local user" size="sm" allowMaximize={false}>
      <div className="flex flex-col gap-3 p-1">
        {err && <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">{err}</div>}
        <Field label="Username" value={username} onChange={setUsername} placeholder="alice" />
        <Field label="Password (≥6 chars)" type="password" value={password} onChange={setPassword} placeholder="••••••" />
        <Field label="Email (optional)" value={email} onChange={setEmail} placeholder="a@b.com" />
        <div className="mt-1 flex justify-end gap-2">
          <ModalBtn kind="ghost" onClick={onClose}>Cancel</ModalBtn>
          <ModalBtn kind="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create"}
          </ModalBtn>
        </div>
      </div>
    </Modal>
  );
}

function SetPasswordModal({
  user,
  onClose,
  onDone,
}: {
  user: AdminLocalUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.adminSetPassword(user.id, password);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Set password — ${user.username}`} size="sm" allowMaximize={false}>
      <div className="flex flex-col gap-3 p-1">
        {err && <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">{err}</div>}
        <Field label="New password (≥6 chars)" type="password" value={password} onChange={setPassword} placeholder="••••••" />
        <div className="mt-1 flex justify-end gap-2">
          <ModalBtn kind="ghost" onClick={onClose}>Cancel</ModalBtn>
          <ModalBtn kind="primary" disabled={password.length < 6 || busy} onClick={() => void submit()}>
            {busy ? "Saving…" : "Set password"}
          </ModalBtn>
        </div>
      </div>
    </Modal>
  );
}

function AssignRoleModal({
  user,
  tenants,
  onClose,
  onDone,
}: {
  user: AdminLocalUser;
  tenants: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [tenantId, setTenantId] = useState(tenants[0] ?? "");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!tenantId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.adminSetRole(user.id, tenantId, role);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Tenant roles — ${user.username}`} size="sm" allowMaximize={false}>
      <div className="flex flex-col gap-3 p-1">
        {err && <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">{err}</div>}
        {/* Existing roles */}
        {user.roles.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] text-fg-faint">Current roles</div>
            <div className="flex flex-wrap gap-1.5">
              {user.roles.map((r) => (
                <span key={r.tenantId} className="rounded-full border border-border-default bg-bg-raised px-2 py-0.5 text-[11px] text-fg-muted">
                  <span className="font-mono">{r.tenantId}</span>{" "}
                  <span className={r.role === "admin" ? "text-brand-400" : ""}>{r.role}</span>
                </span>
              ))}
            </div>
          </div>
        )}
        {tenants.length === 0 ? (
          <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            No tenants exist yet. Create a tenant before assigning roles.
          </div>
        ) : (
          <>
            <label className="text-sm">
              <span className="mb-1 block text-[11px] text-fg-faint">Tenant</span>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-[13px] text-fg-default"
              >
                {tenants.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-[11px] text-fg-faint">Role in this tenant</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "admin" | "member")}
                className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-[13px] text-fg-default"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <ModalBtn kind="ghost" onClick={onClose}>Close</ModalBtn>
              <ModalBtn kind="primary" disabled={!tenantId || busy} onClick={() => void submit()}>
                {busy ? "Saving…" : "Set role"}
              </ModalBtn>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function ModalBtn({
  kind,
  disabled,
  onClick,
  children,
}: {
  kind: "primary" | "ghost";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const base = "rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50";
  const cls =
    kind === "primary"
      ? `${base} bg-brand-600 text-white hover:bg-brand-500`
      : `${base} border border-border-default text-fg-muted hover:text-fg-default`;
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="text-sm">
      <span className="mb-1 block text-[11px] text-fg-faint">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-[13px] text-fg-default"
      />
    </label>
  );
}
