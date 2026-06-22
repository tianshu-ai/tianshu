// Tests for the *pure* parts of launchd.ts: label resolution and
// plist rendering. The launchctl wrappers and probeHealth are
// integration-y by nature (they shell out / hit network) so we
// don't cover them here — service.ts integration tests will
// stub launchctl when we get there.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CANONICAL_DEV_LABEL,
  CANONICAL_LABEL,
  findOrphanedLabels,
  PROD_LABEL,
  logPathsFor,
  plistPathFor,
  renderPlist,
  resolveLabel,
} from "./launchd.js";

describe("launchd.plistPathFor", () => {
  it("places plists under ~/Library/LaunchAgents", () => {
    expect(plistPathFor("ai.tianshu.dev")).toBe(
      path.join(os.homedir(), "Library", "LaunchAgents", "ai.tianshu.dev.plist"),
    );
  });
});

describe("launchd.logPathsFor", () => {
  it("derives stdout / stderr paths under ~/Library/Logs/tianshu (NOT os.tmpdir)", () => {
    const r = logPathsFor("ai.tianshu.dev");
    const expectedDir = path.join(os.homedir(), "Library", "Logs", "tianshu");
    expect(r.out).toBe(path.join(expectedDir, "ai.tianshu.dev.out.log"));
    expect(r.err).toBe(path.join(expectedDir, "ai.tianshu.dev.err.log"));
    // Critical: tmpdir is process-local, so launchd-rendered paths
    // must not depend on it.
    expect(r.out).not.toContain(os.tmpdir());
  });
});

describe("launchd.resolveLabel", () => {
  // Tests need a controllable HOME (for the fake LaunchAgents
  // dir) AND need to materialise real `.git/` directories so
  // isDevelopmentCheckout can recognise dev vs prod paths. The
  // old test suite skipped this by passing string paths and
  // letting the resolver hash them; the new label rules
  // require the resolver to know what kind of install it is
  // before picking a label.
  let fakeHome: string;
  let savedHome: string | undefined;
  let tmpRoot: string;

  function makeDevCheckout(name: string): string {
    const dir = path.join(tmpRoot, name);
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    return dir;
  }
  function makeProdInstall(name: string): string {
    // npm-global installs live under `.../lib/node_modules/...`,
    // which is the signal `isDevelopmentCheckout` uses (alongside
    // "no .git ancestor") to classify as production. Test fixture
    // mirrors that exact shape so the resolver picks PROD_LABEL.
    const dir = path.join(tmpRoot, "npm-prefix", "lib", "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-launchd-"));
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-launchd-checkouts-"));
    fs.mkdirSync(path.join(fakeHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns ai.tianshu.prod for an npm-global-style install (no .git ancestor)", () => {
    // The motivating fix: npm-global installs used to get a
    // hash-suffixed label (ai.tianshu.dev.f71469f0) that
    // rotated whenever the install path changed (e.g. an nvm
    // version bump). Now they get the stable bare prod label.
    const install = makeProdInstall("@tianshu-ai/tianshu");
    expect(resolveLabel(install)).toBe(PROD_LABEL);
    expect(PROD_LABEL).toBe("ai.tianshu.prod");
  });

  it("prod label is stable for the same install path", () => {
    // Re-running tianshu start / restart / status from a prod
    // install must always converge on the same plist file.
    const install = makeProdInstall("@tianshu-ai/tianshu");
    expect(resolveLabel(install)).toBe(resolveLabel(install));
  });

  it("returns ai.tianshu.dev for a git checkout when no plist exists", () => {
    const checkout = makeDevCheckout("tianshu");
    expect(resolveLabel(checkout)).toBe(CANONICAL_DEV_LABEL);
  });

  it("returns the dev label when the existing plist already points at this checkout", () => {
    const checkout = makeDevCheckout("tianshu");
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_DEV_LABEL}.plist`,
    );
    fs.writeFileSync(
      plistPath,
      `<plist><dict><key>WorkingDirectory</key><string>${checkout}</string></dict></plist>`,
    );
    expect(resolveLabel(checkout)).toBe(CANONICAL_DEV_LABEL);
  });

  it("falls back to ai.tianshu.dev.<hash> when another checkout already owns the bare dev label", () => {
    // Edge case kept for backwards compat: two dev checkouts
    // on the same machine. The first one occupies ai.tianshu.dev;
    // the second has to coexist via a hash suffix.
    const owner = makeDevCheckout("tianshu");
    const secondary = makeDevCheckout("tianshu_clone");
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_DEV_LABEL}.plist`,
    );
    fs.writeFileSync(
      plistPath,
      `<plist><dict><key>WorkingDirectory</key><string>${owner}</string></dict></plist>`,
    );
    const label = resolveLabel(secondary);
    expect(label).toMatch(
      new RegExp(
        `^${CANONICAL_DEV_LABEL.replace(/\./g, "\\.")}\\.[a-f0-9]{8}$`,
      ),
    );
  });

  it("the hashed dev fallback is stable for the same checkout path", () => {
    const owner = makeDevCheckout("tianshu");
    const secondary = makeDevCheckout("tianshu_clone");
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_DEV_LABEL}.plist`,
    );
    fs.writeFileSync(
      plistPath,
      `<plist><dict><key>WorkingDirectory</key><string>${owner}</string></dict></plist>`,
    );
    expect(resolveLabel(secondary)).toBe(resolveLabel(secondary));
  });

  it("two different dev checkouts colliding on the dev label get different hashed fallbacks", () => {
    const owner = makeDevCheckout("tianshu");
    const cloneA = makeDevCheckout("tianshu_a");
    const cloneB = makeDevCheckout("tianshu_b");
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_DEV_LABEL}.plist`,
    );
    fs.writeFileSync(
      plistPath,
      `<plist><dict><key>WorkingDirectory</key><string>${owner}</string></dict></plist>`,
    );
    expect(resolveLabel(cloneA)).not.toBe(resolveLabel(cloneB));
  });

  it("back-compat: CANONICAL_LABEL alias still resolves to the dev label", () => {
    expect(CANONICAL_LABEL).toBe(CANONICAL_DEV_LABEL);
  });
});

describe("launchd.renderPlist", () => {
  it("includes the label, working directory, and npm path", () => {
    const body = renderPlist("ai.tianshu.dev.abc12345", {
      repoRoot: "/Users/dev/git/tianshu",
      serverPort: 3110,
      webPort: 5183,
      npmPath: "/opt/homebrew/bin/npm",
    });
    expect(body).toContain("<string>ai.tianshu.dev.abc12345</string>");
    expect(body).toContain("<string>/Users/dev/git/tianshu</string>");
    expect(body).toContain("<string>/opt/homebrew/bin/npm</string>");
    // PATH should pick up npm's bindir
    expect(body).toContain("/opt/homebrew/bin:");
    // Sanity: well-formed XML preamble
    expect(body).toMatch(/^<\?xml version="1\.0"/);
    expect(body).toMatch(/<\/plist>\s*$/);
  });

  it("uses the same log paths logPathsFor would produce", () => {
    const label = "ai.tianshu.dev";
    const body = renderPlist(label, {
      repoRoot: "/x",
      serverPort: 3110,
      webPort: 5183,
      npmPath: "/usr/bin/npm",
    });
    const { out, err } = logPathsFor(label);
    expect(body).toContain(`<string>${out}</string>`);
    expect(body).toContain(`<string>${err}</string>`);
  });
});

describe("launchd.findOrphanedLabels", () => {
  // Mirrors the resolveLabel suite's HOME-isolation approach so
  // we can plant fake plists without touching the real
  // ~/Library/LaunchAgents.
  let fakeHome: string;
  let savedHome: string | undefined;
  let tmpInstalls: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-orphans-"));
    tmpInstalls = fs.mkdtempSync(
      path.join(os.tmpdir(), "tianshu-orphans-installs-"),
    );
    fs.mkdirSync(path.join(fakeHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(tmpInstalls, { recursive: true, force: true });
  });

  function writePlist(label: string, workingDir: string): void {
    fs.writeFileSync(
      path.join(
        fakeHome,
        "Library",
        "LaunchAgents",
        `${label}.plist`,
      ),
      `<plist><dict><key>WorkingDirectory</key><string>${workingDir}</string></dict></plist>`,
    );
  }

  it("returns empty list when no plists exist", () => {
    const installPath = path.join(tmpInstalls, "a");
    fs.mkdirSync(installPath, { recursive: true });
    expect(findOrphanedLabels("ai.tianshu.prod", installPath)).toEqual([]);
  });

  it("finds legacy hash-labelled plists pointing at the same install path", () => {
    // Real-world scenario this fix solves: an `npm install -g`
    // install used to get a label like ai.tianshu.dev.f71469f0,
    // hash-derived from the install path. After upgrading to
    // the version that returns ai.tianshu.prod for the same
    // install, the old plist is an orphan.
    const installPath = path.join(tmpInstalls, "prefix", "lib", "node_modules", "tianshu");
    fs.mkdirSync(installPath, { recursive: true });
    writePlist("ai.tianshu.dev.f71469f0", installPath);
    const orphans = findOrphanedLabels("ai.tianshu.prod", installPath);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].label).toBe("ai.tianshu.dev.f71469f0");
    expect(orphans[0].workingDir).toBe(installPath);
  });

  it("excludes the current label even when the WorkingDirectory matches", () => {
    // The current label's plist is NOT an orphan; we'd just be
    // about to overwrite it. Belt-and-suspenders against the
    // resolver and the cleanup pass disagreeing.
    const installPath = path.join(tmpInstalls, "a");
    fs.mkdirSync(installPath, { recursive: true });
    writePlist("ai.tianshu.prod", installPath);
    expect(findOrphanedLabels("ai.tianshu.prod", installPath)).toEqual([]);
  });

  it("ignores plists pointing at a different install path", () => {
    // Two dev clones on the same machine, both managed by
    // tianshu. Each one's start command must touch only its
    // own plist — not its neighbour's.
    const installA = path.join(tmpInstalls, "a");
    const installB = path.join(tmpInstalls, "b");
    fs.mkdirSync(installA);
    fs.mkdirSync(installB);
    writePlist("ai.tianshu.dev", installA);
    writePlist("ai.tianshu.dev.deadbeef", installB);
    expect(
      findOrphanedLabels("ai.tianshu.prod", installA).map((o) => o.label),
    ).toEqual(["ai.tianshu.dev"]);
    expect(
      findOrphanedLabels("ai.tianshu.prod", installB).map((o) => o.label),
    ).toEqual(["ai.tianshu.dev.deadbeef"]);
  });

  it("ignores non-tianshu plists", () => {
    // Anything that isn't ai.tianshu.* is none of our business.
    // Test prevents the cleanup loop ever growing teeth that
    // could chew on unrelated launchd agents.
    const installPath = path.join(tmpInstalls, "a");
    fs.mkdirSync(installPath);
    writePlist("com.example.something", installPath);
    expect(findOrphanedLabels("ai.tianshu.prod", installPath)).toEqual([]);
  });
});
