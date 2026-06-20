import { describe, expect, it } from "vitest";
import {
  DEV_IDENTITY_COOKIE,
  defaultDevResolver,
  parseIdentityCookie,
} from "./middleware.js";
import { DEV_TENANT_ID, DEV_USER_ID } from "./dev-mode.js";
import type { Request } from "express";

const reqWithCookie = (cookie: string | undefined): Request =>
  ({
    headers: { cookie },
  }) as unknown as Request;

describe("parseIdentityCookie", () => {
  it("returns null when cookie header is missing or empty", () => {
    expect(parseIdentityCookie("")).toBeNull();
  });

  it("returns null when the named cookie is absent", () => {
    expect(
      parseIdentityCookie("foo=bar; baz=qux"),
    ).toBeNull();
  });

  it("parses tenant/user out of a well-formed cookie", () => {
    const r = parseIdentityCookie(
      `${DEV_IDENTITY_COOKIE}=my-tenant/alice`,
    );
    expect(r).toEqual({ tenantId: "my-tenant", userId: "alice" });
  });

  it("parses cookie even when other cookies precede / follow it", () => {
    const r = parseIdentityCookie(
      `foo=bar; ${DEV_IDENTITY_COOKIE}=my-tenant/alice; baz=qux`,
    );
    expect(r).toEqual({ tenantId: "my-tenant", userId: "alice" });
  });

  it("decodes URL-encoded cookie values", () => {
    const r = parseIdentityCookie(
      `${DEV_IDENTITY_COOKIE}=${encodeURIComponent("my-tenant/alice")}`,
    );
    expect(r).toEqual({ tenantId: "my-tenant", userId: "alice" });
  });

  it("rejects malformed values (no slash)", () => {
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=mytenant`),
    ).toBeNull();
  });

  it("rejects values with empty tenant or user", () => {
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=/alice`),
    ).toBeNull();
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=mytenant/`),
    ).toBeNull();
  });

  it("rejects ids with shell-unsafe characters", () => {
    // Path traversal attempt + shell chars: never reach
    // ops.open().
    expect(
      parseIdentityCookie(
        `${DEV_IDENTITY_COOKIE}=../etc/passwd/dev`,
      ),
    ).toBeNull();
    expect(
      parseIdentityCookie(`${DEV_IDENTITY_COOKIE}=foo;rm/dev`),
    ).toBeNull();
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

describe("defaultDevResolver", () => {
  it("falls back to default/dev when nothing is set", () => {
    delete process.env.TIANSHU_DEV_TENANT;
    delete process.env.TIANSHU_DEV_USER;
    const r = defaultDevResolver(reqWithCookie(undefined));
    expect(r).toEqual({ tenantId: DEV_TENANT_ID, userId: DEV_USER_ID });
  });

  it("env vars override default when no cookie", () => {
    delete process.env.TIANSHU_DEV_TENANT;
    delete process.env.TIANSHU_DEV_USER;
    process.env.TIANSHU_DEV_TENANT = "env-tenant";
    process.env.TIANSHU_DEV_USER = "env-user";
    try {
      const r = defaultDevResolver(reqWithCookie(undefined));
      expect(r).toEqual({ tenantId: "env-tenant", userId: "env-user" });
    } finally {
      delete process.env.TIANSHU_DEV_TENANT;
      delete process.env.TIANSHU_DEV_USER;
    }
  });

  it("cookie wins over env vars", () => {
    process.env.TIANSHU_DEV_TENANT = "env-tenant";
    process.env.TIANSHU_DEV_USER = "env-user";
    try {
      const r = defaultDevResolver(
        reqWithCookie(`${DEV_IDENTITY_COOKIE}=cookie-tenant/cookie-user`),
      );
      expect(r).toEqual({
        tenantId: "cookie-tenant",
        userId: "cookie-user",
      });
    } finally {
      delete process.env.TIANSHU_DEV_TENANT;
      delete process.env.TIANSHU_DEV_USER;
    }
  });

  it("malformed cookie falls through to env, then default", () => {
    delete process.env.TIANSHU_DEV_TENANT;
    delete process.env.TIANSHU_DEV_USER;
    const r = defaultDevResolver(
      reqWithCookie(`${DEV_IDENTITY_COOKIE}=garbage`),
    );
    expect(r).toEqual({ tenantId: DEV_TENANT_ID, userId: DEV_USER_ID });
  });
});
