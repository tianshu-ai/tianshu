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
import { useT } from "../../hooks/useT";

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
  const t = useT();
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
                <RefreshCw size={14} /> {t("common.reload")}
              </button>
            )}
            {onSave && (
              <button
                type="button"
                onClick={onSave}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-60"
              >
                <Save size={14} /> {saving ? t("common.saving") : t("common.save")}
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
          <CheckCircle2 size={14} /> {t("auth.savedRearm")}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Tab 1: Settings — master switch, session secret, registration,
//    super-admins (read-only). PATCHes only its own fields. ──
export function AuthSettingsPage() {
  const t = useT();
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

  if (loading) return <div className="p-6 text-sm text-fg-faint">{t("common.loading")}</div>;

  return (
    <PageShell
      title={t("auth.settings.title")}
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
            <span className="block text-sm font-medium text-fg-default">{t("auth.requireSignIn")}</span>
            <span className="block text-xs text-fg-faint">
              {t("auth.requireSignInHelp")}
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
              <span className="mb-1 block text-xs text-fg-faint">{t("auth.sessionSecret")}</span>
              <input
                type="password"
                value={sessionSecret}
                onChange={(e) => setSessionSecret(e.target.value)}
                placeholder={sessionSecretSet ? t("auth.sessionSecretPlaceholderStored") : t("auth.sessionSecretPlaceholder")}
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
              <span className="text-fg-default">{t("auth.allowRegistration")}</span>
            </label>
            <p className="text-xs text-fg-faint sm:col-span-2">
              {t("auth.tenantExplainer")}
            </p>
          </div>
        )}
      </section>

      {/* Super-admins (read-only, config-declared) */}
      <section className="rounded-xl border border-border-subtle bg-bg-elevated p-4">
        <div className="mb-2 text-sm font-medium text-fg-default">{t("auth.superAdmins")}</div>
        <p className="mb-2 text-xs text-fg-faint">
          {t("auth.superAdminsHelp1")}
          <code className="rounded bg-bg-raised px-1">auth.admins</code>
          {t("auth.superAdminsHelp2")}
          <code className="rounded bg-bg-raised px-1">auth.superAdmins</code>
          {t("auth.superAdminsHelp3")}
          <code className="rounded bg-bg-raised px-1">~/.tianshu/config.json</code>.
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
          <span className="text-xs text-fg-fainter">{t("auth.noSuperAdmins")}</span>
        )}
      </section>
    </PageShell>
  );
}

// ── Tab 2: Providers — OAuth/OIDC. PATCHes only providers. ──
export function AuthProvidersPage() {
  const t = useT();
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

  if (loading) return <div className="p-6 text-sm text-fg-faint">{t("common.loading")}</div>;

  return (
    <PageShell
      title={t("auth.providers.title")}
      onReload={() => void load()}
      onSave={() => void save()}
      saving={saving}
      error={error}
      saved={saved}
    >
      <section className="rounded-xl border border-border-subtle bg-bg-elevated p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-fg-default">{t("auth.providers.sectionTitle")}</div>
            <div className="text-xs text-fg-faint">
              {t("auth.providers.sectionHelp")}
            </div>
          </div>
          <button
            type="button"
            onClick={addProvider}
            className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm text-fg-muted hover:text-fg-default"
          >
            <Plus size={14} /> {t("common.add")}
          </button>
        </div>

        {providers.length === 0 && (
          <div className="rounded-md border border-border-subtle bg-bg-raised/40 px-3 py-3 text-center text-xs text-fg-faint">
            {t("auth.providers.empty")}
          </div>
        )}

        <div className="flex flex-col gap-3">
          {providers.map((p, i) => (
            <div key={i} className="rounded-lg border border-border-subtle bg-bg-base p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-mono text-fg-muted">{p.id || t("auth.providers.newProvider")}</span>
                <button
                  type="button"
                  onClick={() => removeProvider(i)}
                  className="text-fg-fainter hover:text-danger"
                  title={t("common.remove")}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t("auth.provider.id")} value={p.id} onChange={(v) => patchProvider(i, { id: v })} placeholder="my-sso" />
                <Field label={t("auth.provider.displayName")} value={p.displayName} onChange={(v) => patchProvider(i, { displayName: v })} placeholder="Company SSO" />
                <Field label={t("auth.provider.clientId")} value={p.clientId} onChange={(v) => patchProvider(i, { clientId: v })} placeholder="${OIDC_CLIENT_ID}" />
                <Field label={t("auth.provider.clientSecret")} type="password" value={p.clientSecret} onChange={(v) => patchProvider(i, { clientSecret: v })} placeholder="${OIDC_CLIENT_SECRET}" />
                <Field label={t("auth.provider.issuer")} value={p.issuer} onChange={(v) => patchProvider(i, { issuer: v })} placeholder="https://sso.example.com/realms/main" />
                <Field label={t("auth.provider.scopes")} value={p.scopes} onChange={(v) => patchProvider(i, { scopes: v })} placeholder="openid email profile" />
                <Field label={t("auth.provider.authorizeUrl")} value={p.authorizeUrl} onChange={(v) => patchProvider(i, { authorizeUrl: v })} placeholder="https://github.com/login/oauth/authorize" />
                <Field label={t("auth.provider.tokenUrl")} value={p.tokenUrl} onChange={(v) => patchProvider(i, { tokenUrl: v })} placeholder="https://github.com/login/oauth/access_token" />
                <Field label={t("auth.provider.userInfoUrl")} value={p.userInfoUrl} onChange={(v) => patchProvider(i, { userInfoUrl: v })} placeholder="https://api.github.com/user" />
                <Field label={t("auth.provider.claimSubject")} value={p.claimsSubject} onChange={(v) => patchProvider(i, { claimsSubject: v })} placeholder="sub" />
                <Field label={t("auth.provider.claimEmail")} value={p.claimsEmail} onChange={(v) => patchProvider(i, { claimsEmail: v })} placeholder="email" />
                <Field label={t("auth.provider.claimName")} value={p.claimsName} onChange={(v) => patchProvider(i, { claimsName: v })} placeholder="name" />
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
  const t = useT();
  return (
    <PageShell title={t("auth.users.title")}>
      <LocalUsersSection />
    </PageShell>
  );
}

// ── Tab 4: Tenants — super-admin only. ──
export function AuthTenantsPage() {
  const t = useT();
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
  if (allowed === null) return <div className="p-6 text-sm text-fg-faint">{t("common.loading")}</div>;
  return (
    <PageShell title={t("auth.tenants.title")}>
      {allowed ? (
        <TenantsSection />
      ) : (
        <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-3 text-sm text-amber-200">
          {t("auth.tenants.restricted")}
        </div>
      )}
    </PageShell>
  );
}

function TenantsSection() {
  const t = useT();
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
          <div className="text-sm font-medium text-fg-default">{t("auth.tenants.sectionTitle")}</div>
          <div className="text-xs text-fg-faint">
            {t("auth.tenants.sectionHelp")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
        >
          <Plus size={15} /> {t("auth.tenants.create")}
        </button>
      </div>

      {err && (
        <div className="mb-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">
          {err}
        </div>
      )}

      {tenants.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-fg-fainter">
          {t("auth.tenants.empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {tenants.map((tn) => (
            <div
              key={tn.id}
              className="flex items-center justify-between rounded-lg border border-border-subtle bg-bg-base p-3"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-fg-default">{tn.id}</span>
                {tn.disabled && (
                  <span className="rounded-full border border-amber-700/40 bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-200">
                    {t("auth.tenants.disabledBadge")}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void toggle(tn.id, !tn.disabled)}
                className={
                  "rounded-md border px-2.5 py-1 text-xs " +
                  (tn.disabled
                    ? "border-border-default text-fg-muted hover:bg-bg-raised hover:text-fg-default"
                    : "border-border-default text-fg-muted hover:border-amber-700/60 hover:text-amber-200")
                }
              >
                {tn.disabled ? t("common.enable") : t("common.disable")}
              </button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal isOpen onClose={() => setCreating(false)} title={t("auth.tenants.createTitle")} size="sm" allowMaximize={false}>
          <div className="flex flex-col gap-3 p-1">
            <p className="text-xs text-fg-faint">
              {t("auth.tenants.createHelp")}
            </p>
            <Field label={t("auth.tenants.idLabel")} value={newId} onChange={setNewId} placeholder="acme" />
            <div className="mt-1 flex justify-end gap-2">
              <ModalBtn kind="ghost" onClick={() => setCreating(false)}>{t("common.cancel")}</ModalBtn>
              <ModalBtn kind="primary" disabled={newId.trim().length < 2 || busy} onClick={() => void create()}>
                {busy ? t("common.creating") : t("common.create")}
              </ModalBtn>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function LocalUsersSection() {
  const t = useT();
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
      const [u, tn] = await Promise.all([api.adminUsers(), api.adminTenants()]);
      setUsers(u.users);
      setTenants(tn.tenants);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const del = async (u: AdminLocalUser) => {
    if (!window.confirm(t("auth.users.confirmDelete", { name: u.username }))) return;
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
          <div className="text-sm font-medium text-fg-default">{t("auth.users.sectionTitle")}</div>
          <div className="text-xs text-fg-faint">
            {t("auth.users.sectionHelp")}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
        >
          <UserPlus size={15} /> {t("auth.users.add")}
        </button>
      </div>

      {err && (
        <div className="mb-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">
          {err}
        </div>
      )}

      {users.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle px-3 py-6 text-center text-xs text-fg-fainter">
          {t("auth.users.empty")}
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
                    <ShieldPlus size={13} /> {t("auth.users.roles")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPwUser(u)}
                    className="flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted hover:bg-bg-raised hover:text-fg-default"
                  >
                    <KeyRound size={13} /> {t("auth.users.password")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void del(u)}
                    className="flex items-center gap-1 rounded-md border border-border-default px-2 py-1 text-xs text-fg-muted hover:border-rose-700/60 hover:text-danger"
                  >
                    <Trash2 size={13} /> {t("common.delete")}
                  </button>
                </div>
              </div>
              {/* Per-tenant roles */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {u.superAdmin ? (
                  <span className="rounded-full border border-brand-500/40 bg-brand-600/15 px-2 py-0.5 text-[11px] font-medium text-brand-300">
                    {t("auth.users.superAdminBadge")}
                  </span>
                ) : u.roles.length === 0 ? (
                  <span className="text-[11px] text-fg-fainter">{t("auth.users.noRoles")}</span>
                ) : (
                  u.roles.map((r) => (
                    <span
                      key={r.tenantId}
                      className="flex items-center gap-1.5 rounded-full border border-border-default bg-bg-raised px-2 py-0.5 text-[11px] text-fg-muted"
                    >
                      <span className="font-mono">{r.tenantId}</span>
                      <span className={r.role === "admin" ? "font-medium text-brand-400" : ""}>
                        {r.role === "admin" ? t("user.role.admin") : t("user.role.member")}
                      </span>
                      <button
                        type="button"
                        onClick={() => void rmRole(u.id, r.tenantId)}
                        className="ml-0.5 text-fg-fainter hover:text-danger"
                        title={t("auth.users.removeRole")}
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
  const t = useT();
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
    <Modal isOpen onClose={onClose} title={t("auth.users.addTitle")} size="sm" allowMaximize={false}>
      <div className="flex flex-col gap-3 p-1">
        {err && <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">{err}</div>}
        <Field label={t("auth.users.usernameLabel")} value={username} onChange={setUsername} placeholder="alice" />
        <Field label={t("auth.users.passwordLabel")} type="password" value={password} onChange={setPassword} placeholder="••••••" />
        <Field label={t("auth.users.emailLabel")} value={email} onChange={setEmail} placeholder="a@b.com" />
        <div className="mt-1 flex justify-end gap-2">
          <ModalBtn kind="ghost" onClick={onClose}>{t("common.cancel")}</ModalBtn>
          <ModalBtn kind="primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? t("common.creating") : t("common.create")}
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
  const t = useT();
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
    <Modal isOpen onClose={onClose} title={t("auth.users.setPasswordTitle", { name: user.username })} size="sm" allowMaximize={false}>
      <div className="flex flex-col gap-3 p-1">
        {err && <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">{err}</div>}
        <Field label={t("auth.users.newPasswordLabel")} type="password" value={password} onChange={setPassword} placeholder="••••••" />
        <div className="mt-1 flex justify-end gap-2">
          <ModalBtn kind="ghost" onClick={onClose}>{t("common.cancel")}</ModalBtn>
          <ModalBtn kind="primary" disabled={password.length < 6 || busy} onClick={() => void submit()}>
            {busy ? t("common.saving") : t("auth.users.setPassword")}
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
  const t = useT();
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
    <Modal isOpen onClose={onClose} title={t("auth.users.rolesTitle", { name: user.username })} size="sm" allowMaximize={false}>
      <div className="flex flex-col gap-3 p-1">
        {err && <div className="rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">{err}</div>}
        {/* Existing roles */}
        {user.roles.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] text-fg-faint">{t("auth.users.currentRoles")}</div>
            <div className="flex flex-wrap gap-1.5">
              {user.roles.map((r) => (
                <span key={r.tenantId} className="rounded-full border border-border-default bg-bg-raised px-2 py-0.5 text-[11px] text-fg-muted">
                  <span className="font-mono">{r.tenantId}</span>{" "}
                  <span className={r.role === "admin" ? "text-brand-400" : ""}>
                    {r.role === "admin" ? t("user.role.admin") : t("user.role.member")}
                  </span>
                </span>
              ))}
            </div>
          </div>
        )}
        {tenants.length === 0 ? (
          <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
            {t("auth.users.noTenants")}
          </div>
        ) : (
          <>
            <label className="text-sm">
              <span className="mb-1 block text-[11px] text-fg-faint">{t("auth.users.tenantLabel")}</span>
              <select
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-[13px] text-fg-default"
              >
                {tenants.map((tn) => (
                  <option key={tn} value={tn}>{tn}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-[11px] text-fg-faint">{t("auth.users.roleInTenantLabel")}</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as "admin" | "member")}
                className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-[13px] text-fg-default"
              >
                <option value="member">{t("user.role.member")}</option>
                <option value="admin">{t("user.role.admin")}</option>
              </select>
            </label>
            <div className="mt-1 flex justify-end gap-2">
              <ModalBtn kind="ghost" onClick={onClose}>{t("common.close")}</ModalBtn>
              <ModalBtn kind="primary" disabled={!tenantId || busy} onClick={() => void submit()}>
                {busy ? t("common.saving") : t("auth.users.setRole")}
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
