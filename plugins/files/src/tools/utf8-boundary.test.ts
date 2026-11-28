// Tests for UTF-8 boundary alignment on byte-paged reads.
//
// The failure this prevents: paging a Chinese (3-byte) or emoji
// (4-byte) file by byte offset splits a character at the seam.
// Decoding then yields U+FFFD in BOTH pages, and because the next
// page starts at the same byte, the character is never legible.

import { describe, expect, it } from "vitest";
import { alignUtf8Boundaries } from "./utf8-boundary.js";

const b = (...bytes: number[]) => Buffer.from(bytes);

/** Assert the slice decodes with no replacement characters. */
function assertClean(buf: Buffer, opts?: { atEnd?: boolean }) {
  const out = alignUtf8Boundaries(buf, opts);
  const text = out.bytes.toString("utf8");
  expect(text).not.toContain("\uFFFD");
  return { text, ...out };
}

describe("alignUtf8Boundaries", () => {
  it("passes ASCII through untouched", () => {
    const src = Buffer.from("hello world");
    const out = assertClean(src, { atEnd: true });
    expect(out.text).toBe("hello world");
    expect(out.droppedHead).toBe(0);
    expect(out.heldTail).toBe(0);
  });

  it("leaves complete multi-byte characters alone", () => {
    const src = Buffer.from("中文结束", "utf8");
    const out = assertClean(src, { atEnd: true });
    expect(out.text).toBe("中文结束");
  });

  it("holds an incomplete 3-byte character at the tail for the next page", () => {
    // "中文" = 3 + 3 bytes. Cut one byte into the second character.
    const full = Buffer.from("中文", "utf8");
    const head = full.subarray(0, 4); // 中(3) + 0xe6
    const out = assertClean(head, { atEnd: false });
    expect(out.text).toBe("中");
    expect(out.heldTail).toBe(1);
  });

  it("drops leading continuation bytes that belong to the previous page", () => {
    const full = Buffer.from("中文", "utf8");
    const tail = full.subarray(3); // starts at 0xe6 of 文? no — boundary test below
    // Build the real case: previous page ended at byte 4, so this page
    // starts with 0x96 0x87 (continuations of 文) followed by 文.
    const page = Buffer.concat([full.subarray(4), Buffer.from("文", "utf8")]);
    const out = assertClean(page, { atEnd: true });
    expect(out.text).toBe("文");
    expect(out.droppedHead).toBe(2);
  });

  it("holds an incomplete 4-byte emoji at the tail", () => {
    const full = Buffer.from("a🎯b", "utf8"); // a(1) + 🎯(4) + b(1)
    const head = full.subarray(0, 3); // a + first 2 bytes of 🎯
    const out = assertClean(head, { atEnd: false });
    expect(out.text).toBe("a");
    expect(out.heldTail).toBe(2);
  });

  it("does not trim at EOF — a short final character is file content", () => {
    const src = Buffer.from("中文", "utf8").subarray(0, 4); // genuinely cut file
    const out = alignUtf8Boundaries(src, { atEnd: true });
    // At EOF we keep the bytes; the truth is the file itself is cut.
    expect(out.heldTail).toBe(0);
  });

  it("handles an empty buffer", () => {
    const out = alignUtf8Boundaries(Buffer.alloc(0), { atEnd: true });
    expect(out.bytes.length).toBe(0);
    expect(out.droppedHead).toBe(0);
    expect(out.heldTail).toBe(0);
  });

  it("never loops on a stray continuation byte in the middle of the file", () => {
    // Invalid UTF-8 in the middle: the scan must still make progress.
    const src = b(0x61, 0x80, 0x62); // a, stray continuation, b
    const out = alignUtf8Boundaries(src, { atEnd: true });
    expect(out.bytes.length).toBe(3); // nothing dropped at head (a is lead)
  });
});