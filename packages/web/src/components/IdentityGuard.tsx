// Identity guard for auth mode.
//
// The URL carries identity as `/tenants/:tenantId/users/:userId/...`.
// That path-based identity is a DEV convenience (see dev-identity.ts) and
// is authoritative ONLY when authentication is disabled. Once auth is on
// and the user has a real session, the SESSION is the single source of
// truth — the URL must reflect the logged-in user, not whatever `admin`
// / `default` the dev cookie or a shared link happened to carry.
//
// This guard, mounted inside the identity route, compares the URL's
// (tenantId,userId) against the session's real identity from /api/me and
// hard-redirects to the correct path when auth is enabled and they
// differ. When auth is disabled it's a no-op (dev URL identity stands).

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useT } from "../hooks/useT";

interface Session {
  tenantId: string;
  userId: string;
}

export default function IdentityGuard({ children }: { children: ReactNode }) {
  const t = useT();
  const params = useParams();
  const navigate = useNavigate();
  const urlTenant = params.tenantId ?? "";
  const urlUser = params.userId ?? "";
  // null = still checking; "ok" = URL matches session (or auth off).
  const [state, setState] = useState<"checking" | "ok">("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let authEnabled = false;
      try {
        authEnabled = (await api.authConfig()).enabled;
      } catch {
        // If we can't read auth config, don't block rendering.
        if (!cancelled) setState("ok");
        return;
      }
      if (!authEnabled) {
        if (!cancelled) setState("ok"); // dev mode: URL identity stands.
        return;
      }
      let session: Session;
      try {
        session = await api.me();
      } catch {
        // 401 etc. — the api client already redirects to /login; just
        // stop here so we don't render a mismatched shell.
        return;
      }
      if (cancelled) return;
      if (session.tenantId !== urlTenant || session.userId !== urlUser) {
        // Force the URL onto the real logged-in identity. replace so the
        // wrong URL doesn't linger in history.
        navigate(`/tenants/${session.tenantId}/users/${session.userId}`, {
          replace: true,
        });
        return;
      }
      setState("ok");
    })();
    return () => {
      cancelled = true;
    };
  }, [urlTenant, urlUser, navigate]);

  if (state === "checking") {
    return <div className="p-6 text-sm text-fg-faint">{t("common.loading")}</div>;
  }
  return <>{children}</>;
}
