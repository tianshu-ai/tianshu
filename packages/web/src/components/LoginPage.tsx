// Login page.
//
// Rendered at /login when auth is enabled. Reads /api/auth/config for
// the list of configured providers and renders one button per provider
// that navigates to the server's OAuth start route (a full-page nav,
// not fetch, because it 302s to the external provider).
//
// When auth is disabled the page shouldn't normally be reachable, but
// if it is we show a note + a link back to the app.

import { useEffect, useState } from "react";
import { LogIn, ShieldCheck } from "lucide-react";
import { api, type AuthPublicConfig } from "../lib/api";
import { useT } from "../hooks/useT";

export default function LoginPage() {
  const t = useT();
  const [cfg, setCfg] = useState<AuthPublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);

  const submitLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await api.register(username.trim(), password);
      }
      await api.login(username.trim(), password);
      // Session cookie is set; drop the stale dev-identity cookie path
      // and land on the app root (dev-identity is bypassed for /login).
      window.location.assign("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api
      .authConfig()
      .then((c) => {
        if (!cancelled) setCfg(c);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-base px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-subtle bg-bg-elevated p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600/20">
            <ShieldCheck className="text-brand-400" size={26} />
          </div>
          <h1 className="text-lg font-semibold text-fg-default">{t("login.title")}</h1>
          <p className="mt-1 text-sm text-fg-faint">{t("login.subtitle")}</p>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {!cfg && !error && (
          <div className="py-6 text-center text-sm text-fg-faint">{t("login.loading")}</div>
        )}

        {cfg && !cfg.enabled && (
          <div className="rounded-md border border-border-subtle bg-bg-raised/50 px-3 py-3 text-center text-sm text-fg-muted">
            {t("login.authDisabled")}{" "}
            <a href="/" className="text-link hover:underline">
              {t("login.openApp")}
            </a>
            {t("login.openAppSuffix")}
          </div>
        )}

        {cfg && cfg.enabled && (
          <>
            {/* Local username/password */}
            {cfg.localLogin && (
              <form onSubmit={submitLocal} className="flex flex-col gap-2">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t("login.username")}
                  autoComplete="username"
                  className="rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("login.password")}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  className="rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default"
                />
                <button
                  type="submit"
                  disabled={busy || !username || !password}
                  className="flex items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-60"
                >
                  <LogIn size={16} />
                  {busy ? "…" : mode === "register" ? t("login.registerAndSignIn") : t("login.signIn")}
                </button>
                {cfg.allowRegistration && (
                  <button
                    type="button"
                    onClick={() => setMode((m) => (m === "login" ? "register" : "login"))}
                    className="text-center text-xs text-fg-faint hover:text-fg-muted"
                  >
                    {mode === "login" ? t("login.noAccountRegister") : t("login.haveAccountSignIn")}
                  </button>
                )}
              </form>
            )}

            {/* Divider when both local + OAuth are present */}
            {cfg.localLogin && cfg.providers.length > 0 && (
              <div className="my-4 flex items-center gap-3 text-[11px] uppercase tracking-wider text-fg-fainter">
                <span className="h-px flex-1 bg-border-subtle" />
                {t("login.or")}
                <span className="h-px flex-1 bg-border-subtle" />
              </div>
            )}

            {/* OAuth providers */}
            {cfg.providers.length > 0 && (
              <div className="flex flex-col gap-2">
                {cfg.providers.map((p) => (
                  <a
                    key={p.id}
                    href={`/api/auth/${encodeURIComponent(p.id)}/start`}
                    className="flex items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-raised px-4 py-2.5 text-sm font-medium text-fg-default transition-colors hover:bg-bg-raised/70 hover:text-white"
                  >
                    <LogIn size={16} />
                    {t("login.continueWith", { name: p.displayName })}
                  </a>
                ))}
              </div>
            )}

            {!cfg.localLogin && cfg.providers.length === 0 && (
              <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-3 text-center text-sm text-amber-200">
                Auth is on but no login method is configured.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
