// Smoke test: the host can discover the `files` builtin plugin from
// `packages/server/builtinConfig/plugins/files/manifest.json` and
// activate it via the resolver wired in `index.ts`.
//
// This test does NOT exercise the HTTP layer — it just confirms the
// glue between the synced manifest, the resolver entry, and the
// PluginRegistry doesn't drift apart.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GlobalOps } from "./core/global-ops.js";
import { DbPool } from "./core/db-pool.js";
import { writeTenantConfig } from "./core/config.js";
import {
  moduleMapResolver,
  PluginRegistry,
} from "./core/plugins/index.js";
import filesPlugin from "@tianshu-builtin/plugin-files/server";

describe("builtin files plugin", () => {
  it("discovers, activates, and exposes its routes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-builtin-files-"));
    try {
      const ops = new GlobalOps({ home, pool: new DbPool({ home }) });
      ops.create("acme");
      writeTenantConfig("acme", { plugins: { files: { enabled: true } } }, home);
      ops.poolRef.close("acme");
      const ctx = ops.open("acme");

      const reg = new PluginRegistry({
        resolver: moduleMapResolver({
          "@tianshu-builtin/plugin-files/server": filesPlugin,
        }),
      });
      const entries = await reg.ensureForTenant(ctx);
      const files = entries.find((e) => e.manifest.id === "files");
      expect(files).toBeDefined();
      expect(files!.state).toBe("active");
      expect(files!.exports?.routes).toHaveProperty("list");
      expect(files!.exports?.routes).toHaveProperty("read");
      expect(files!.exports?.routes).toHaveProperty("raw");
      ops.closePool();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
