// `toWire()` exposes the persisted message shape to the client.
//
// PR #51 added two new sources of attachment metadata that the wire
// translator has to merge:
//
//   - ImageContent parts in user content (for images shown in the
//     bubble as thumbnails)
//   - a sibling `attachments` array on the persisted message (for
//     non-image files we want to render as chips)
//
// We test both, plus the legacy plain-string path that still ships
// over the wire as `text`.

import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./messages.js";
import { toWire } from "./ws-protocol.js";

function row(
  role: ChatMessage["role"],
  content: string,
  id = "m-1",
): ChatMessage {
  return {
    id,
    sessionId: "s-1",
    role,
    content,
    createdAt: 1,
  };
}

describe("toWire", () => {
  it("legacy plain-string user message → text only", () => {
    const w = toWire(row("user", "hello"));
    expect(w).toEqual({
      id: "m-1",
      sessionId: "s-1",
      role: "user",
      text: "hello",
      createdAt: 1,
    });
  });

  it("structured user message: image content → wire attachments", () => {
    const stored = JSON.stringify({
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image",
          data: "",
          mimeType: "image/png",
          path: "/uploads/x.png",
          name: "x.png",
          size: 12345,
        },
      ],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.text).toBe("look");
    expect(w.attachments).toEqual([
      {
        path: "/uploads/x.png",
        mimeType: "image/png",
        name: "x.png",
        size: 12345,
      },
    ]);
  });

  it("structured user message: sibling `attachments` field merges in", () => {
    // Non-image attachments are recorded only in the sibling array;
    // the message body just carries the text note.
    const stored = JSON.stringify({
      role: "user",
      content: [
        {
          type: "text",
          text: "look\n[Attached file: data.csv (text/csv) — at ./uploads/data.csv]",
        },
      ],
      attachments: [
        {
          path: "/uploads/data.csv",
          mimeType: "text/csv",
          name: "data.csv",
          size: 4096,
        },
      ],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.attachments).toEqual([
      {
        path: "/uploads/data.csv",
        mimeType: "text/csv",
        name: "data.csv",
        size: 4096,
      },
    ]);
  });

  it("structured user message: image part + sibling field both surface", () => {
    const stored = JSON.stringify({
      role: "user",
      content: [
        { type: "text", text: "two attachments" },
        {
          type: "image",
          data: "",
          mimeType: "image/png",
          path: "/uploads/x.png",
        },
      ],
      attachments: [
        { path: "/uploads/data.csv", mimeType: "text/csv" },
      ],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.attachments).toHaveLength(2);
    const paths = w.attachments!.map((a) => a.path);
    expect(paths).toContain("/uploads/x.png");
    expect(paths).toContain("/uploads/data.csv");
  });
});
