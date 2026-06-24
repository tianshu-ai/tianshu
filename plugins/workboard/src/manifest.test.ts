// Manifest hygiene tests.
//
// We were burned once: `worker_analytics` shipped in 0.3.19 with
// `buildWorkerAnalyticsTool` wired into server.ts's exports but
// without a matching `contributes.tools[]` entry in manifest.json.
// The plugin registry only emits tools that appear in the manifest,
// so the tool was de-facto invisible to the agent even though every
// other layer (build, unit tests, the dist export object) looked
// green.
//
// These tests pin the symmetry: every module name that server.ts
// puts into `exports.tools` must have a manifest entry, and every
// manifest entry must have a backing export. They run on the source
// tree (not the built bundle) so a missing line trips well before
// `npm publish`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Manifest {
  contributes?: {
    tools?: Array<{ id: string; module: string }>;
  };
}

function loadManifest(): Manifest {
  // src/ runs out of __dirname; manifest.json is one level up at the
  // plugin root.
  const path = resolve(__dirname, "..", "manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function loadServerToolKeys(): string[] {
  // Parse the source verbatim — we want this to fail in the
  // typecheck phase too if someone reshuffles the exports object,
  // not just at runtime. The pattern matches lines like:
  //   `TaskListTool: buildTaskListTool(toolDeps),`
  // inside the `return { tools: { ... } }` block.
  const src = readFileSync(
    resolve(__dirname, "server.ts"),
    "utf8",
  );
  const matches = src.matchAll(/^\s*([A-Z][A-Za-z0-9]+Tool):\s*build[A-Z][A-Za-z0-9]+Tool\(/gm);
  return Array.from(matches, (m) => m[1]);
}

describe("workboard manifest hygiene", () => {
  it("every tool export in server.ts has a manifest contributes.tools entry", () => {
    const manifest = loadManifest();
    const manifestModules = new Set(
      (manifest.contributes?.tools ?? []).map((t) => t.module),
    );
    const exportKeys = loadServerToolKeys();
    expect(exportKeys.length).toBeGreaterThan(0);
    const missing = exportKeys.filter((k) => !manifestModules.has(k));
    expect(
      missing,
      `server.ts exports tool modules that manifest.json doesn't list: ${missing.join(", ")}. ` +
        `Add a matching {id, module} pair to plugins/workboard/manifest.json's contributes.tools[].`,
    ).toEqual([]);
  });

  it("every manifest contributes.tools entry resolves to a server.ts export", () => {
    const manifest = loadManifest();
    const manifestModules = (manifest.contributes?.tools ?? []).map((t) => t.module);
    const exportKeys = new Set(loadServerToolKeys());
    expect(manifestModules.length).toBeGreaterThan(0);
    const orphaned = manifestModules.filter((m) => !exportKeys.has(m));
    expect(
      orphaned,
      `manifest.json declares tool modules that server.ts doesn't export: ${orphaned.join(", ")}. ` +
        `Either add the export or drop the manifest entry.`,
    ).toEqual([]);
  });

  it("every manifest contributes.tools entry has a unique id", () => {
    const manifest = loadManifest();
    const ids = (manifest.contributes?.tools ?? []).map((t) => t.id);
    const seen = new Map<string, number>();
    for (const id of ids) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    const dupes = Array.from(seen.entries()).filter(([, n]) => n > 1).map(([id]) => id);
    expect(dupes).toEqual([]);
  });
});
