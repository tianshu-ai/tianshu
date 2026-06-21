// Small fixed-position badge that shows the current dev identity
// (cookie + URL path, see packages/web/src/dev-identity.ts) and
// offers a one-click reset back to default/dev.
//
// Hidden when no override is active — i.e. when the user is the
// default `default/dev` identity, the badge would just be noise.
// Shows up the moment you visit /tenants/<other>/users/<other>/
// or paste a ?tenant=foo&user=bar URL.
//
// Click the badge → adds `?reset-identity` to the URL, which the
// boot-time hook in main.tsx consumes (clears the cookie and
// reloads to /tenants/default/users/dev/).

import { useEffect, useState } from "react";
import {
  FALLBACK_TENANT,
  FALLBACK_USER,
  readIdentityFromCookie,
} from "../dev-identity";

interface Identity {
  tenantId: string;
  userId: string;
}

export default function DevIdentityBadge() {
  const [identity, setIdentity] = useState<Identity | null>(() =>
    readIdentityFromCookie(),
  );

  // Re-read when the document becomes visible again (user
  // switched tabs / came back). Cheap and means the badge
  // updates if you opened a sibling tab and changed identity
  // there.
  useEffect(() => {
    const onFocus = () => setIdentity(readIdentityFromCookie());
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  // Hide when there's no override (default identity). With
  // path-shape identity every load has a cookie, so we have to
  // compare against the fallback rather than just checking
  // `!identity`.
  if (!identity) return null;
  if (
    identity.tenantId === FALLBACK_TENANT &&
    identity.userId === FALLBACK_USER
  ) {
    return null;
  }

  const reset = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("reset-identity", "");
    window.location.href = url.toString();
  };

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "rgba(217, 119, 6, 0.95)" /* amber-600 */,
        color: "white",
        borderRadius: 6,
        fontSize: 12,
        fontFamily: "-apple-system, sans-serif",
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
        cursor: "pointer",
        userSelect: "none",
      }}
      onClick={reset}
      title="Click to reset identity to default/dev"
    >
      <span>
        🔑 {identity.userId}@{identity.tenantId}
      </span>
      <span style={{ opacity: 0.8, fontSize: 11 }}>(click to reset)</span>
    </div>
  );
}
