// Builtin-plugin manifest hygiene: every `contributes.tools[]`
// entry in every builtin plugin must declare `since` as a valid
// `X.Y.Z[-prerelease]` string.
//
// Why:
//   The boot-time tool-delta detector (post-0.3.20) needs `since`
//   to figure out which tools to advertise to live sessions when
//   the user upgrades. We treat missing-since as "existed forever"
//   to be friendly to third-party plugins during the v0 marketplace
//   transition — but for builtin plugins, missing `since` means a
//   session that just upgraded won't be notified about a new tool,
//   and the user is back in the silent-skip bug zone we just fixed.
//
//   This test runs the same hygiene check workboard's own
//   `manifest.test.ts` does, but across ALL builtin plugin
//   manifests in one place. (workboard's local copy stays so the
//   plugin owns its own contract — adding a failing check here
//   would surprise plugin authors with cross-plugin assertions in
//   the server test suite, but as long as both files agree the
//   redundancy is harmless.)

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const PLUGINS_DIR = resolve(__dirname, "..", "..", "..", "..", "..", "plugins");

interface BuiltinManifest {
  id: string;
  contributes?: {
    tools?: Array<{ id: string; module: string; since?: string }>;
  };
}

const VERSION_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;

function discoverBuiltinManifests(): Array<{
  pluginDir: string;
  manifest: BuiltinManifest;
}> {
  if (!existsSync(PLUGINS_DIR)) {
    throw new Error(
      `expected builtin plugin dir at ${PLUGINS_DIR}, but it doesn't exist`,
    );
  }
  const out: Array<{ pluginDir: string; manifest: BuiltinManifest }> = [];
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(PLUGINS_DIR, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as BuiltinManifest;
    out.push({ pluginDir: entry.name, manifest });
  }
  // Sort for deterministic test output.
  out.sort((a, b) => a.pluginDir.localeCompare(b.pluginDir));
  return out;
}

describe("builtin plugin manifest — since hygiene", () => {
  const all = discoverBuiltinManifests();

  it("discovers at least one builtin plugin", () => {
    expect(all.length).toBeGreaterThan(0);
  });

  it.each(all)(
    "$pluginDir: every contributes.tools[] entry has a since",
    ({ pluginDir, manifest }) => {
      const tools = manifest.contributes?.tools ?? [];
      // Plugins without tools (UI-only, capability-only, etc.) are
      // exempt — the test is about declared tools, not plugin
      // surface in general.
      if (tools.length === 0) return;
      const missing = tools.filter((t) => !t.since).map((t) => t.id);
      expect(
        missing,
        `${pluginDir} declares tools without since: ${missing.join(", ")}. ` +
          `Builtin plugins must set since so the boot-time tool-delta ` +
          `detector can notify live sessions after an upgrade.`,
      ).toEqual([]);
    },
  );

  it.each(all)(
    "$pluginDir: every since field is a valid X.Y.Z[-prerelease] string",
    ({ pluginDir, manifest }) => {
      const tools = manifest.contributes?.tools ?? [];
      const bad = tools
        .filter((t) => t.since && !VERSION_RE.test(t.since))
        .map((t) => `${t.id}=${t.since}`);
      expect(
        bad,
        `${pluginDir} has malformed since values (must be X.Y.Z, no ranges/aliases): ${bad.join(", ")}`,
      ).toEqual([]);
    },
  );
});
