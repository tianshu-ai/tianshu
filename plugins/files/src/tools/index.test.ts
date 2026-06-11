// Sanity tests for the AgentTool wrappers around the fs tool
// implementations. The detailed per-tool behaviour (path traversal,
// truncation, line cap, etc.) is owned by path-helper.test.ts and
// the per-tool helpers; here we just verify the wrappers route
// args correctly and surface the executor's `{ ok, text }` shape.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "@tianshu/plugin-sdk";
import {
  ListDirTool,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
} from "./index.js";

let userHome: string;
beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-files-tools-"));
});
afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
});

function makeCtx(): AgentToolContext {
  return {
    pluginId: "files",
    tenantId: "acme",
    userId: "u1",
    capabilities: { get: () => undefined, has: () => false },
    userHomeDir: userHome,
    tenantHomeDir: "/tmp/tenant-root",
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

describe("files plugin tools", () => {
  it("write_file then read_file round-trips through the executor wrapper", async () => {
    const w = (await WriteFileTool.execute(
      { path: "/foo.txt", content: "hello world" },
      makeCtx(),
    )) as { ok: boolean };
    expect(w.ok).toBe(true);
    const r = (await ReadFileTool.execute(
      { path: "/foo.txt" },
      makeCtx(),
    )) as { ok: boolean; text: string };
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hello world");
  });

  it("edit_file replaces a unique substring via the wrapper", async () => {
    fs.writeFileSync(path.join(userHome, "a.txt"), "alpha beta gamma");
    const out = (await EditFileTool.execute(
      { path: "/a.txt", old_text: "beta", new_text: "BETA" },
      makeCtx(),
    )) as { ok: boolean };
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(userHome, "a.txt"), "utf8")).toBe(
      "alpha BETA gamma",
    );
  });

  it("list_dir returns the entries it created", async () => {
    fs.writeFileSync(path.join(userHome, "x.txt"), "x");
    fs.mkdirSync(path.join(userHome, "sub"));
    const out = (await ListDirTool.execute({}, makeCtx())) as {
      entries?: Array<{ name: string }>;
    };
    expect(out.entries?.map((e) => e.name).sort()).toEqual(["sub", "x.txt"]);
  });

  it("glob matches via the wrapper", async () => {
    fs.writeFileSync(path.join(userHome, "a.md"), "");
    fs.writeFileSync(path.join(userHome, "b.md"), "");
    fs.writeFileSync(path.join(userHome, "c.txt"), "");
    const out = (await GlobTool.execute(
      { pattern: "**/*.md" },
      makeCtx(),
    )) as { matches?: string[] };
    expect(out.matches?.sort()).toEqual([
      "workspace:///a.md",
      "workspace:///b.md",
    ]);
  });

  it("each tool exports the expected schema name", () => {
    expect(ListDirTool.schema.name).toBe("list_dir");
    expect(ReadFileTool.schema.name).toBe("read_file");
    expect(WriteFileTool.schema.name).toBe("write_file");
    expect(EditFileTool.schema.name).toBe("edit_file");
    expect(GlobTool.schema.name).toBe("glob");
  });
});
