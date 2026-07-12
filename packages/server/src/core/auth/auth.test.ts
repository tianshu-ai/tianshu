import { describe, expect, it } from "vitest";
import { mintSession, verifySession, readSessionCookie, buildSessionCookie } from "./session.js";
import { deriveUserId, tenantsForUser, roleForEmail } from "./identity.js";
import { buildResolverChain, assertAuthArmable } from "./resolvers.js";
import type { AuthConfig } from "../config.js";

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

  it("tenantsForUser: membership-based, not a global strategy", () => {
    const allTenants = () => ["t1", "t2", "t3"];
    // stub store: user u1 is a member of t2 only
    const store = {
      rolesForUser: (uid: string) =>
        uid === "u1" ? [{ tenantId: "t2", role: "member" as const }] : [],
    };

    // member of exactly one tenant
    expect(tenantsForUser({}, store, { userId: "u1" }, allTenants)).toEqual(["t2"]);
    // member of none → empty (caller rejects)
    expect(tenantsForUser({}, store, { userId: "ghost" }, allTenants)).toEqual([]);
    // super-admin (by username) → every existing tenant
    const cfg: AuthConfig = { superAdmins: [{ username: "root", password: "x" }] };
    expect(tenantsForUser(cfg, store, { userId: "whatever", username: "root" }, allTenants)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
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

  it("assertAuthArmable throws when no login method at all", () => {
    expect(() => assertAuthArmable({ enabled: true, sessionSecret: SECRET })).toThrow(/no way to log in/);
  });

  it("assertAuthArmable passes with only superAdmins (local-only auth)", () => {
    expect(() =>
      assertAuthArmable({
        enabled: true,
        sessionSecret: SECRET,
        superAdmins: [{ username: "yu", password: "pw" }],
      }),
    ).not.toThrow();
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
