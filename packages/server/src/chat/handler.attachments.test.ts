// Multimodal attachment plumbing — `prepareMessagesForLlm`.
//
// Locks the contract that:
//   - vision-capable models get base64-inlined ImageContent
//   - text-only models get a downgrade text note (no failed request)
//   - missing files get a graceful text note (no exception)
//   - non-user / non-image content is passed through untouched
//   - consecutive text parts get coalesced
//
// We don't go through the full chat handler here; this is a pure
// function over Messages.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import { prepareMessagesForLlm } from "./handler.js";
import type { ResolvedModelInfo } from "../core/index.js";

function model(supportsImages: boolean): ResolvedModelInfo {
  return {
    id: "anthropic/claude-sonnet-4-6",
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    name: "claude-sonnet-4-6",
    api: "anthropic-messages",
    baseUrl: "",
    reasoning: false,
    contextWindow: 200000,
    maxTokens: 8192,
    supportsImages,
    imageMaxBytes: 5 * 1024 * 1024,
    mode: "chat",
  };
}

function userMsg(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 1, ...({} as Record<string, never>) };
}

function imagePart(extra: Record<string, unknown>): ImageContent & {
  path?: string;
  name?: string;
} {
  return {
    type: "image",
    data: "",
    mimeType: "image/png",
    ...extra,
  } as ImageContent & { path?: string; name?: string };
}

describe("prepareMessagesForLlm", () => {
  it("inlines base64 for vision-capable models when the file exists", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-mm-"));
    try {
      const uploads = path.join(home, "uploads");
      fs.mkdirSync(uploads, { recursive: true });
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      fs.writeFileSync(path.join(uploads, "x.png"), png);

      const msg = userMsg([
        { type: "text", text: "look" } as TextContent,
        imagePart({ path: "/uploads/x.png", name: "x.png" }),
      ]);
      const out = await prepareMessagesForLlm([msg], home, model(true));
      expect(out).toHaveLength(1);
      const content = (out[0] as UserMessage).content as Array<
        TextContent | ImageContent
      >;
      expect(content).toHaveLength(2);
      expect(content[0]).toMatchObject({ type: "text", text: "look" });
      expect(content[1]?.type).toBe("image");
      const image = content[1] as ImageContent;
      expect(image.mimeType).toBe("image/png");
      expect(image.data).toBe(png.toString("base64"));
      // path/name fields stripped after inlining — pi-ai's
      // ImageContent has no use for them downstream.
      expect((image as Record<string, unknown>).path).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("downgrades to a text note when the model has no vision support", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-mm-"));
    try {
      const msg = userMsg([
        { type: "text", text: "look" } as TextContent,
        imagePart({ path: "/uploads/x.png", name: "x.png" }),
      ]);
      const out = await prepareMessagesForLlm([msg], home, model(false));
      const content = (out[0] as UserMessage).content as Array<
        TextContent | ImageContent
      >;
      // No image parts survived, both texts coalesced into one.
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      const text = (content[0] as TextContent).text;
      expect(text).toContain("look");
      expect(text).toContain("no vision support");
      expect(text).toContain("x.png");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("downgrades gracefully when the file is missing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-mm-"));
    try {
      const msg = userMsg([
        imagePart({ path: "/uploads/missing.png", name: "missing.png" }),
      ]);
      const out = await prepareMessagesForLlm([msg], home, model(true));
      const content = (out[0] as UserMessage).content as Array<
        TextContent | ImageContent
      >;
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      // Error wording is whatever the underlying syscall surfaced; we
      // just want to confirm we degraded to a text note rather than
      // crashing.
      expect((content[0] as TextContent).text).toMatch(
        /\[Attached image \(.+missing\.png\]/,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves non-user messages and image-free user messages alone", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-mm-"));
    try {
      const u: UserMessage = userMsg([{ type: "text", text: "hi" } as TextContent]);
      const a: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "yo" } as TextContent],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      };
      const out = await prepareMessagesForLlm([u, a] as Message[], home, model(true));
      expect(out[0]).toBe(u);
      expect(out[1]).toBe(a);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("coalesces consecutive text parts after image substitution", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-mm-"));
    try {
      const msg = userMsg([
        { type: "text", text: "first" } as TextContent,
        imagePart({ path: "/uploads/missing-1.png", name: "a.png" }),
        imagePart({ path: "/uploads/missing-2.png", name: "b.png" }),
        { type: "text", text: "last" } as TextContent,
      ]);
      const out = await prepareMessagesForLlm([msg], home, model(true));
      const content = (out[0] as UserMessage).content as Array<
        TextContent | ImageContent
      >;
      // Two failed images turn into two text notes; flanking texts
      // join them. We expect exactly one TextContent.
      expect(content).toHaveLength(1);
      expect(content[0]?.type).toBe("text");
      const t = (content[0] as TextContent).text;
      expect(t.startsWith("first")).toBe(true);
      expect(t.endsWith("last")).toBe(true);
      expect(t).toContain("a.png");
      expect(t).toContain("b.png");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
