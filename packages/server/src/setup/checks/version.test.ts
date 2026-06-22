// Tests for checks/version.ts. The network-touching paths are
// covered indirectly: we exercise `isNewer`'s comparison logic
// directly (no IO) and the doctor-side `checkVersion` only via
// the `skipRemote` path so test runs stay offline-safe.
//
// A future PR could add a fetch-mocked integration that
// verifies the "update available" / "registry unreachable"
// branches end-to-end, but the bulk of the risk is in version
// math; that's what we cover here.

import { describe, expect, it } from "vitest";
import { checkVersion, isNewer } from "./version.js";

describe("isNewer", () => {
  it("compares major.minor.patch numerically, not lexically", () => {
    expect(isNewer("0.3.10", "0.3.9")).toBe(true);
    // Lexical sort would put "0.3.9" > "0.3.10". Make sure we
    // don't fall into that.
    expect(isNewer("0.3.9", "0.3.10")).toBe(false);
  });

  it("returns true for any higher segment", () => {
    expect(isNewer("0.4.0", "0.3.99")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
  });

  it("returns false for equal versions", () => {
    expect(isNewer("0.3.10", "0.3.10")).toBe(false);
  });

  it("returns false when candidate is older", () => {
    expect(isNewer("0.3.10", "0.3.11")).toBe(false);
    expect(isNewer("0.2.0", "0.3.0")).toBe(false);
  });

  it("tolerates leading v prefix", () => {
    expect(isNewer("v0.3.10", "0.3.9")).toBe(true);
  });

  it("falls back to a !== for unparseable input rather than throwing", () => {
    // Prerelease tags get stripped (-alpha.1 -> we still parse
    // the numeric prefix), so this still parses cleanly.
    expect(isNewer("0.3.10-alpha.1", "0.3.10")).toBe(false);
    // Truly unparseable values fall back to string inequality:
    // the function returns `candidate !== base`, which gives a
    // useful "they differ" signal without crashing.
    expect(isNewer("not-a-version", "0.3.10")).toBe(true);
    expect(isNewer("not-a-version", "not-a-version")).toBe(false);
  });
});

describe("checkVersion (skipRemote=true)", () => {
  it("returns one ok line with the local version and never touches network", async () => {
    // skipRemote: true forces the function to short-circuit
    // before calling fetchDistTag. Result must be ok + a local
    // version line. Validates the offline path doctor uses
    // when --skip-version-check is set.
    const r = await checkVersion({ skipRemote: true });
    expect(r.title).toBe("Tianshu version");
    expect(r.lines.length).toBeGreaterThanOrEqual(1);
    // Every line should be 'ok' on the skipRemote path — no
    // network = no comparison = no warning.
    for (const line of r.lines) {
      expect(line.severity).toBe("ok");
    }
    const versionLine = r.lines.find((l) => /Tianshu \d|checkout/i.test(l.text));
    expect(versionLine).toBeDefined();
  });
});
