// Tests for the read-required precondition: edit_file and
// write_file (when target exists) must be preceded by a
// read_file in the same session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "@tianshu/plugin-sdk";
import { EditFileTool, ReadFileTool, WriteFileTool } from "./index.js";
import { _resetForTests } from "./read-tracker.js";

let userHome: string;

beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-readtrack-"));
  _resetForTests();
});
afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
  _resetForTests();
});

function ctx(sessionId?: string): AgentToolContext {
  return {
    pluginId: "files",
    tenantId: "acme",
    userId: "u1",
    capabilities: { get: () => undefined, has: () => false },
    userHomeDir: userHome,
    tenantHomeDir: "/tmp/tenant-root",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    sessionId,
  };
}

describe("read-required precondition", () => {
  describe("with a sessionId", () => {
    it("edit_file refuses when the file was never read in this session", async () => {
      fs.writeFileSync(path.join(userHome, "a.txt"), "alpha beta gamma");
      const out = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "beta", new_text: "BETA" }] },
        ctx("session-1"),
      )) as { ok: boolean; text: string };
      expect(out.ok).toBe(false);
      expect(out.text).toMatch(/must call read_file/i);
      // file untouched
      expect(fs.readFileSync(path.join(userHome, "a.txt"), "utf8")).toBe(
        "alpha beta gamma",
      );
    });

    it("edit_file succeeds after read_file in the same session", async () => {
      fs.writeFileSync(path.join(userHome, "a.txt"), "alpha beta gamma");
      const r = (await ReadFileTool.execute(
        { path: "/a.txt" },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(r.ok).toBe(true);
      const w = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "beta", new_text: "BETA" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(w.ok).toBe(true);
    });

    it("read in session A doesn't authorise edit in session B", async () => {
      fs.writeFileSync(path.join(userHome, "a.txt"), "alpha beta gamma");
      await ReadFileTool.execute({ path: "/a.txt" }, ctx("session-A"));
      const out = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "beta", new_text: "BETA" }] },
        ctx("session-B"),
      )) as { ok: boolean };
      expect(out.ok).toBe(false);
    });

    it("write_file refuses to overwrite an unread existing file", async () => {
      fs.writeFileSync(path.join(userHome, "doc.md"), "important user work");
      const out = (await WriteFileTool.execute(
        { path: "/doc.md", content: "destroyed" },
        ctx("session-1"),
      )) as { ok: boolean; text: string };
      expect(out.ok).toBe(false);
      expect(out.text).toMatch(/already exists.*haven't read/i);
      expect(fs.readFileSync(path.join(userHome, "doc.md"), "utf8")).toBe(
        "important user work",
      );
    });

    it("write_file allows creating a NEW file without prior read", async () => {
      const out = (await WriteFileTool.execute(
        { path: "/new.md", content: "fresh" },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(out.ok).toBe(true);
    });

    it("write_file allows overwrite after read in the same session", async () => {
      fs.writeFileSync(path.join(userHome, "doc.md"), "v1");
      await ReadFileTool.execute({ path: "/doc.md" }, ctx("session-1"));
      const out = (await WriteFileTool.execute(
        { path: "/doc.md", content: "v2" },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(out.ok).toBe(true);
      expect(fs.readFileSync(path.join(userHome, "doc.md"), "utf8")).toBe("v2");
    });

    it("a successful edit_file marks the file as read so a follow-up edit doesn't need a re-read", async () => {
      fs.writeFileSync(path.join(userHome, "a.txt"), "alpha beta gamma");
      await ReadFileTool.execute({ path: "/a.txt" }, ctx("session-1"));
      const e1 = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "alpha", new_text: "ALPHA" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(e1.ok).toBe(true);
      const e2 = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "gamma", new_text: "GAMMA" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(e2.ok).toBe(true);
    });

    it("a successful write_file marks the file as read so a follow-up edit works", async () => {
      const w = (await WriteFileTool.execute(
        { path: "/n.txt", content: "hello world" },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(w.ok).toBe(true);
      const e = (await EditFileTool.execute(
        { path: "/n.txt", edits: [{ old_text: "hello", new_text: "HELLO" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(e.ok).toBe(true);
    });

    it("partial reads (offset>0) do NOT mark the file as read", async () => {
      // Make a small file, then read it with offset > 0 \u2014 the
      // executor sees this as a partial read and won't mark.
      fs.writeFileSync(path.join(userHome, "a.txt"), "abcdefghij");
      const r = (await ReadFileTool.execute(
        { path: "/a.txt", offset: 5, limit: 100 },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(r.ok).toBe(true);
      const e = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "abc", new_text: "ABC" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(e.ok).toBe(false);
    });
  });

  describe("without a sessionId (e.g. internal route handlers)", () => {
    it("edit_file does NOT enforce read-required (legacy + non-LLM callers)", async () => {
      fs.writeFileSync(path.join(userHome, "a.txt"), "x");
      const out = (await EditFileTool.execute(
        { path: "/a.txt", edits: [{ old_text: "x", new_text: "y" }] },
        ctx(undefined),
      )) as { ok: boolean };
      expect(out.ok).toBe(true);
    });

    it("write_file does NOT enforce read-required for overwrites", async () => {
      fs.writeFileSync(path.join(userHome, "a.txt"), "v1");
      const out = (await WriteFileTool.execute(
        { path: "/a.txt", content: "v2" },
        ctx(undefined),
      )) as { ok: boolean };
      expect(out.ok).toBe(true);
    });
  });
});
