// Tests for the read-required precondition: edit_file and
// write_file (when target exists) must be preceded by a
// read_file in the same session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";
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
      expect(out.text).toMatch(/call read_file/i);
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

    it("a tail-only read (offset>0, sees end) does NOT mark the file as read", async () => {
      // Reading offset=5 of a 10-byte file lands in the tail \u2014
      // the agent saw the end (!more) but never the start.
      // Tracker should refuse edit until offset=0 is also seen.
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

    it("a head-only read (offset=0 but more=true) does NOT mark the file as read", async () => {
      // Reading offset=0 limit=1000 of a 2 KB file sees the start
      // but not the end. Tracker should refuse edit until the end
      // is also observed.
      const head = Buffer.from("START_TOKEN");
      const tail = Buffer.from("END_TOKEN");
      const middle = Buffer.alloc(2_000 - head.length - tail.length, 65);
      fs.writeFileSync(
        path.join(userHome, "big.txt"),
        Buffer.concat([head, middle, tail]),
      );
      const r = (await ReadFileTool.execute(
        { path: "/big.txt", offset: 0, limit: 1_000 },
        ctx("session-1"),
      )) as { ok: boolean; nextOffset?: number };
      expect(r.ok).toBe(true);
      expect(r.nextOffset).toBe(1_000);
      const e = (await EditFileTool.execute(
        { path: "/big.txt", edits: [{ old_text: "START_TOKEN", new_text: "X" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(e.ok).toBe(false);
    });

    it("paged reads covering BOTH start and end DO mark the file as read", async () => {
      // Realistic >500 KB case: agent reads chunk 0 ... chunk N
      // until !more. Once both endpoints are observed the tracker
      // grants edit rights without forcing a redundant one-shot
      // re-read.
      const head = Buffer.from("START_TOKEN");
      const tail = Buffer.from("END_TOKEN");
      const middle = Buffer.alloc(2_000 - head.length - tail.length, 65);
      fs.writeFileSync(
        path.join(userHome, "big.txt"),
        Buffer.concat([head, middle, tail]),
      );
      const a = (await ReadFileTool.execute(
        { path: "/big.txt", offset: 0, limit: 1_000 },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(a.ok).toBe(true);
      const b = (await ReadFileTool.execute(
        { path: "/big.txt", offset: 1_000, limit: 5_000 },
        ctx("session-1"),
      )) as { ok: boolean; nextOffset?: number };
      expect(b.ok).toBe(true);
      expect(b.nextOffset).toBeUndefined();
      const e = (await EditFileTool.execute(
        { path: "/big.txt", edits: [{ old_text: "START_TOKEN", new_text: "X" }] },
        ctx("session-1"),
      )) as { ok: boolean };
      expect(e.ok).toBe(true);
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
