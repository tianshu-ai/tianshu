import { describe, expect, it } from "vitest";
import { mintSession, verifySession, readSessionCookie, buildSessionCookie } from "./session.js";
import { deriveUserId, deriveTenantId, roleForEmail } from "./identity.js";
import { buildResolverChain, assertAuthArmable } from "./resolvers.js";
import type { AuthConfig } from "../config.js";
import type { ProviderIdentity } from "./oauth.js";

const SECRET = "test-secret-value";

describe("session mint/verify", () => {
  it("round-trips valid claims", () => {
    const t = mintSession(
      { sub: "u_abc", tenant: "default", email: "a@b.com", provider: "gh" },
      SECRET,
      3600,
    );
    const c = verifySession(t, SECRET);
    expect(c).not.toBeNull();
    expect(c!.sub).toBe("u_abc");
    expect(c!.tenant).toBe("default");
    expect(c!.email).toBe("a@b.com");
    expect(c!.exp).toBeGreaterThan(c!.iat);
  });

  it("rejects a tampered payload", () => {
    const t = mintSession({ sub: "u", tenant: "t", email: "e", provider: "p" }, SECRET, 3600);
    const [payload, sig] = t.split(".");
    // flip a char in the payload; signature no longer matches
    const bad = payload!.slice(0, -1) + (payload!.slice(-1) === "A" ? "B" : "A") + "." + sig;
    expect(verifySession(bad, SECRET)).toBeNull();
  });

  it("rejects wrong secret", () => {
    const t = mintSession({ sub: "u", tenant: "t", email: "e", provider: "p" }, SECRET, 3600);
    expect(verifySession(t, "other-secret")).toBeNull();
  });

  it("rejects expired", () => {
    const t = mintSession({ sub: "u", tenant: "t", email: "e", provider: "p" }, SECRET, -1);
    expect(verifySession(t, SECRET)).toBeNull();
  });

  it("rejects malformed", () => {
    expect(verifySession("", SECRET)).toBeNull();
    expect(verifySession("nodot", SECRET)).toBeNull();
    expect(verifySession(".x", SECRET)).toBeNull();
  });

  it("reads the session cookie", () => {
    const token = "abc.def";
    const cookie = buildSessionCookie(token, 60, false);
    // cookie is `tianshu_session=<enc>; HttpOnly; ...`
    const header = cookie.split(";")[0]!;
    expect(readSessionCookie(header)).toBe(token);
    expect(readSessionCookie("other=1")).toBeNull();
    expect(readSessionCookie(undefined)).toBeNull();
  });
});

describe("identity derivation", () => {
  it("userId is stable + provider-scoped", () => {
    const a = deriveUserId("gh", "123");
    expect(a).toBe(deriveUserId("gh", "123"));
    expect(a).not.toBe(deriveUserId("google", "123")); // provider-scoped
    expect(a).toMatch(/^u_[0-9a-f]{24}$/);
  });

  it("roleForEmail matches admins case-insensitively", () => {
    const cfg: AuthConfig = { admins: ["Yu@Example.com"] };
    expect(roleForEmail("yu@example.com", cfg)).toBe("admin");
    expect(roleForEmail("other@x.com", cfg)).toBe("member");
    expect(roleForEmail("a@b.com", {})).toBe("member");
  });

  it("single tenant strategy", () => {
    const id: ProviderIdentity = { subject: "s", email: "who@corp.com" };
    expect(deriveTenantId(id, { tenantStrategy: "single" })).toBe("default");
    expect(deriveTenantId(id, { tenantStrategy: "single", singleTenant: "acme" })).toBe("acme");
    expect(deriveTenantId(id, {})).toBe("default"); // default strategy
  });

  it("email tenant strategy sanitizes the local-part", () => {
    expect(deriveTenantId({ subject: "s", email: "John.Doe@corp.com" }, { tenantStrategy: "email" }))
      .toBe("john-doe");
    // a local-part that sanitizes too short → hash fallback
    const t = deriveTenantId({ subject: "s", email: "_@corp.com" }, { tenantStrategy: "email" });
    expect(t).toMatch(/^u-[0-9a-f]{8}$/);
  });
});

describe("resolver chain", () => {
  it("disabled → dev chain (has default-dev fallback)", () => {
    const chain = buildResolverChain({ enabled: false });
    expect(chain.map((r) => r.name)).toContain("default-dev");
  });

  it("enabled → [session, deny], no dev fallback", () => {
    const chain = buildResolverChain({
      enabled: true,
      sessionSecret: SECRET,
      providers: [{ id: "p", clientId: "c", clientSecret: "s", issuer: "https://x" }],
    });
    expect(chain.map((r) => r.name)).toEqual(["session", "deny"]);
  });

  it("assertAuthArmable throws without secret", () => {
    expect(() =>
      assertAuthArmable({ enabled: true, providers: [{ id: "p", clientId: "c", clientSecret: "s", issuer: "https://x" }] }),
    ).toThrow(/sessionSecret/);
  });

  it("assertAuthArmable throws without providers", () => {
    expect(() => assertAuthArmable({ enabled: true, sessionSecret: SECRET })).toThrow(/providers/);
  });

  it("assertAuthArmable passes when armable", () => {
    expect(() =>
      assertAuthArmable({
        enabled: true,
        sessionSecret: SECRET,
        providers: [{ id: "p", clientId: "c", clientSecret: "s", issuer: "https://x" }],
      }),
    ).not.toThrow();
  });
});
