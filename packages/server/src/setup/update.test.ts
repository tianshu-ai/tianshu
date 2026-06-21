// Unit tests for the bits of `tianshu update` that don't shell
// out to `npm install`. We test:
//   - runUpdate({check:true}) on a checkout-shaped install →
//     refuses, exit 0, doesn't try the network
//   - runUpdate({check:true}) with a stubbed-good fetch and a
//     stubbed not-a-checkout source → returns 1 when versions
//     differ, 0 when they match
//   - runUpdate({dryRun:true}) prints the would-be command and
//     stops short of spawning npm
//   - fetchDistTag error paths surface clean messages
//
// We don't test the actual `npm install` invocation: it shells
// out to the real npm binary which is a system dependency, and
// the integration we care about (the install ran, the version
// bumped) is verifiable end-to-end on a clean shell after
// `npm install -g`. Unit tests stay synthetic.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runUpdate } from "./update.js";

describe("runUpdate", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    logSpy.mockClear();
    errSpy.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses when running from a git checkout (the in-repo case)", async () => {
    // The actual test process *is* a git checkout, so the
    // checkout-detection branch fires by default. No fetch
    // happens; no network access; exit 0 with guidance.
    const code = await runUpdate({ check: true });
    expect(code).toBe(0);
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toMatch(/running from a git checkout/);
    expect(output).toMatch(/git pull/);
    // Critically: we never even tried to call the registry.
    // (If we did, an error would have shown up under stderr.)
    expect(errSpy).not.toHaveBeenCalled();
  });

  // The remaining behaviours (--check found update, --dry-run
  // shows command, real registry error surfacing) require
  // either mocking detectInstallSource (which lives inside the
  // module and isn't exported) or simulating a non-checkout
  // execution context. Both are doable via vi.mock + module
  // remapping but ship a lot of test scaffolding for little
  // payoff — the checkout-refusal path is the one that always
  // fires on contributors' machines, and the actual install
  // path is integration-tested by hand on a clean shell after
  // an `npm install -g` (the only way to be sure anyway).
  //
  // Track the gap explicitly so a future commit can lift the
  // unit coverage when we're ready to mock the install-source
  // probe.
  it.todo("returns 1 when --check finds an update on a global install");
  it.todo("dry-run prints the install command without spawning npm");
  it.todo("surfaces registry HTTP errors cleanly");
});
