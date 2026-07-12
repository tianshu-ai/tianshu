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

export default function LoginPage() {
  const [cfg, setCfg] = useState<AuthPublicConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <h1 className="text-lg font-semibold text-fg-default">Sign in to Tianshu</h1>
          <p className="mt-1 text-sm text-fg-faint">Choose a provider to continue.</p>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {!cfg && !error && (
          <div className="py-6 text-center text-sm text-fg-faint">Loading…</div>
        )}

        {cfg && !cfg.enabled && (
          <div className="rounded-md border border-border-subtle bg-bg-raised/50 px-3 py-3 text-center text-sm text-fg-muted">
            Authentication is disabled.{" "}
            <a href="/" className="text-link hover:underline">
              Open the app
            </a>
            .
          </div>
        )}

        {cfg && cfg.enabled && cfg.providers.length === 0 && (
          <div className="rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-3 text-center text-sm text-amber-200">
            Auth is on but no login providers are configured. An admin must
            add one in Settings → Admin.
          </div>
        )}

        {cfg && cfg.enabled && cfg.providers.length > 0 && (
          <div className="flex flex-col gap-2">
            {cfg.providers.map((p) => (
              <a
                key={p.id}
                href={`/api/auth/${encodeURIComponent(p.id)}/start`}
                className="flex items-center justify-center gap-2 rounded-lg border border-border-default bg-bg-raised px-4 py-2.5 text-sm font-medium text-fg-default transition-colors hover:bg-bg-raised/70 hover:text-white"
              >
                <LogIn size={16} />
                Continue with {p.displayName}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
