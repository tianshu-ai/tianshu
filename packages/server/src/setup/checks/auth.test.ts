import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAuth } from "./auth.js";
import { getGlobalConfigPath } from "../../core/paths.js";
import type { AuthConfig } from "../../core/config.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-authchk-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.TEST_AUTH_SECRET;
  delete process.env.TEST_ADMIN_PW;
});

function writeAuth(auth: AuthConfig): void {
  const p = getGlobalConfigPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ auth }));
}

const sev = (g: ReturnType<typeof checkAuth>) => g.lines.map((l) => l.severity);

describe("checkAuth", () => {
  it("disabled → ok + how-to guidance", () => {
    writeAuth({ enabled: false });
    const g = checkAuth({ home });
    expect(g.lines[0]!.severity).toBe("ok");
    expect(g.lines[0]!.text).toMatch(/disabled/);
    expect(g.lines[0]!.detail).toMatch(/superAdmins/);
  });

  it("enabled + secret + super-admin with resolvable pw → all ok", () => {
    process.env.TEST_ADMIN_PW = "s3cret-pw";
    writeAuth({
      enabled: true,
      sessionSecret: "static-secret",
      superAdmins: [{ username: "admin", password: "${TEST_ADMIN_PW}" }],
    });
    const g = checkAuth({ home });
    expect(sev(g)).not.toContain("blocker");
    expect(g.lines.some((l) => /super-admin "admin" ready/.test(l.text))).toBe(true);
  });

  it("enabled but no sessionSecret → blocker", () => {
    writeAuth({ enabled: true, superAdmins: [{ username: "a", password: "pw" }] });
    const g = checkAuth({ home });
    expect(g.lines.some((l) => l.severity === "blocker" && /sessionSecret/.test(l.text))).toBe(true);
  });

  it("enabled with no login method → blocker + how-to", () => {
    writeAuth({ enabled: true, sessionSecret: "x" });
    const g = checkAuth({ home });
    const blocker = g.lines.find((l) => l.severity === "blocker" && /no way to log in/.test(l.text));
    expect(blocker).toBeTruthy();
    expect(blocker!.detail).toMatch(/superAdmins/);
  });

  it("super-admin password that doesn't resolve → blocker naming the account", () => {
    writeAuth({
      enabled: true,
      sessionSecret: "x",
      superAdmins: [{ username: "admin", password: "${NOT_SET_VAR}" }],
    });
    const g = checkAuth({ home });
    expect(
      g.lines.some(
        (l) => l.severity === "blocker" && /super-admin "admin": password empty/.test(l.text),
      ),
    ).toBe(true);
  });

  it("OAuth email admin counts as a super-admin (no local needed)", () => {
    writeAuth({
      enabled: true,
      sessionSecret: "x",
      admins: ["yu@example.com"],
      providers: [{ id: "sso", clientId: "c", clientSecret: "s", issuer: "https://i" }],
    });
    const g = checkAuth({ home });
    expect(sev(g)).not.toContain("blocker");
    expect(g.lines.some((l) => /OAuth super-admin: yu@example.com/.test(l.text))).toBe(true);
  });

  it("provider missing endpoint source → warning", () => {
    writeAuth({
      enabled: true,
      sessionSecret: "x",
      superAdmins: [{ username: "a", password: "pw" }],
      providers: [{ id: "broken", clientId: "c", clientSecret: "s" }],
    });
    const g = checkAuth({ home });
    expect(
      g.lines.some((l) => l.severity === "warning" && /provider "broken"/.test(l.text)),
    ).toBe(true);
  });
});
