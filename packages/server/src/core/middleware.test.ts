import { describe, expect, it } from "vitest";
import {
  DEV_IDENTITY_COOKIE,
  cookieResolver,
  defaultDevResolver,
  envResolver,
  parseIdentityCookie,
  type IdentityResolver,
  type IdentityResolution,
} from "./identity-resolvers.js";
import { DEV_TENANT_ID, DEV_USER_ID } from "./dev-mode.js";
import type { Request } from "express";

const reqWithCookie = (cookie: string | undefined): Request =>
  ({
    headers: { cookie },
  }) as unknown as Request;

const reqWithHeaders = (headers: Record<string, string>): Request =>
  ({ headers }) as unknown as Request;

describe("parseIdentityCookie", () => {
  it("returns null when cookie header is missing or empty", () => {
    expect(parseIdentityCookie("")).toBeNull();
  });

  it("returns null when the named cookie is absent", () => {
    expect(parseIdentityCookie("foo=bar; baz=qux")).toBeNull();
  });

  it("parses tenant/user out of a well-formed cookie", () => {
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=my-tenant/alice`),
    ).toEqual({ tenantId: "my-tenant", userId: "alice" });
  });

  it("parses cookie even when other cookies precede / follow it", () => {
    expect(
      parseIdentityCookie(
        `foo=bar; ${DEV_IDENTITY_COOKIE}=my-tenant/alice; baz=qux`,
      ),
    ).toEqual({ tenantId: "my-tenant", userId: "alice" });
  });

  it("decodes URL-encoded cookie values", () => {
    expect(
      parseIdentityCookie(
        `${DEV_IDENTITY_COOKIE}=${encodeURIComponent("my-tenant/alice")}`,
      ),
    ).toEqual({ tenantId: "my-tenant", userId: "alice" });
  });

  it("rejects malformed values (no slash)", () => {
    expect(parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=mytenant`)).toBeNull();
  });

  it("rejects empty tenant or user", () => {
    expect(parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=/alice`)).toBeNull();
    expect(parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=mytenant/`)).toBeNull();
  });

  it("rejects ids with shell-unsafe / path-traversal chars", () => {
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=../etc/passwd/dev`),
    ).toBeNull();
    expect(parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=foo;rm/dev`)).toBeNull();
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=foo bar/dev`),
    ).toBeNull();
  });

  it("rejects ids longer than 64 chars", () => {
    const long = "a".repeat(65);
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=${long}/dev`),
    ).toBeNull();
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=tenant/${long}`),
    ).toBeNull();
  });
});

describe("cookieResolver", () => {
  it("returns null when no cookie is set", () => {
    expect(cookieResolver.resolve(reqWithCookie(undefined))).toBeNull();
  });

  it("claims a request when cookie is well-formed", () => {
    const r = cookieResolver.resolve(
      reqWithCookie(`${DEV_IDENTITY_COOKIE}=alpha/alice`),
    );
    expect(r).toEqual({
      kind: "ok",
      tenantId: "alpha",
      userId: "alice",
      source: "cookie",
    });
  });

  it("defers (returns null) on malformed cookie so the chain can continue", () => {
    expect(
      cookieResolver.resolve(reqWithCookie(`${DEV_IDENTITY_COOKIE}=garbage`)),
    ).toBeNull();
  });
});

describe("envResolver", () => {
  it("returns null when env vars are unset", () => {
    delete process.env.TIANSHU_DEV_TENANT;
    delete process.env.TIANSHU_DEV_USER;
    expect(envResolver.resolve(reqWithCookie(undefined))).toBeNull();
  });

  it("claims when TIANSHU_DEV_TENANT is set", () => {
    delete process.env.TIANSHU_DEV_USER;
    process.env.TIANSHU_DEV_TENANT = "env-tenant";
    try {
      const r = envResolver.resolve(reqWithCookie(undefined));
      expect(r).toEqual({
        kind: "ok",
        tenantId: "env-tenant",
        userId: DEV_USER_ID,
        source: "env",
      });
    } finally {
      delete process.env.TIANSHU_DEV_TENANT;
    }
  });

  it("claims when TIANSHU_DEV_USER is set", () => {
    delete process.env.TIANSHU_DEV_TENANT;
    process.env.TIANSHU_DEV_USER = "env-user";
    try {
      const r = envResolver.resolve(reqWithCookie(undefined));
      expect(r).toEqual({
        kind: "ok",
        tenantId: DEV_TENANT_ID,
        userId: "env-user",
        source: "env",
      });
    } finally {
      delete process.env.TIANSHU_DEV_USER;
    }
  });
});

describe("defaultDevResolver", () => {
  it("always claims with default/dev", () => {
    expect(defaultDevResolver.resolve(reqWithCookie(undefined))).toEqual({
      kind: "ok",
      tenantId: DEV_TENANT_ID,
      userId: DEV_USER_ID,
      source: "default-dev",
    });
  });
});

describe("resolver chain composition", () => {
  // Verifies the chain semantics that the middleware enforces:
  // first ok wins, deny short-circuits, null defers.
  function runChain(
    chain: readonly IdentityResolver[],
    req: Request,
  ): IdentityResolution | null {
    for (const r of chain) {
      const res = r.resolve(req);
      if (res !== null) return res;
    }
    return null;
  }

  it("first non-null resolution wins", () => {
    const headerResolver: IdentityResolver = {
      name: "header",
      resolve(req) {
        const hdr = (req.headers["x-test-tenant"] ?? "") as string;
        return hdr
          ? {
              kind: "ok",
              tenantId: hdr,
              userId: "header-user",
              source: "header",
            }
          : null;
      },
    };
    const out = runChain(
      [cookieResolver, headerResolver, defaultDevResolver],
      reqWithHeaders({ "x-test-tenant": "from-header" }),
    );
    expect(out).toMatchObject({
      kind: "ok",
      tenantId: "from-header",
      source: "header",
    });
  });

  it("falls through nulls until a resolver claims", () => {
    const out = runChain(
      [cookieResolver, envResolver, defaultDevResolver],
      reqWithCookie(undefined),
    );
    expect(out).toEqual({
      kind: "ok",
      tenantId: DEV_TENANT_ID,
      userId: DEV_USER_ID,
      source: "default-dev",
    });
  });

  it("deny short-circuits the chain", () => {
    const denyResolver: IdentityResolver = {
      name: "jwt-test",
      resolve() {
        return { kind: "deny", source: "jwt-test", reason: "expired" };
      },
    };
    const out = runChain(
      [denyResolver, defaultDevResolver],
      reqWithCookie(undefined),
    );
    expect(out).toEqual({
      kind: "deny",
      source: "jwt-test",
      reason: "expired",
    });
  });

  it("custom resolver in front of cookie can override the cookie", () => {
    const adminResolver: IdentityResolver = {
      name: "admin-impersonate",
      resolve(req) {
        const t = (req.headers["x-impersonate-tenant"] ?? "") as string;
        const u = (req.headers["x-impersonate-user"] ?? "") as string;
        return t && u
          ? {
              kind: "ok",
              tenantId: t,
              userId: u,
              source: "admin-impersonate",
            }
          : null;
      },
    };
    const req = reqWithHeaders({
      cookie: `${DEV_IDENTITY_COOKIE}=cookie-tenant/cookie-user`,
      "x-impersonate-tenant": "imp-tenant",
      "x-impersonate-user": "imp-user",
    });
    const out = runChain(
      [adminResolver, cookieResolver, defaultDevResolver],
      req,
    );
    expect(out).toMatchObject({
      tenantId: "imp-tenant",
      userId: "imp-user",
      source: "admin-impersonate",
    });
  });
});
