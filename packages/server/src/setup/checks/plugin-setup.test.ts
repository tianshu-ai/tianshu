// Unit tests for the generic plugin-prerequisite runner.
//
// We don't shell out to real binaries (Docker / openshell) in these
// tests — instead the test plugin specs use `true` / `false` / `cat
// /no/such/file` so the runner exercises every code path
// deterministically on macOS, Linux, and CI runners.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginSetupSpec } from "@tianshu-ai/plugin-sdk";
import {
  discoverPluginSetupSpecs,
  evaluatePluginSetup,
  pluginSetupToCheckGroup,
} from "./plugin-setup.js";

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ts-plugin-setup-"));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Helper to drop a fake plugin manifest in `scratch/<id>/manifest.json`. */
function plant(
  id: string,
  manifest: { id: string; displayName: string; setup?: PluginSetupSpec },
): void {
  const dir = path.join(scratch, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

describe("plugin-setup: evaluatePluginSetup", () => {
  it("marks a satisfied requirement ok=true and runs no install path", async () => {
    const status = await evaluatePluginSetup("demo", "Demo", {
      requirements: [
        {
          id: "echo",
          label: "Trivially OK",
          severity: "required",
          verify: [{ cmd: "true" }],
        },
      ],
    });
    expect(status.requirements).toHaveLength(1);
    expect(status.requirements[0]!.ok).toBe(true);
    expect(status.requirements[0]!.installSteps).toEqual([]);
  });

  it("marks a failing requirement ok=false and surfaces install hints", async () => {
    const status = await evaluatePluginSetup("demo", "Demo", {
      requirements: [
        {
          id: "missing",
          label: "Cannot satisfy",
          severity: "required",
          verify: [{ cmd: "false" }],
          install: [
            {
              label: "Pretend install",
              steps: [{ cmd: "echo 'pretend to install'" }],
            },
          ],
        },
      ],
    });
    expect(status.requirements[0]!.ok).toBe(false);
    expect(status.requirements[0]!.installSteps).toHaveLength(1);
    expect(status.requirements[0]!.installSteps[0]!.label).toBe("Pretend install");
  });

  it("treats first-of-many verify commands as the winner", async () => {
    // The runner stops at the first `verify[]` entry that exits
    // 0 so plugins can ship platform-specific probes that fall
    // through.
    const status = await evaluatePluginSetup("demo", "Demo", {
      requirements: [
        {
          id: "either-or",
          label: "Either path",
          severity: "required",
          verify: [{ cmd: "false" }, { cmd: "true" }],
        },
      ],
    });
    expect(status.requirements[0]!.ok).toBe(true);
  });

  it("filters verify commands by os tag", async () => {
    const otherOs =
      process.platform === "darwin"
        ? "linux"
        : process.platform === "linux"
          ? "darwin"
          : "linux";
    const status = await evaluatePluginSetup("demo", "Demo", {
      requirements: [
        {
          id: "os-tagged",
          label: "OS-tagged",
          severity: "recommended",
          verify: [{ cmd: "true", os: [otherOs as "darwin" | "linux"] }],
        },
      ],
    });
    // No verify command applies to our platform → soft-skip with
    // ok=true so the check doesn't block doctor.
    expect(status.requirements[0]!.ok).toBe(true);
    expect(status.requirements[0]!.verifyDetail).toMatch(/skipped/);
  });

  it("filters install steps by os tag (only host-matching paths surface)", async () => {
    const otherOs =
      process.platform === "darwin"
        ? "linux"
        : process.platform === "linux"
          ? "darwin"
          : "linux";
    const status = await evaluatePluginSetup("demo", "Demo", {
      requirements: [
        {
          id: "mixed-installs",
          label: "Mixed installs",
          severity: "required",
          verify: [{ cmd: "false" }],
          install: [
            {
              label: "For other OS",
              steps: [
                { cmd: "echo other", os: [otherOs as "darwin" | "linux"] },
              ],
            },
            {
              label: "For this OS",
              steps: [{ cmd: "echo this" }],
            },
          ],
        },
      ],
    });
    // The "For other OS" install path's only step is filtered
    // out → that path is dropped entirely. The cross-platform
    // path stays.
    const labels = status.requirements[0]!.installSteps.map((p) => p.label);
    expect(labels).toEqual(["For this OS"]);
  });

  it("times out hung verify commands within budget", async () => {
    const start = Date.now();
    const status = await evaluatePluginSetup(
      "demo",
      "Demo",
      {
        requirements: [
          {
            id: "hung",
            label: "Hung probe",
            severity: "required",
            verify: [{ cmd: "sleep 30" }],
          },
        ],
      },
      { perCommandTimeoutMs: 200 },
    );
    const elapsed = Date.now() - start;
    expect(status.requirements[0]!.ok).toBe(false);
    expect(status.requirements[0]!.verifyDetail).toMatch(/timed out/);
    // Generous upper bound: kill + child cleanup can add a bit.
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("plugin-setup: pluginSetupToCheckGroup", () => {
  it("maps required+failing → blocker, recommended+failing → warning, ok → ok", async () => {
    const status = await evaluatePluginSetup("demo", "Demo", {
      requirements: [
        {
          id: "good",
          label: "Good",
          severity: "required",
          verify: [{ cmd: "true" }],
        },
        {
          id: "blocked",
          label: "Blocked",
          severity: "required",
          verify: [{ cmd: "false" }],
        },
        {
          id: "warned",
          label: "Warned",
          severity: "recommended",
          verify: [{ cmd: "false" }],
        },
      ],
    });
    const group = pluginSetupToCheckGroup(status);
    expect(group.title).toBe("Plugin: Demo (demo)");
    expect(group.lines.map((l) => [l.severity, l.text])).toEqual([
      ["ok", "Good"],
      ["blocker", "Blocked"],
      ["warning", "Warned"],
    ]);
  });
});

describe("plugin-setup: discoverPluginSetupSpecs", () => {
  it("skips plugins without manifest.setup", () => {
    plant("noop", { id: "noop", displayName: "No setup needed" });
    plant("withsetup", {
      id: "withsetup",
      displayName: "Has Setup",
      setup: {
        requirements: [
          {
            id: "a",
            label: "A",
            severity: "required",
            verify: [{ cmd: "true" }],
          },
        ],
      },
    });
    const specs = discoverPluginSetupSpecs(scratch);
    expect(specs.map((s) => s.pluginId)).toEqual(["withsetup"]);
  });

  it("returns [] when plugins dir doesn't exist", () => {
    expect(discoverPluginSetupSpecs(path.join(scratch, "nope"))).toEqual([]);
  });

  it("tolerates bad manifest.json (silently drops the plugin)", () => {
    plant("good", {
      id: "good",
      displayName: "Good",
      setup: {
        requirements: [
          {
            id: "a",
            label: "A",
            severity: "required",
            verify: [{ cmd: "true" }],
          },
        ],
      },
    });
    fs.mkdirSync(path.join(scratch, "broken"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "broken", "manifest.json"), "not json");
    const specs = discoverPluginSetupSpecs(scratch);
    expect(specs.map((s) => s.pluginId)).toEqual(["good"]);
  });
});
