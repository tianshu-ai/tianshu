// Unit tests for text-shape helpers + integration through
// edit_file confirming CRLF/BOM round-trip.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyShape, normaliseEnding, shapeOf } from "./text-shape.js";
import { executeEditFile } from "./edit-file.js";

describe("shapeOf", () => {
  it("detects LF and no BOM on a plain LF file", () => {
    const s = shapeOf("alpha\nbeta\n");
    expect(s.ending).toBe("\n");
    expect(s.hadBom).toBe(false);
    expect(s.text).toBe("alpha\nbeta\n");
  });

  it("detects CRLF when any line uses it", () => {
    const s = shapeOf("alpha\r\nbeta\r\n");
    expect(s.ending).toBe("\r\n");
    expect(s.hadBom).toBe(false);
  });

  it("treats mixed-ending files as CRLF (most-conservative — preserve any CRLF that's there)", () => {
    const s = shapeOf("alpha\nbeta\r\ngamma\n");
    expect(s.ending).toBe("\r\n");
  });

  it("strips a leading UTF-8 BOM and remembers it", () => {
    const s = shapeOf("\uFEFFalpha\n");
    expect(s.hadBom).toBe(true);
    expect(s.text).toBe("alpha\n");
  });

  it("empty file => LF, no BOM", () => {
    const s = shapeOf("");
    expect(s.ending).toBe("\n");
    expect(s.hadBom).toBe(false);
    expect(s.text).toBe("");
  });
});

describe("normaliseEnding", () => {
  it("LF input -> LF target is identity", () => {
    expect(normaliseEnding("a\nb\n", "\n")).toBe("a\nb\n");
  });

  it("LF input -> CRLF target expands", () => {
    expect(normaliseEnding("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });

  it("CRLF input -> LF target collapses", () => {
    expect(normaliseEnding("a\r\nb\r\n", "\n")).toBe("a\nb\n");
  });

  it("CRLF input -> CRLF target is idempotent (no double-up)", () => {
    expect(normaliseEnding("a\r\nb\r\n", "\r\n")).toBe("a\r\nb\r\n");
  });

  it("mixed input collapses then expands cleanly", () => {
    expect(normaliseEnding("a\nb\r\nc\n", "\r\n")).toBe("a\r\nb\r\nc\r\n");
  });
});

describe("applyShape", () => {
  it("re-prepends BOM when source had one", () => {
    const s = shapeOf("\uFEFFhello");
    expect(applyShape("world", s)).toBe("\uFEFFworld");
  });

  it("does not add BOM when source had none", () => {
    const s = shapeOf("hello");
    expect(applyShape("world", s)).toBe("world");
  });
});

// ─── edit_file integration: shape preserved across edit ──────────

describe("edit_file preserves shape", () => {
  let userHome: string;
  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-shape-"));
  });
  afterEach(() => {
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it("CRLF file stays CRLF after edit when model sends LF", () => {
    const file = path.join(userHome, "crlf.txt");
    // Pre-existing CRLF file.
    fs.writeFileSync(file, "alpha\r\nbeta\r\ngamma\r\n");
    // Model sends LF in old_text and new_text — exactly the
    // case the legacy code would have failed on.
    const out = executeEditFile(userHome, {
      path: "/crlf.txt",
      edits: [{ old_text: "beta\n", new_text: "BETA\nDELTA\n" }],
    });
    expect(out.ok).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    // No bare LF left from the model's input.
    expect(after).not.toMatch(/[^\r]\n/);
    expect(after).toBe("alpha\r\nBETA\r\nDELTA\r\ngamma\r\n");
  });

  it("LF file stays LF after edit when model sends CRLF", () => {
    const file = path.join(userHome, "lf.txt");
    fs.writeFileSync(file, "alpha\nbeta\ngamma\n");
    const out = executeEditFile(userHome, {
      path: "/lf.txt",
      edits: [{ old_text: "beta\r\n", new_text: "BETA\r\n" }],
    });
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("BOM is preserved across an edit", () => {
    const file = path.join(userHome, "bom.txt");
    fs.writeFileSync(file, "\uFEFFalpha\nbeta\n");
    const out = executeEditFile(userHome, {
      path: "/bom.txt",
      edits: [{ old_text: "alpha", new_text: "ALPHA" }],
    });
    expect(out.ok).toBe(true);
    const after = fs.readFileSync(file, "utf8");
    expect(after.charCodeAt(0)).toBe(0xfeff);
    expect(after).toBe("\uFEFFALPHA\nbeta\n");
  });

  it("BOM + CRLF combined round-trip", () => {
    const file = path.join(userHome, "bom-crlf.txt");
    fs.writeFileSync(file, "\uFEFFalpha\r\nbeta\r\n");
    const out = executeEditFile(userHome, {
      path: "/bom-crlf.txt",
      edits: [{ old_text: "alpha\nbeta", new_text: "X\nY\nZ" }],
    });
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("\uFEFFX\r\nY\r\nZ\r\n");
  });

  it("multi-edit batch on a CRLF file keeps the file CRLF throughout", () => {
    const file = path.join(userHome, "batch.txt");
    fs.writeFileSync(
      file,
      "<!-- TODO: A -->\r\nmid\r\n<!-- TODO: B -->\r\n",
    );
    const out = executeEditFile(userHome, {
      path: "/batch.txt",
      edits: [
        { old_text: "<!-- TODO: A -->", new_text: "first\nsection" },
        { old_text: "<!-- TODO: B -->", new_text: "second\nsection" },
      ],
    });
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(
      "first\r\nsection\r\nmid\r\nsecond\r\nsection\r\n",
    );
  });
});
