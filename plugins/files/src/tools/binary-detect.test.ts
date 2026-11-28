// Tests for binary-vs-text detection in read_file.
//
// The motivating failure: a PDF whose first 4 KB is entirely
// printable ASCII (`%PDF-1.6` + a plain object dictionary) sailed
// past the old NUL-byte probe and was decoded as UTF-8.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentToolContext } from "@tianshu-ai/plugin-sdk";
import { ReadFileTool } from "./index.js";
import {
  badCharRatio,
  binaryByExtension,
  binaryByMagic,
  detectBinary,
  extractionHint,
  MAX_BAD_CHAR_RATIO,
} from "./binary-detect.js";
import { _resetForTests } from "./read-tracker.js";

const utf8 = (s: string) => Buffer.from(s, "utf8");
const bytes = (...b: number[]) => Buffer.from(b);

describe("binaryByExtension", () => {
  it("flags common document and archive formats", () => {
    for (const p of ["a.pdf", "a.docx", "a.xlsx", "a.zip", "a.png", "a.mp4"]) {
      expect(binaryByExtension(p)).not.toBeNull();
    }
  });

  it("does not flag text and source files", () => {
    for (const p of ["a.ts", "a.md", "a.json", "a.csv"] as const) {
      // .csv is text even though spreadsheets are zipped OOXML.
      expect(binaryByExtension(p)).toBeNull();
    }
  });

  it("is case-insensitive and handles dotfiles / no extension", () => {
    expect(binaryByExtension("/tmp/REPORT.PDF")).toBe("pdf");
    expect(binaryByExtension("/tmp/.gitignore")).toBeNull();
    expect(binaryByExtension("/tmp/Makefile")).toBeNull();
  });
});

describe("binaryByMagic", () => {
  it("recognises PDF by signature regardless of filename", () => {
    expect(binaryByMagic(utf8("%PDF-1.7\n"))).toBe("pdf");
  });

  it("recognises OOXML / zip containers", () => {
    expect(binaryByMagic(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe("zip");
  });

  it("recognises images, audio and archives", () => {
    expect(binaryByMagic(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(binaryByMagic(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(binaryByMagic(bytes(0x1f, 0x8b, 0x08))).toBe("gzip");
    expect(binaryByMagic(utf8("fLaC"))).toBe("flac");
  });

  it("returns null for plain text", () => {
    expect(binaryByMagic(utf8("# Heading\nsome text\n"))).toBeNull();
  });
});

describe("badCharRatio", () => {
  it("is 0 for clean text including CJK", () => {
    expect(badCharRatio("hello 世界，这是中文。")).toBe(0);
  });

  it("rises when bytes do not round-trip through UTF-8", () => {
    const junk = Buffer.from([0xff, 0xfe, 0x81, 0x00, 0x90]).toString("utf8");
    expect(badCharRatio(junk)).toBeGreaterThan(MAX_BAD_CHAR_RATIO);
  });

  it("stays low for a Latin-1-ish text sample", () => {
    const latin = "caf\u00e9 na\u00efve r\u00e9sum\u00e9 \u2014 plain text\n".repeat(50);
    expect(badCharRatio(latin)).toBeLessThan(MAX_BAD_CHAR_RATIO);
  });
});

describe("detectBinary", () => {
  it("prefers the extension verdict for known binary names", () => {
    const v = detectBinary("report.pdf", utf8("%PDF-1.7\n"));
    expect(v.binary).toBe(true);
    expect(v.via).toBe("extension");
  });

  it("falls back to magic for a misnamed binary blob", () => {
    const v = detectBinary("data.txt", utf8("%PDF-1.7\n"));
    expect(v.binary).toBe(true);
    expect(v.via).toBe("magic");
  });

  it("keeps the NUL probe as the last cheap check", () => {
    const v = detectBinary("mystery.qqq", bytes(0x61, 0x62, 0x00, 0x63));
    expect(v.binary).toBe(true);
    expect(v.via).toBe("nul");
  });

  it("does not flag ordinary text", () => {
    expect(detectBinary("notes.md", utf8("# hi\nthere\n")).binary).toBe(false);
  });
});

describe("extractionHint", () => {
  it("names pdftotext for PDFs", () => {
    expect(extractionHint("a.pdf", "pdf", "workspace:///a.pdf")).toContain("pdftotext");
  });

  it("names pandoc for office documents", () => {
    expect(extractionHint("a.docx", "docx", "workspace:///a.docx")).toContain("pandoc");
  });

  it("names unzip for archives", () => {
    expect(extractionHint("a.zip", "zip", "workspace:///a.zip")).toContain("unzip");
  });
});

// ── End-to-end through the tool ───────────────────────────────────

let userHome: string;

beforeEach(() => {
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-bindetect-"));
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

interface R {
  ok: boolean;
  text: string;
  binary?: boolean;
  truncated?: boolean;
}

describe("read_file binary handling", () => {
  it("returns an actionable hint for a PDF instead of mojibake", async () => {
    const header = "%PDF-1.6\n1 0 obj\n<< /Type /Catalog >>\nendobj\n";
    const pdf = Buffer.concat([utf8(header), bytes(0x00, 0x01, 0xff, 0xfe).slice(0, 2)]);
    fs.writeFileSync(path.join(userHome, "doc.pdf"), pdf);

    const r = (await ReadFileTool.execute({ path: "/doc.pdf" }, makeCtx())) as R;
    expect(r.ok).toBe(true);
    expect(r.binary).toBe(true);
    expect(r.text).toContain("pdftotext");
    expect(r.text).not.toContain("\uFFFD\uFFFD\uFFFD");
  });

  it("detects a PDF with no NUL byte in the head at all", async () => {
    // The exact case the old probe missed: entire first 4 KB printable.
    const head = "%PDF-1.6\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n".repeat(60);
    fs.writeFileSync(path.join(userHome, "clean.pdf"), utf8(head));

    const r = (await ReadFileTool.execute({ path: "/clean.pdf" }, makeCtx())) as R;
    expect(r.binary).toBe(true);
    expect(r.text).toContain("pdftotext");
  });

  it("still returns inline images for png", async () => {
    const png = Buffer.concat([
      bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      bytes(0x00, 0x00, 0x00, 0x0d),
    ]);
    fs.writeFileSync(path.join(userHome, "pic.png"), png);
    const r = (await ReadFileTool.execute({ path: "/pic.png" }, makeCtx())) as R & {
      images?: unknown[];
    };
    expect(r.binary).toBe(true);
    expect(Array.isArray(r.images)).toBe(true);
  });

  it("treats Chinese markdown as text, not binary", async () => {
    fs.writeFileSync(
      path.join(userHome, "cn.md"),
      "# 标题\n\n这是一段中文说明，包含标点、数字 123 和 emoji 🎯。\n",
    );
    const r = (await ReadFileTool.execute({ path: "/cn.md" }, makeCtx())) as R;
    expect(r.binary).toBeFalsy();
    expect(r.text).toContain("这是一段中文说明");
  });

  it("catches an extensionless binary blob via the text-ratio check", async () => {
    // No extension, no known magic, no NUL — only the ratio check can
    // catch this.
    const junk = Buffer.from(
      Array.from({ length: 4000 }, (_, i) => (i % 3 === 0 ? 0xff : 0x81 + (i % 20))),
    );
    fs.writeFileSync(path.join(userHome, "blob"), junk);

    const r = (await ReadFileTool.execute({ path: "/blob" }, makeCtx())) as R;
    expect(r.binary).toBe(true);
    expect(r.text).toContain("not valid UTF-8");
  });
});