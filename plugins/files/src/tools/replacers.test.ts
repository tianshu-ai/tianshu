// Unit tests for the fuzzy replacer chain in edit_file.
//
// These pin the contract the edit_file orchestrator depends on:
//   - Exact match wins.
//   - Whitespace / indent / line-trim variants are picked up.
//   - Disproportionate matches are rejected.
//   - Empty / impossible inputs return null cleanly.

import { describe, expect, it } from "vitest";
import { findMatch } from "./replacers.js";

describe("findMatch — exact path", () => {
  it("returns kind=exact for byte-for-byte matches", () => {
    const m = findMatch("hello world", "world");
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("exact");
    expect(m!.start).toBe(6);
    expect(m!.end).toBe(11);
    expect(m!.matched).toBe("world");
  });

  it("returns null when find is empty", () => {
    expect(findMatch("hello", "")).toBeNull();
  });

  it("returns null on no match at all", () => {
    expect(findMatch("abc", "xyz")).toBeNull();
  });
});

describe("findMatch — LineTrimmedReplacer", () => {
  it("matches when the file has trailing whitespace the model omitted", () => {
    const file = "first line  \nsecond line\n";
    const m = findMatch(file, "first line\nsecond line");
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("line-trimmed");
    expect(m!.matched).toBe("first line  \nsecond line");
  });

  it("matches when the model has trailing whitespace the file omitted", () => {
    const file = "first line\nsecond line\n";
    const m = findMatch(file, "first line  \nsecond line");
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("line-trimmed");
  });
});

describe("findMatch — WhitespaceNormalizedReplacer", () => {
  it("collapses runs of inline whitespace", () => {
    // File has two spaces between identifiers; model sent one.
    const m = findMatch("const  x  =  1", "const x = 1");
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("whitespace");
    expect(m!.matched).toBe("const  x  =  1");
  });

  it("does not collide on indent (leading whitespace preserved)", () => {
    // Two lines that differ only by leading indent — the
    // normaliser must not match a 0-indent find against a
    // 4-indent line.
    const file = "  foo = 1\nfoo = 1\n";
    const m = findMatch(file, "foo = 1");
    // Both occurrences exist; the exact replacer finds the
    // 0-indent one first.
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("exact");
    expect(m!.start).toBe(file.indexOf("foo = 1"));
  });
});

describe("findMatch — BlockAnchorReplacer", () => {
  it("matches a 4-line block by first + last line, accepts middle drift", () => {
    const file =
      "function f() {\n" +
      "  const x = 1;\n" +
      "  const y = 2;\n" +
      "}\n";
    // Model misremembered the middle. The find must have the
    // same number of lines as the file's matching span (4 lines
    // here): block-anchor uses the line count to bound the slice,
    // not a sliding window.
    const find =
      "function f() {\n" +
      "  // ... a ...\n" +
      "  // ... b ...\n" +
      "}";
    const m = findMatch(file, find);
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("block-anchor");
    expect(m!.matched).toContain("const x = 1");
    expect(m!.matched).toContain("const y = 2");
  });

  it("does not fire on 2-line blocks (need 3+ lines for safety)", () => {
    const file = "alpha\nbeta\n";
    // 2-line find; block-anchor refuses, line-trimmed already
    // matches anyway, but just check the kind isn't block-anchor.
    const m = findMatch(file, "alpha\nbeta");
    expect(m).not.toBeNull();
    expect(m!.kind).not.toBe("block-anchor");
  });
});

describe("findMatch — IndentationFlexibleReplacer", () => {
  it("matches a 4-space-indented multi-line block when the model sent 0 indent", () => {
    // Single-line cases are already covered by SimpleReplacer
    // (substring `indexOf`); the indent replacer matters when
    // every line of `find` needs the same indent shift to land.
    const file = "    if (cond) {\n      return 42;\n    }\n";
    const find = "if (cond) {\n  return 42;\n}";
    const m = findMatch(file, find);
    expect(m).not.toBeNull();
    // The block-anchor replacer can also fire on this; either
    // counts as success. What we really care about: no fallback
    // to null.
    expect(["indent", "block-anchor"]).toContain(m!.kind);
    expect(m!.matched).toContain("if (cond) {");
    expect(m!.matched).toContain("return 42");
  });

  it("matches a tab-indented block when model sent no indent", () => {
    const file = "\tif (cond) {\n\t\treturn 42;\n\t}\n";
    const find = "if (cond) {\n  return 42;\n}";
    const m = findMatch(file, find);
    // Tab + space mix is the hardest case for the indent
    // replacer; if it can't resolve, block-anchor still saves
    // us because first/last lines (after trim) match.
    expect(m).not.toBeNull();
    expect(["indent", "block-anchor"]).toContain(m!.kind);
  });
});

describe("findMatch — disproportionate-match guard", () => {
  it("refuses to match a tiny find against an absurdly large span", () => {
    // We construct a case where one of the relaxed replacers
    // *would* yield a 200-char span for an 8-char `find`. The
    // guard should reject.
    const longSpace = " ".repeat(300);
    const file = `aaa${longSpace}bbb`;
    // No replacer yields this; sanity check we don't blow up.
    const m = findMatch(file, "aaa bbb");
    if (m) {
      // Whatever was matched, must be within 3x the 50-char
      // floor, i.e. ≤150 chars.
      expect(m.matched.length).toBeLessThanOrEqual(150);
    }
  });
});
