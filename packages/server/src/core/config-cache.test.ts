import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadGlobalConfig,
  writeGlobalConfig,
  clearConfigCache,
} from "./config.js";
import { getGlobalConfigPath } from "./paths.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-cfg-"));
  clearConfigCache();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  clearConfigCache();
});

function writeRaw(obj: unknown): void {
  const p = getGlobalConfigPath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

describe("config read cache", () => {
  it("returns the same content on repeated reads", () => {
    writeRaw({ defaultModel: "a/b" });
    const a = loadGlobalConfig(home);
    const b = loadGlobalConfig(home);
    expect(a.defaultModel).toBe("a/b");
    expect(b.defaultModel).toBe("a/b");
  });

  it("hands out independent clones (mutating one doesn't poison the cache)", () => {
    writeRaw({ apiKeys: { openai: "k" } });
    const a = loadGlobalConfig(home);
    // mutate the returned object
    (a.apiKeys as Record<string, string>).openai = "TAMPERED";
    const b = loadGlobalConfig(home);
    expect(b.apiKeys?.openai).toBe("k"); // cache not poisoned
  });

  it("missing file → {} and is not cached as stale", () => {
    expect(loadGlobalConfig(home)).toEqual({});
    writeRaw({ defaultModel: "x/y" });
    expect(loadGlobalConfig(home).defaultModel).toBe("x/y");
  });

  it("external edit (mtime bump) is picked up on the next read", () => {
    writeRaw({ defaultModel: "one/1" });
    expect(loadGlobalConfig(home).defaultModel).toBe("one/1");

    // Rewrite with a bumped mtime a few ms later so (mtimeMs,size) differ.
    const p = getGlobalConfigPath(home);
    fs.writeFileSync(p, JSON.stringify({ defaultModel: "two/2xxxx" }));
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(p, future, future);

    expect(loadGlobalConfig(home).defaultModel).toBe("two/2xxxx");
  });

  it("writeGlobalConfig punches the cache (same-ms write is not stale)", () => {
    writeRaw({ defaultModel: "old/0" });
    expect(loadGlobalConfig(home).defaultModel).toBe("old/0");
    // Immediate programmatic write — mtime may land in the same ms.
    writeGlobalConfig({ defaultModel: "new/9" }, home);
    expect(loadGlobalConfig(home).defaultModel).toBe("new/9");
  });
});
