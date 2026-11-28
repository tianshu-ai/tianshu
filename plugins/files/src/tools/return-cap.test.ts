// Tests for the return-size cap applied to file-content tool results.
//
// Two distinct limits must not be conflated:
//   - MAX_TEXT_BYTES  → how much we READ (data reachability)
//   - MAX_RETURN_CHARS → how much the MODEL SEES (context budget)
//
// These lock down the second one, plus the scenario that motivated
// it: a PDF whose first 4 KB has no NUL byte gets mis-detected as
// text and decodes to hundreds of thousands of U+FFFD characters.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";
import { ReadFileTool } from "./index.js";
import {
  MAX_RETURN_CHARS,
  truncateForReturn,
} from "./return-cap.js";
import { _resetForTests } from "./read-tracker.js";

let userHome: string;

beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-returncap-"));
  _resetForTests();
});
afterEach(() => {
  fs.rmSync(userHome, { recursive: true, force: true });
  _resetForTests();
});

function makeCtx(): AgentToolContext {
  return {
    pluginId: "files",
    tenantId: "acme",
    userId: "u1",
    capabilities: { get: () => undefined, has: () => false },
    userHomeDir: userHome,
    tenantHomeDir: userHome,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

interface ReadResult {
  ok: boolean;
  text: string;
  truncated?: boolean;
  returnChars?: number;
  maxReturnChars?: number;
  size?: number;
}

describe("truncateForReturn", () => {
  it("returns short text untouched", () => {
    const out = truncateForReturn("hello");
    expect(out.text).toBe("hello");
    expect(out.truncated).toBe(false);
  });

  it("folds the middle of oversized text and keeps head + tail", () => {
    const src = "HEAD" + "x".repeat(100_000) + "TAIL";
    const out = truncateForReturn(src, { maxChars: 1000 });
    expect(out.truncated).toBe(true);
    expect(out.originalChars).toBe(src.length);
    expect(out.text.startsWith("HEAD")).toBe(true);
    expect(out.text.endsWith("TAIL")).toBe(true);
    expect(out.text).toContain("Output truncated");
    // Budget respected (marker adds a little; allow generous slack).
    expect(out.text.length).toBeLessThan(1000 + 500);
  });

  it("treats maxChars <= 0 as disabled", () => {
    const src = "x".repeat(10_000);
    const out = truncateForReturn(src, { maxChars: 0 });
    expect(out.truncated).toBe(false);
    expect(out.text).toBe(src);
  });

  it("appends a resume hint when given", () => {
    const out = truncateForReturn("x".repeat(100_000), {
      maxChars: 500,
      resumeHint: "Re-read with offset=123.",
    });
    expect(out.text).toContain("Re-read with offset=123.");
  });
});

describe("read_file return cap", () => {
  it("caps a large plain-text file even when well under MAX_TEXT_BYTES", async () => {
    // 400 KB of ASCII → decodes to 400K chars, still under the
    // 500 KB read cap but far past the context budget.
    const body = "a".repeat(400_000);
    fs.writeFileSync(path.join(userHome, "big.txt"), body);

    const r = (await ReadFileTool.execute(
      { path: "/big.txt" },
      makeCtx(),
    )) as ReadResult;

    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.maxReturnChars).toBe(MAX_RETURN_CHARS);
    expect(r.returnChars!).toBeLessThanOrEqual(MAX_RETURN_CHARS + 500);
    expect(r.text).toContain("Output truncated");
    // Head and tail both survive.
    expect(r.text.startsWith("// ")).toBe(true);
    expect(r.text.endsWith("a")).toBe(true);
  });

  it("does NOT truncate a normal source file", async () => {
    const body = "export function add(a, b) {\n  return a + b;\n}\n";
    fs.writeFileSync(path.join(userHome, "small.ts"), body);

    const r = (await ReadFileTool.execute(
      { path: "/small.ts" },
      makeCtx(),
    )) as ReadResult;

    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("return a + b;");
  });

  it("a large UTF-8 (CJK) file is capped by CHARACTERS, not bytes", async () => {
    // 3 bytes per char in UTF-8: 200K chars = 600 KB bytes, over the
    // read cap — but the cap that matters is the returned characters.
    const body = "中".repeat(200_000);
    fs.writeFileSync(path.join(userHome, "cjk.txt"), body);

    const r = (await ReadFileTool.execute(
      { path: "/cjk.txt" },
      makeCtx(),
    )) as ReadResult;

    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.returnChars!).toBeLessThanOrEqual(MAX_RETURN_CHARS + 500);
    expect(r.text).toContain("中");
  });

  it("BACKSTOP: a mis-detected PDF (no NUL in first 4 KB) cannot flood the context", async () => {
    // Reproduces the real failure: PDF header + object dict are all
    // printable ASCII, so the NUL-byte heuristic misses it and the
    // file is decoded as UTF-8 into a huge slab of replacement chars.
    const header =
      "%PDF-1.6\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n";
    const stream = "\u0000\u0001\u0002binary-ish".repeat(2_000);
    const pdf = Buffer.concat([
      Buffer.from(header, "latin1"),
      Buffer.from(stream, "latin1"),
    ]);
    fs.writeFileSync(path.join(userHome, "doc.pdf"), pdf);

    const r = (await ReadFileTool.execute(
      { path: "/doc.pdf" },
      makeCtx(),
    )) as ReadResult;

    expect(r.ok).toBe(true);
    // Whether or not binary detection catches it, the returned size
    // is bounded.
    expect(r.text.length).toBeLessThanOrEqual(MAX_RETURN_CHARS + 600);
  });

  it("paging past the read cap still yields the final chunk and nextOffset", async () => {
    const body = "b".repeat(700_000); // > MAX_TEXT_BYTES
    fs.writeFileSync(path.join(userHome, "huge.txt"), body);

    const first = (await ReadFileTool.execute(
      { path: "/huge.txt" },
      makeCtx(),
    )) as ReadResult & { nextOffset?: number };
    expect(first.nextOffset).toBe(500_000);

    const second = (await ReadFileTool.execute(
      { path: "/huge.txt", offset: first.nextOffset },
      makeCtx(),
    )) as ReadResult & { nextOffset?: number };
    expect(second.ok).toBe(true);
    expect(second.nextOffset).toBeUndefined();
    expect(second.truncated).toBe(true);
  });
});
