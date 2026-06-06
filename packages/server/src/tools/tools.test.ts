// End-to-end-ish tests for every fs tool. We exercise the executor
// directly with a real temp directory acting as the user home.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executeListDir,
  executeReadFile,
  executeWriteFile,
  executeEditFile,
  executeGlob,
  buildToolset,
} from "./index.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-tools-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("list_dir", () => {
  it("lists the root with auto-create", () => {
    fs.rmSync(home, { recursive: true, force: true });
    const r = executeListDir(home, {});
    expect(r.ok).toBe(true);
    expect(r.entries).toEqual([]);
    expect(fs.existsSync(home)).toBe(true);
  });

  it("lists nested paths with directories first", () => {
    fs.mkdirSync(path.join(home, "sub"));
    fs.writeFileSync(path.join(home, "a.txt"), "a");
    fs.writeFileSync(path.join(home, "sub", "b.txt"), "b");
    const r = executeListDir(home, { path: "/" });
    expect(r.ok).toBe(true);
    expect(r.entries?.[0]?.name).toBe("sub");
    expect(r.entries?.[0]?.type).toBe("directory");
    expect(r.entries?.find((e) => e.name === "a.txt")).toBeDefined();
  });

  it("rejects path outside the root", () => {
    const r = executeListDir(home, { path: "/../etc" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("outside");
  });

  it("returns 404-shape result for missing dir", () => {
    const r = executeListDir(home, { path: "/nope" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not found");
  });

  it("rejects a file as a directory", () => {
    fs.writeFileSync(path.join(home, "f.txt"), "x");
    const r = executeListDir(home, { path: "/f.txt" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not a directory");
  });
});

describe("read_file", () => {
  it("reads small text files", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "hello");
    const r = executeReadFile(home, { path: "/a.txt" });
    expect(r.ok).toBe(true);
    expect(r.text).toContain("hello");
    expect(r.size).toBe(5);
  });

  it("flags binary files without dumping bytes", () => {
    fs.writeFileSync(path.join(home, "blob.bin"), Buffer.from([0, 1, 2, 0]));
    const r = executeReadFile(home, { path: "/blob.bin" });
    expect(r.ok).toBe(true);
    expect(r.binary).toBe(true);
  });

  it("paginates large files via offset/limit", () => {
    const big = Buffer.alloc(1_000, 0x61); // 1000 'a' bytes
    fs.writeFileSync(path.join(home, "big.txt"), big);
    const r = executeReadFile(home, { path: "/big.txt", offset: 0, limit: 600 });
    expect(r.ok).toBe(true);
    expect(r.bytesReturned).toBe(600);
    expect(r.nextOffset).toBe(600);
    const r2 = executeReadFile(home, { path: "/big.txt", offset: 600, limit: 600 });
    expect(r2.bytesReturned).toBe(400);
    expect(r2.nextOffset).toBeUndefined();
  });

  it("404s on missing file", () => {
    const r = executeReadFile(home, { path: "/nope.txt" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not found");
  });

  it("rejects directories", () => {
    fs.mkdirSync(path.join(home, "sub"));
    const r = executeReadFile(home, { path: "/sub" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("directory");
  });

  it("rejects path outside root", () => {
    const r = executeReadFile(home, { path: "/../etc/passwd" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("outside");
  });
});

describe("write_file", () => {
  it("creates files including parent dirs", () => {
    const r = executeWriteFile(home, {
      path: "/notes/today.md",
      content: "Hello",
    });
    expect(r.ok).toBe(true);
    expect(r.bytesWritten).toBe(5);
    expect(fs.readFileSync(path.join(home, "notes", "today.md"), "utf8")).toBe("Hello");
  });

  it("overwrites existing files atomically", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "old");
    const r = executeWriteFile(home, { path: "/a.txt", content: "new" });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(home, "a.txt"), "utf8")).toBe("new");
  });

  it("refuses to write the workspace root", () => {
    const r = executeWriteFile(home, { path: "/", content: "" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("root");
  });

  it("refuses to write over a directory", () => {
    fs.mkdirSync(path.join(home, "sub"));
    const r = executeWriteFile(home, { path: "/sub", content: "x" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("directory");
  });

  it("rejects path outside root", () => {
    const r = executeWriteFile(home, { path: "/../etc", content: "x" });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("outside");
  });

  it("doesn't leave the .tmp sidecar around on success", () => {
    executeWriteFile(home, { path: "/a.txt", content: "v" });
    const siblings = fs.readdirSync(home);
    expect(siblings).toEqual(["a.txt"]);
  });
});

describe("edit_file", () => {
  it("replaces a unique substring", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "foo bar baz");
    const r = executeEditFile(home, {
      path: "/a.txt",
      old_text: "bar",
      new_text: "BAR",
    });
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(path.join(home, "a.txt"), "utf8")).toBe("foo BAR baz");
  });

  it("refuses ambiguous matches", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "x x x");
    const r = executeEditFile(home, {
      path: "/a.txt",
      old_text: "x",
      new_text: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.occurrences).toBe(3);
  });

  it("rejects empty old_text", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "anything");
    const r = executeEditFile(home, { path: "/a.txt", old_text: "", new_text: "x" });
    expect(r.ok).toBe(false);
  });

  it("rejects identical old/new", () => {
    fs.writeFileSync(path.join(home, "a.txt"), "hello");
    const r = executeEditFile(home, {
      path: "/a.txt",
      old_text: "hello",
      new_text: "hello",
    });
    expect(r.ok).toBe(false);
  });

  it("404s on missing file", () => {
    const r = executeEditFile(home, {
      path: "/nope.txt",
      old_text: "x",
      new_text: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("not found");
  });

  it("rejects path outside root", () => {
    const r = executeEditFile(home, {
      path: "/../etc",
      old_text: "x",
      new_text: "y",
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("outside");
  });
});

describe("glob", () => {
  it("matches **/* patterns", async () => {
    fs.mkdirSync(path.join(home, "notes", "sub"), { recursive: true });
    fs.writeFileSync(path.join(home, "notes", "a.md"), "");
    fs.writeFileSync(path.join(home, "notes", "sub", "b.md"), "");
    fs.writeFileSync(path.join(home, "x.txt"), "");
    const r = await executeGlob(home, { pattern: "**/*.md" });
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual(["/notes/a.md", "/notes/sub/b.md"]);
  });

  it("supports brace alternation", async () => {
    fs.writeFileSync(path.join(home, "a.md"), "");
    fs.writeFileSync(path.join(home, "a.txt"), "");
    fs.writeFileSync(path.join(home, "a.log"), "");
    const r = await executeGlob(home, { pattern: "*.{md,txt}" });
    expect(r.ok).toBe(true);
    expect(r.matches?.sort()).toEqual(["/a.md", "/a.txt"]);
  });

  it("strips /workspace/ prefix", async () => {
    fs.writeFileSync(path.join(home, "a.md"), "");
    const r = await executeGlob(home, { pattern: "/workspace/*.md" });
    expect(r.ok).toBe(true);
    expect(r.matches).toEqual(["/a.md"]);
  });

  it("rejects ..", async () => {
    const r = await executeGlob(home, { pattern: "../*" });
    expect(r.ok).toBe(false);
  });

  it("rejects empty pattern", async () => {
    const r = await executeGlob(home, { pattern: "" });
    expect(r.ok).toBe(false);
  });
});

describe("buildToolset", () => {
  it("exposes 5 tool schemas with stable names", async () => {
    const ts = await buildToolset({ userHome: home });
    expect(ts.schemas.map((s) => s.name).sort()).toEqual([
      "edit_file",
      "glob",
      "list_dir",
      "read_file",
      "write_file",
    ]);
  });

  it("invoking executor via the map calls the right tool", async () => {
    fs.writeFileSync(path.join(home, "a.txt"), "hi");
    const ts = await buildToolset({ userHome: home });
    const r = await ts.executors.read_file({ path: "/a.txt" });
    expect((r as { ok: boolean }).ok).toBe(true);
    expect((r as { text: string }).text).toContain("hi");
  });

  it("scopes per-user — two homes don't see each other", async () => {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-tools-2-"));
    try {
      fs.writeFileSync(path.join(home, "secret-a.txt"), "alice secret");
      fs.writeFileSync(path.join(home2, "secret-b.txt"), "bob secret");
      const tsA = await buildToolset({ userHome: home });
      const tsB = await buildToolset({ userHome: home2 });

      const a = (await tsA.executors.list_dir({})) as {
        entries: Array<{ name: string }>;
      };
      const b = (await tsB.executors.list_dir({})) as {
        entries: Array<{ name: string }>;
      };
      expect(a.entries.map((e) => e.name)).toEqual(["secret-a.txt"]);
      expect(b.entries.map((e) => e.name)).toEqual(["secret-b.txt"]);

      // Cross-read attempt fails (path traversal).
      const cross = (await tsA.executors.read_file({
        path: `/../${path.basename(home2)}/secret-b.txt`,
      })) as { ok: boolean };
      expect(cross.ok).toBe(false);
    } finally {
      fs.rmSync(home2, { recursive: true, force: true });
    }
  });
});
