// Pure-function coverage for the Linux systemd backend. Mirrors
// launchd.test.ts for the parts that don't shell out to systemctl.
// We drive the fake unit dir via XDG_CONFIG_HOME and the fake log
// dir via XDG_STATE_HOME so nothing touches the real ~/.config.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveLabel,
  unitPathFor,
  plistPathFor,
  logPathsFor,
  renderUnit,
  findOrphanedLabels,
  CANONICAL_DEV_UNIT,
  PROD_UNIT,
  CANONICAL_UNIT,
} from "./systemd.js";

describe("systemd.unitPathFor", () => {
  it("places units under $XDG_CONFIG_HOME/systemd/user", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/tmp/fakecfg";
    try {
      expect(unitPathFor("tianshu-dev.service")).toBe(
        "/tmp/fakecfg/systemd/user/tianshu-dev.service",
      );
      // plistPathFor is an alias for uniform dispatch.
      expect(plistPathFor("tianshu-dev.service")).toBe(
        unitPathFor("tianshu-dev.service"),
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(unitPathFor("tianshu-prod.service")).toBe(
        path.join(os.homedir(), ".config", "systemd", "user", "tianshu-prod.service"),
      );
    } finally {
      if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe("systemd.logPathsFor", () => {
  it("derives log paths under $XDG_STATE_HOME/tianshu/log", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/tmp/fakestate";
    try {
      const { out, err } = logPathsFor("tianshu-dev.service");
      expect(out).toBe("/tmp/fakestate/tianshu/log/tianshu-dev.out.log");
      expect(err).toBe("/tmp/fakestate/tianshu/log/tianshu-dev.err.log");
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });
});

describe("systemd.resolveLabel", () => {
  let fakeCfg: string;
  let savedCfg: string | undefined;
  let tmpRoot: string;

  function makeDevCheckout(name: string): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  }
  function makeProdInstall(name: string): string {
    const dir = path.join(tmpRoot, "npm-prefix", "lib", "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  function unitDir(): string {
    return path.join(fakeCfg, "systemd", "user");
  }

  beforeEach(() => {
    fakeCfg = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-systemd-cfg-"));
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-systemd-checkouts-"));
    fs.mkdirSync(unitDir(), { recursive: true });
    savedCfg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeCfg;
  });

  afterEach(() => {
    if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedCfg;
    fs.rmSync(fakeCfg, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns tianshu-prod.service for an npm-global-style install", () => {
    const install = makeProdInstall("@tianshu-ai/tianshu");
    expect(resolveLabel(install)).toBe(PROD_UNIT);
    expect(PROD_UNIT).toBe("tianshu-prod.service");
  });

  it("prod name is stable for the same install path", () => {
    const install = makeProdInstall("@tianshu-ai/tianshu");
    expect(resolveLabel(install)).toBe(resolveLabel(install));
  });

  it("returns tianshu-dev.service for a git checkout when no unit exists", () => {
    const checkout = makeDevCheckout("tianshu");
    expect(resolveLabel(checkout)).toBe(CANONICAL_DEV_UNIT);
  });

  it("returns the dev name when the existing unit already points at this checkout", () => {
    const checkout = makeDevCheckout("tianshu");
    fs.writeFileSync(
      path.join(unitDir(), CANONICAL_DEV_UNIT),
      `[Service]\nWorkingDirectory=${checkout}\n`,
    );
    expect(resolveLabel(checkout)).toBe(CANONICAL_DEV_UNIT);
  });

  it("falls back to a hashed dev name when another checkout owns the bare dev name", () => {
    const mine = makeDevCheckout("tianshu");
    const other = makeDevCheckout("tianshu-other");
    fs.writeFileSync(
      path.join(unitDir(), CANONICAL_DEV_UNIT),
      `[Service]\nWorkingDirectory=${other}\n`,
    );
    const resolved = resolveLabel(mine);
    expect(resolved).not.toBe(CANONICAL_DEV_UNIT);
    expect(resolved).toMatch(/^tianshu-dev-[0-9a-f]{8}\.service$/);
  });

  it("the hashed dev fallback is stable for the same checkout path", () => {
    const mine = makeDevCheckout("tianshu");
    const other = makeDevCheckout("tianshu-other");
    fs.writeFileSync(
      path.join(unitDir(), CANONICAL_DEV_UNIT),
      `[Service]\nWorkingDirectory=${other}\n`,
    );
    expect(resolveLabel(mine)).toBe(resolveLabel(mine));
  });

  it("back-compat: CANONICAL_UNIT alias resolves to the dev name", () => {
    expect(CANONICAL_UNIT).toBe(CANONICAL_DEV_UNIT);
  });
});

describe("systemd.renderUnit", () => {
  it("includes description, working dir, ExecStart with npm path + script, and log paths", () => {
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/tmp/fakestate";
    try {
      const body = renderUnit("tianshu-dev.service", {
        repoRoot: "/home/u/tianshu",
        serverPort: 3110,
        webPort: 5183,
        npmPath: "/usr/bin/npm",
        npmScript: "dev",
      });
      expect(body).toContain("WorkingDirectory=/home/u/tianshu");
      expect(body).toContain("ExecStart=/usr/bin/npm run dev");
      expect(body).toContain("Restart=on-failure");
      expect(body).toContain("WantedBy=default.target");
      expect(body).toContain(
        "StandardOutput=append:/tmp/fakestate/tianshu/log/tianshu-dev.out.log",
      );
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = saved;
    }
  });

  it("honours the serve script for prod installs", () => {
    const body = renderUnit("tianshu-prod.service", {
      repoRoot: "/opt/tianshu",
      serverPort: 3110,
      webPort: 5183,
      npmPath: "/usr/bin/npm",
      npmScript: "serve",
    });
    expect(body).toContain("ExecStart=/usr/bin/npm run serve");
  });
});

describe("systemd.findOrphanedLabels", () => {
  let fakeCfg: string;
  let savedCfg: string | undefined;

  function unitDir(): string {
    return path.join(fakeCfg, "systemd", "user");
  }
  function writeUnit(name: string, workingDir: string): void {
    fs.writeFileSync(
      path.join(unitDir(), name),
      `[Service]\nWorkingDirectory=${workingDir}\n`,
    );
  }

  beforeEach(() => {
    fakeCfg = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-systemd-orphan-"));
    fs.mkdirSync(unitDir(), { recursive: true });
    savedCfg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = fakeCfg;
  });
  afterEach(() => {
    if (savedCfg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedCfg;
    fs.rmSync(fakeCfg, { recursive: true, force: true });
  });

  it("returns empty list when no units exist", () => {
    fs.rmSync(unitDir(), { recursive: true, force: true });
    expect(findOrphanedLabels("tianshu-dev.service", "/home/u/tianshu")).toEqual([]);
  });

  it("finds a legacy hashed unit pointing at the same install path", () => {
    writeUnit("tianshu-dev-deadbeef.service", "/home/u/tianshu");
    const orphans = findOrphanedLabels("tianshu-dev.service", "/home/u/tianshu");
    expect(orphans.map((o) => o.label)).toContain("tianshu-dev-deadbeef.service");
  });

  it("excludes the current unit even when the WorkingDirectory matches", () => {
    writeUnit("tianshu-dev.service", "/home/u/tianshu");
    const orphans = findOrphanedLabels("tianshu-dev.service", "/home/u/tianshu");
    expect(orphans.map((o) => o.label)).not.toContain("tianshu-dev.service");
  });

  it("ignores units pointing at a different install path", () => {
    writeUnit("tianshu-dev-deadbeef.service", "/home/u/other");
    expect(findOrphanedLabels("tianshu-dev.service", "/home/u/tianshu")).toEqual([]);
  });

  it("ignores non-tianshu units", () => {
    writeUnit("something-else.service", "/home/u/tianshu");
    expect(findOrphanedLabels("tianshu-dev.service", "/home/u/tianshu")).toEqual([]);
  });
});
