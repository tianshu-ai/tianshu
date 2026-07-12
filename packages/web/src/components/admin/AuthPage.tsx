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
} from "lucide-react";
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

export default function AuthPage() {
  const [cfg, setCfg] = useState<AdminAuthConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tenantStrategy, setTenantStrategy] = useState<"single" | "email">("single");
  const [singleTenant, setSingleTenant] = useState("default");
  const [sessionSecret, setSessionSecret] = useState("");
  const [sessionSecretSet, setSessionSecretSet] = useState(false);
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
      setCfg(c);
      setEnabled(c.enabled);
      setTenantStrategy(c.tenantStrategy);
      setSingleTenant(c.singleTenant);
      setSessionSecretSet(c.sessionSecretSet);
      setSessionSecret(c.sessionSecretSet ? SECRET_MASK : "");
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
      const patch: Record<string, unknown> = {
        enabled,
        tenantStrategy,
        singleTenant: singleTenant.trim() || "default",
        providers: providers.map(draftToWire),
      };
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
  }, [enabled, tenantStrategy, singleTenant, sessionSecret, providers, load]);

  const addProvider = () => {
    setProviders((prev) => [
      ...prev,
      {
        id: "",
        displayName: "",
        clientId: "",
        clientSecret: "",
        issuer: "",
        authorizeUrl: "",
        tokenUrl: "",
        userInfoUrl: "",
        scopes: "openid email profile",
        claimsSubject: "",
        claimsEmail: "",
        claimsName: "",
      },
    ]);
  };

  const patchProvider = (i: number, patch: Partial<ProviderDraft>) =>
    setProviders((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  const removeProvider = (i: number) =>
    setProviders((prev) => prev.filter((_, idx) => idx !== i));

  if (loading) {
    return <div className="p-6 text-sm text-fg-faint">Loading…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck size={20} className="text-brand-400" />
          <h1 className="text-lg font-semibold text-fg-default">Admin · Authentication</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm text-fg-muted hover:text-fg-default"
          >
            <RefreshCw size={14} /> Reload
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-60"
          >
            <Save size={14} /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
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

      {/* Master switch */}
      <section className="mb-6 rounded-xl border border-border-subtle bg-bg-elevated p-4">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium text-fg-default">Require sign-in</span>
            <span className="block text-xs text-fg-faint">
              When on, unauthenticated requests are rejected and users must log
              in via a provider below. When off, the app runs in open dev mode.
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
            <label className="text-sm">
              <span className="mb-1 block text-xs text-fg-faint">Tenant strategy</span>
              <select
                value={tenantStrategy}
                onChange={(e) => setTenantStrategy(e.target.value as "single" | "email")}
                className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-fg-default"
              >
                <option value="single">single — everyone → one tenant</option>
                <option value="email">email — one tenant per user</option>
              </select>
            </label>
            {tenantStrategy === "single" && (
              <label className="text-sm">
                <span className="mb-1 block text-xs text-fg-faint">Single tenant id</span>
                <input
                  value={singleTenant}
                  onChange={(e) => setSingleTenant(e.target.value)}
                  className="w-full rounded-md border border-border-default bg-bg-base px-2.5 py-1.5 text-fg-default"
                />
              </label>
            )}
          </div>
        )}
      </section>

      {/* Super-admins (read-only, config-declared) */}
      <section className="mb-6 rounded-xl border border-border-subtle bg-bg-elevated p-4">
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

      {/* Local users + per-tenant roles */}
      {enabled && <LocalUsersSection />}

      {/* Providers */}
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
    </div>
  );
}

function LocalUsersSection() {
  const [users, setUsers] = useState<AdminLocalUser[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [nu, setNu] = useState({ username: "", password: "", email: "" });

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.adminUsers();
      setUsers(r.users);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setErr(null);
    try {
      await api.adminCreateUser(nu.username.trim(), nu.password, nu.email.trim() || undefined);
      setNu({ username: "", password: "", email: "" });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const del = async (id: string) => {
    await api.adminDeleteUser(id);
    await load();
  };
  const resetPw = async (id: string) => {
    const pw = window.prompt("New password (≥6 chars):");
    if (!pw) return;
    await api.adminSetPassword(id, pw);
  };
  const addRole = async (id: string) => {
    const tenantId = window.prompt("Tenant id:");
    if (!tenantId) return;
    const role = window.prompt("Role (admin/member):", "member");
    if (role !== "admin" && role !== "member") return;
    await api.adminSetRole(id, tenantId.trim(), role);
    await load();
  };
  const rmRole = async (id: string, tenantId: string) => {
    await api.adminRemoveRole(id, tenantId);
    await load();
  };

  return (
    <section className="mb-6 rounded-xl border border-border-subtle bg-bg-elevated p-4">
      <div className="mb-2 text-sm font-medium text-fg-default">Local users</div>
      <p className="mb-3 text-xs text-fg-faint">
        Username/password accounts (auth.db). Assign per-tenant roles
        (tenant admin / member). Super-admins above override these everywhere.
      </p>
      {err && (
        <div className="mb-2 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-1.5 text-xs text-danger">
          {err}
        </div>
      )}

      {/* Create */}
      <div className="mb-3 flex flex-wrap items-end gap-2 border-b border-border-subtle pb-3">
        <Field label="username" value={nu.username} onChange={(v) => setNu({ ...nu, username: v })} placeholder="alice" />
        <Field label="password" type="password" value={nu.password} onChange={(v) => setNu({ ...nu, password: v })} placeholder="≥6 chars" />
        <Field label="email (optional)" value={nu.email} onChange={(v) => setNu({ ...nu, email: v })} placeholder="a@b.com" />
        <button
          type="button"
          onClick={() => void create()}
          disabled={nu.username.length < 2 || nu.password.length < 6}
          className="flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm text-fg-muted hover:text-fg-default disabled:opacity-50"
        >
          <Plus size={14} /> Create
        </button>
      </div>

      {users.length === 0 ? (
        <div className="text-xs text-fg-fainter">no local users</div>
      ) : (
        <div className="flex flex-col gap-2">
          {users.map((u) => (
            <div key={u.id} className="rounded-lg border border-border-subtle bg-bg-base p-2.5">
              <div className="flex items-center justify-between">
                <div className="text-sm text-fg-default">
                  {u.username}
                  {u.email && <span className="ml-2 text-xs text-fg-faint">{u.email}</span>}
                </div>
                <div className="flex items-center gap-2 text-fg-fainter">
                  <button type="button" onClick={() => void resetPw(u.id)} className="text-xs hover:text-fg-default">reset pw</button>
                  <button type="button" onClick={() => void addRole(u.id)} className="text-xs hover:text-fg-default">+ role</button>
                  <button type="button" onClick={() => void del(u.id)} className="hover:text-danger" title="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
              {u.roles.length > 0 && (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {u.roles.map((r) => (
                    <li key={r.tenantId} className="flex items-center gap-1 rounded-full border border-border-default bg-bg-raised px-2 py-0.5 text-[11px] text-fg-muted">
                      <span className="font-mono">{r.tenantId}</span>
                      <span className={r.role === "admin" ? "text-brand-400" : ""}>{r.role}</span>
                      <button type="button" onClick={() => void rmRole(u.id, r.tenantId)} className="ml-0.5 hover:text-danger">×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
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
