// Tests for the central URL/port resolver. These pin the
// contract that doctor, the wizard, `tianshu start`, and
// `tianshu tenant list` all share.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildTenantUserUrl,
  computeServerEffectivePublicUrl,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  detectInstallMode,
  resolveLocalServerBaseUrl,
  resolvePublicBaseUrl,
  resolveServerPort,
  resolveWebPort,
} from "./urls.js";
import { isDevelopmentCheckout } from "../setup/repo-root.js";

// We mutate process.env in these tests. Snapshot the
// originals so we don't leak into other test files.
const ENV_KEYS = ["PORT", "WEB_PORT", "TIANSHU_WEB_URL", "TIANSHU_HOME"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) out[k] = process.env[k];
  return out;
}
function restoreEnv(snap: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}

function mkTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-urls-"));
}

describe("resolveServerPort", () => {
  let envSnap: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    home = mkTmpHome();
    process.env.TIANSHU_HOME = home;
    delete process.env.PORT;
  });
  afterEach(() => {
    restoreEnv(envSnap);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("defaults to 3110 when nothing is set", () => {
    expect(resolveServerPort()).toBe(DEFAULT_SERVER_PORT);
    expect(DEFAULT_SERVER_PORT).toBe(3110);
  });

  it("env PORT wins over everything", () => {
    process.env.PORT = "4242";
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ server: { port: 9999 } }),
    );
    expect(resolveServerPort()).toBe(4242);
  });

  it("global config server.port wins over the default", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ server: { port: 5555 } }),
    );
    expect(resolveServerPort()).toBe(5555);
  });

  it("ignores garbage env PORT and falls through", () => {
    process.env.PORT = "not-a-number";
    expect(resolveServerPort()).toBe(DEFAULT_SERVER_PORT);
  });

  it("accepts a caller-supplied config (skips disk read)", () => {
    // No config on disk; pass one directly. This is the path
    // doctor uses to avoid double-loading the file.
    expect(
      resolveServerPort({
        config: { server: { port: 6789 } } as Parameters<
          typeof resolveServerPort
        >[0]["config"],
      } as Parameters<typeof resolveServerPort>[0]),
    ).toBe(6789);
  });
});

describe("resolveWebPort", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.WEB_PORT;
  });
  afterEach(() => restoreEnv(envSnap));

  it("defaults to 5183", () => {
    expect(resolveWebPort()).toBe(DEFAULT_WEB_PORT);
    expect(DEFAULT_WEB_PORT).toBe(5183);
  });

  it("respects env WEB_PORT", () => {
    process.env.WEB_PORT = "5184";
    expect(resolveWebPort()).toBe(5184);
  });

  it("ignores garbage WEB_PORT", () => {
    process.env.WEB_PORT = "abc";
    expect(resolveWebPort()).toBe(DEFAULT_WEB_PORT);
  });
});

describe("resolvePublicBaseUrl", () => {
  let envSnap: Record<string, string | undefined>;
  let home: string;

  beforeEach(() => {
    envSnap = snapshotEnv();
    home = mkTmpHome();
    process.env.TIANSHU_HOME = home;
    delete process.env.PORT;
    delete process.env.WEB_PORT;
    delete process.env.TIANSHU_WEB_URL;
  });
  afterEach(() => {
    restoreEnv(envSnap);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("TIANSHU_WEB_URL trumps everything and trailing-slash is stripped", () => {
    process.env.TIANSHU_WEB_URL = "https://tianshu.example.com/";
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ server: { publicUrl: "https://from-config/", port: 1234 } }),
    );
    expect(resolvePublicBaseUrl()).toBe("https://tianshu.example.com");
  });

  it("config server.publicUrl beats the localhost fallback", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ server: { publicUrl: "https://from-config/" } }),
    );
    expect(resolvePublicBaseUrl()).toBe("https://from-config");
  });

  it("dev mode falls back to localhost:WEB_PORT", () => {
    process.env.WEB_PORT = "5183";
    expect(resolvePublicBaseUrl({ repoRoot: devRepoRoot() })).toBe(
      "http://localhost:5183",
    );
  });

  it("prod mode falls back to localhost:SERVER_PORT", () => {
    process.env.PORT = "3110";
    expect(resolvePublicBaseUrl({ repoRoot: prodRepoRoot() })).toBe(
      "http://localhost:3110",
    );
  });

  it("prod mode honours config server.port for the fallback", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ server: { port: 4242 } }),
    );
    expect(resolvePublicBaseUrl({ repoRoot: prodRepoRoot() })).toBe(
      "http://localhost:4242",
    );
  });

  it("server.effectivePublicUrl wins over the dev/prod heuristic", () => {
    // Simulates: a running server has written
    // effectivePublicUrl=3110 into global config. CLI runs
    // from inside a git checkout (which would otherwise
    // resolve to web port). Expectation: trust the server's
    // self-reported URL, not the filesystem guess.
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        server: { effectivePublicUrl: "http://localhost:3110" },
      }),
    );
    expect(resolvePublicBaseUrl({ repoRoot: devRepoRoot() })).toBe(
      "http://localhost:3110",
    );
  });

  it("operator publicUrl outranks server-published effectivePublicUrl", () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        server: {
          publicUrl: "https://tianshu.example.com",
          effectivePublicUrl: "http://localhost:3110",
        },
      }),
    );
    expect(resolvePublicBaseUrl()).toBe("https://tianshu.example.com");
  });
});

describe("computeServerEffectivePublicUrl", () => {
  let envSnap: Record<string, string | undefined>;
  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.WEB_PORT;
  });
  afterEach(() => restoreEnv(envSnap));

  it("hostsSpa=true -> localhost:port (server hosts the SPA)", () => {
    expect(
      computeServerEffectivePublicUrl({ port: 3110, hostsSpa: true }),
    ).toBe("http://localhost:3110");
    expect(
      computeServerEffectivePublicUrl({ port: 4242, hostsSpa: true }),
    ).toBe("http://localhost:4242");
  });

  it("hostsSpa=false -> localhost:WEB_PORT (vite hosts the SPA)", () => {
    expect(
      computeServerEffectivePublicUrl({ port: 3110, hostsSpa: false }),
    ).toBe("http://localhost:5183");
    process.env.WEB_PORT = "5200";
    expect(
      computeServerEffectivePublicUrl({ port: 3110, hostsSpa: false }),
    ).toBe("http://localhost:5200");
  });
});

describe("resolveLocalServerBaseUrl", () => {
  let envSnap: Record<string, string | undefined>;

  beforeEach(() => {
    envSnap = snapshotEnv();
    delete process.env.PORT;
    delete process.env.TIANSHU_WEB_URL;
  });
  afterEach(() => restoreEnv(envSnap));

  it("is always localhost, ignoring TIANSHU_WEB_URL", () => {
    process.env.TIANSHU_WEB_URL = "https://public.example.com";
    expect(resolveLocalServerBaseUrl()).toBe("http://localhost:3110");
  });

  it("honours env PORT", () => {
    process.env.PORT = "4242";
    expect(resolveLocalServerBaseUrl()).toBe("http://localhost:4242");
  });
});

describe("buildTenantUserUrl", () => {
  it("composes the path and strips trailing slashes from the base", () => {
    expect(buildTenantUserUrl("http://localhost:3110/", "alpha", "alice")).toBe(
      "http://localhost:3110/tenants/alpha/users/alice/",
    );
    expect(buildTenantUserUrl("https://x.example/", "t", "u")).toBe(
      "https://x.example/tenants/t/users/u/",
    );
  });
});

describe("detectInstallMode <-> isDevelopmentCheckout parity", () => {
  // Regression: urls.ts detects dev/prod by walking up looking
  // for `.git`; setup/repo-root.ts:isDevelopmentCheckout uses
  // the same heuristic. They must agree on the same path or
  // doctor and the wizard will diverge.
  it("agrees on a dev repoRoot", () => {
    const root = devRepoRoot();
    expect(detectInstallMode({ repoRoot: root })).toBe("dev");
    expect(isDevelopmentCheckout(root)).toBe(true);
  });

  it("agrees on a prod (node_modules) install path", () => {
    const root = prodRepoRoot();
    expect(detectInstallMode({ repoRoot: root })).toBe("prod");
    expect(isDevelopmentCheckout(root)).toBe(false);
  });
});

// ─── helpers ────────────────────────────────────────────────

function devRepoRoot(): string {
  // A fresh tmp dir with a .git/ marker. urls.ts walks UP
  // looking for `.git`; planting it at the leaf is sufficient.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-dev-"));
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function prodRepoRoot(): string {
  // A path that looks like a global npm install (no .git
  // anywhere up the chain — tmp on macOS satisfies this — AND
  // contains /node_modules/ in its name so the fallback in
  // modeFromPath flips to "prod" explicitly).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-prod-"));
  const nested = path.join(root, "node_modules", "@tianshu-ai", "tianshu");
  fs.mkdirSync(nested, { recursive: true });
  return nested;
}
