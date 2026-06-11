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

  it("legacy row: ImageContent without sibling `attachments` still surfaces", () => {
    // Rows persisted before the sibling-attachments field landed
    // only carry image metadata on the ImageContent parts.
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

  it("strips agent-facing [Attached file: …] markers from the wire text", () => {
    // The chat handler's prepareUserInput embeds the marker so the
    // LLM knows where the file lives; the user's bubble should show
    // only the prose they actually typed.
    //
    // Marker shape: legacy `— available at .<path>` (pre-N+6.4) and
    // current `— readable at .<path>` (N+6.4) both round-trip the
    // same way through toWire().  This row uses the legacy form on
    // purpose to confirm we don't regress on stored sessions.
    const stored = JSON.stringify({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "这个呢\n" +
            "[Attached file: 账期客户清单及执行标准.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet) — available at ./uploads/账期客户清单及执行标准.xlsx]",
        },
      ],
      attachments: [
        {
          path: "/uploads/账期客户清单及执行标准.xlsx",
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          name: "账期客户清单及执行标准.xlsx",
          size: 4096,
        },
      ],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.text).toBe("这个呢");
    expect(w.attachments).toHaveLength(1);
  });

  it("strips multiple [Attached file: …] markers and leaves user prose", () => {
    const stored = JSON.stringify({
      role: "user",
      content: [
        {
          type: "text",
          text:
            "看一下这两个\n" +
            "[Attached file: a.csv (text/csv) — available at ./uploads/a.csv]\n" +
            "[Attached file: b.pdf (application/pdf) — available at ./uploads/b.pdf]",
        },
      ],
      attachments: [
        { path: "/uploads/a.csv", mimeType: "text/csv" },
        { path: "/uploads/b.pdf", mimeType: "application/pdf" },
      ],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.text).toBe("看一下这两个");
  });

  it("leaves user-typed square-bracketed text alone", () => {
    const stored = JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "i wrote [TODO] earlier" }],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.text).toBe("i wrote [TODO] earlier");
  });

  it("prefers the sibling attachments field even when image parts duplicate it", () => {
    // The storage layer always records the full attachments list as
    // a sibling field on the user message (see
    // SqliteSessionStorage.appendEntry). Image parts in `content`
    // carry the SAME image again so the LLM sees it as multimodal
    // content. The wire layer must NOT report the image twice — the
    // user only attached one file.
    const stored = JSON.stringify({
      role: "user",
      content: [
        { type: "text", text: "this one" },
        {
          type: "image",
          data: "",
          mimeType: "image/png",
          path: "/uploads/x.png",
          name: "x.png",
        },
      ],
      attachments: [
        { path: "/uploads/x.png", mimeType: "image/png", name: "x.png", size: 9 },
      ],
      timestamp: 1,
    });
    const w = toWire(row("user", stored));
    expect(w.attachments).toHaveLength(1);
    expect(w.attachments![0]!.path).toBe("/uploads/x.png");
    // size came from the sibling field (the source of truth), not
    // from the ImageContent (which doesn't carry size).
    expect(w.attachments![0]!.size).toBe(9);
  });

  // ADR-0004 N+4 fix: assistant messages now expose an ordered
  // `blocks` array preserving text/toolCall interleaving. Legacy
  // `text` (joined) + `toolCalls` (flat) stay populated for
  // backwards-compat with old clients.
  it("assistant message gets ordered `blocks` preserving text/toolCall interleaving", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text: "first." },
        { type: "toolCall", id: "c1", name: "list_dir", arguments: { p: "/" } },
        { type: "text", text: "second." },
        { type: "toolCall", id: "c2", name: "read_file", arguments: {} },
      ],
      timestamp: 1,
    });
    const w = toWire(row("assistant", stored));
    expect(w.blocks).toEqual([
      { kind: "text", text: "first." },
      { kind: "toolCall", id: "c1", name: "list_dir", arguments: { p: "/" } },
      { kind: "text", text: "second." },
      { kind: "toolCall", id: "c2", name: "read_file", arguments: {} },
    ]);
    // Legacy fields still populated.
    expect(w.text).toBe("first.second.");
    expect(w.toolCalls).toHaveLength(2);
  });

  it("assistant message with only text has no blocks-only flag drama", () => {
    const stored = JSON.stringify({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      timestamp: 1,
    });
    const w = toWire(row("assistant", stored));
    expect(w.text).toBe("hello");
    expect(w.toolCalls).toBeUndefined();
    expect(w.blocks).toEqual([{ kind: "text", text: "hello" }]);
  });
});
