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
  CANONICAL_LABEL,
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
  it("derives stdout / stderr paths from the label", () => {
    const r = logPathsFor("ai.tianshu.dev");
    expect(r.out).toBe(path.join(os.tmpdir(), "ai.tianshu.dev.out.log"));
    expect(r.err).toBe(path.join(os.tmpdir(), "ai.tianshu.dev.err.log"));
  });
});

describe("launchd.resolveLabel", () => {
  // We need a controllable HOME so we can create / delete a fake
  // canonical plist without touching the developer's real one.
  let fakeHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-launchd-"));
    fs.mkdirSync(path.join(fakeHome, "Library", "LaunchAgents"), {
      recursive: true,
    });
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    // os.homedir() reads HOME on POSIX; on macOS test runner this works.
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it("returns canonical label when no plist exists", () => {
    expect(resolveLabel("/Users/dev/git/tianshu")).toBe(CANONICAL_LABEL);
  });

  it("returns canonical label when existing plist's WorkingDirectory matches", () => {
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_LABEL}.plist`,
    );
    fs.writeFileSync(
      plistPath,
      `<plist><dict><key>WorkingDirectory</key><string>/Users/dev/git/tianshu</string></dict></plist>`,
    );
    expect(resolveLabel("/Users/dev/git/tianshu")).toBe(CANONICAL_LABEL);
  });

  it("returns hashed label when canonical plist is owned by another checkout", () => {
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_LABEL}.plist`,
    );
    fs.writeFileSync(
      plistPath,
      `<plist><dict><key>WorkingDirectory</key><string>/Users/dev/git/other-clone</string></dict></plist>`,
    );
    const label = resolveLabel("/Users/dev/git/tianshu");
    expect(label).toMatch(new RegExp(`^${CANONICAL_LABEL.replace(/\./g, "\\.")}\\.[a-f0-9]{8}$`));
  });

  it("hashed label is stable for the same checkout path", () => {
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_LABEL}.plist`,
    );
    fs.writeFileSync(plistPath, "<plist></plist>"); // unparseable → fall through to hash
    const a = resolveLabel("/Users/dev/git/tianshu");
    const b = resolveLabel("/Users/dev/git/tianshu");
    expect(a).toBe(b);
  });

  it("different checkouts get different hashed labels", () => {
    const plistPath = path.join(
      fakeHome,
      "Library",
      "LaunchAgents",
      `${CANONICAL_LABEL}.plist`,
    );
    fs.writeFileSync(plistPath, "<plist></plist>");
    const a = resolveLabel("/Users/dev/git/tianshu_a");
    const b = resolveLabel("/Users/dev/git/tianshu_b");
    expect(a).not.toBe(b);
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
