// Manifest hygiene for the wechat plugin.
//
// Mirrors the workboard manifest tests (which exist to prevent
// the kind of "wired tool not declared in manifest" bug from
// 0.3.19). Three checks:
//   - every contributes.channels[].module has a backing
//     server.ts exports.channels[module]
//   - every channel entry has a since field
//   - every since is a valid X.Y.Z[-prerelease] string

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Manifest {
  contributes?: {
    channels?: Array<{ id: string; module: string; since?: string }>;
  };
}

const VERSION_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;

function loadManifest(): Manifest {
  return JSON.parse(
    readFileSync(resolve(__dirname, "..", "manifest.json"), "utf8"),
  ) as Manifest;
}

function loadServerChannelKeys(): string[] {
  const src = readFileSync(resolve(__dirname, "server.ts"), "utf8");
  // Match the literal-keyed channels block in `return { channels: { ... } }`.
  // We keep it textual on purpose: surviving a refactor that
  // shuffles object spread would be worth doing once it actually
  // happens, but as long as the plugin keeps a single literal map,
  // this is the cheapest pin.
  const match = src.match(/channels:\s*\{([\s\S]*?)\},/);
  if (!match) return [];
  return Array.from(match[1].matchAll(/^\s*([A-Z][A-Za-z0-9]+):/gm))
    .map((m) => m[1]!);
}

describe("wechat manifest hygiene", () => {
  it("declares at least one channel", () => {
    const m = loadManifest();
    expect(m.contributes?.channels?.length ?? 0).toBeGreaterThan(0);
  });

  it("every channel module is exported from server.ts", () => {
    const m = loadManifest();
    const exported = new Set(loadServerChannelKeys());
    for (const ch of m.contributes?.channels ?? []) {
      expect(exported, `module ${ch.module} not exported`).toContain(ch.module);
    }
  });

  it("every channel entry has a valid since", () => {
    const m = loadManifest();
    for (const ch of m.contributes?.channels ?? []) {
      expect(ch.since, `${ch.id} missing since`).toBeTruthy();
      expect(ch.since!, `${ch.id} since ${ch.since} malformed`).toMatch(VERSION_RE);
    }
  });
});
