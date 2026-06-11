// Multimodal attachment plumbing — `SqliteSessionStorage.getPathToRoot`
// inflates `{type:"image", data:""}` parts into base64 ImageContent
// just before the LLM call.
//
// Locks the contract that:
//   - vision-capable models get base64-inlined ImageContent
//   - text-only models get a downgrade text note (no failed request)
//   - missing files get a graceful text note (no exception)
//   - already-inlined images pass through untouched
//   - non-user / non-image content is left alone
//
// We don't go through the full chat handler here; this is a focused
// test of the storage layer's image-inflate hook.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ImageContent,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import { GlobalOps } from "../core/global-ops.js";
import { DbPool } from "../core/db-pool.js";
import { ensureActiveSession } from "./messages.js";
import { SqliteSessionStorage } from "./sqlite-session-storage.js";

let home: string;
let ops: GlobalOps;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-mm-"));
  ops = new GlobalOps({ home, pool: new DbPool({ home }) });
  const ctx = ops.create("acme");
  ops.ensureUser(ctx, {
    userId: "user_a",
    provider: "local",
    externalId: "user_a",
    displayName: "User A",
  });
});

afterEach(() => {
  ops.closePool();
  fs.rmSync(home, { recursive: true, force: true });
});

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

function userMsg(content: UserMessage["content"]): UserMessage {
  return { role: "user", content, timestamp: 1 };
}

interface PersistedSession {
  storage: SqliteSessionStorage;
  leafId: string;
  userHome: string;
}

async function persistUserMessage(
  ctx: ReturnType<GlobalOps["open"]>,
  msg: UserMessage,
  inflate?: ConstructorParameters<typeof SqliteSessionStorage>[2]["imageInflate"],
): Promise<PersistedSession> {
  const session = ensureActiveSession(ctx, "user_a");
  const userHome = ctx.userHomeDir("user_a");
  const storage = new SqliteSessionStorage(ctx, session.id, {
    imageInflate: inflate ?? undefined,
  });
  const id = await storage.createEntryId();
  await storage.appendEntry({
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: msg,
  });
  return { storage, leafId: id, userHome };
}

describe("SqliteSessionStorage.getPathToRoot image inflate", () => {
  it("inlines base64 for vision-capable models when the file exists", async () => {
    const ctx = ops.open("acme");
    const userHome = ctx.userHomeDir("user_a");
    fs.mkdirSync(path.join(userHome, "uploads"), { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(userHome, "uploads", "x.png"), png);

    const msg = userMsg([
      { type: "text", text: "look" } as TextContent,
      imagePart({ path: "/uploads/x.png", name: "x.png" }),
    ]);
    const { storage, leafId } = await persistUserMessage(ctx, msg, {
      userHome,
      imageMaxBytes: 5 * 1024 * 1024,
      supportsImages: true,
    });

    const path1 = await storage.getPathToRoot(leafId);
    expect(path1).toHaveLength(1);
    const out = path1[0] as Extract<
      Awaited<ReturnType<typeof storage.getPathToRoot>>[number],
      { type: "message" }
    >;
    const content = (out.message as UserMessage).content as Array<
      TextContent | ImageContent
    >;
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "text", text: "look" });
    expect(content[1]?.type).toBe("image");
    const image = content[1] as ImageContent;
    expect(image.mimeType).toBe("image/png");
    expect(image.data).toBe(png.toString("base64"));
  });

  it("downgrades to a text note when the model has no vision support", async () => {
    const ctx = ops.open("acme");
    const userHome = ctx.userHomeDir("user_a");

    const msg = userMsg([
      { type: "text", text: "look" } as TextContent,
      imagePart({ path: "/uploads/x.png", name: "x.png" }),
    ]);
    const { storage, leafId } = await persistUserMessage(ctx, msg, {
      userHome,
      imageMaxBytes: 5 * 1024 * 1024,
      supportsImages: false,
    });
    const out = (await storage.getPathToRoot(leafId))[0] as {
      type: "message";
      message: UserMessage;
    };
    const content = out.message.content as Array<TextContent | ImageContent>;
    // text + downgraded note (no image part)
    expect(content.find((p) => p.type === "image")).toBeUndefined();
    const note = content.find(
      (p) =>
        p.type === "text" && (p as TextContent).text.includes("no vision support"),
    );
    expect(note).toBeDefined();
    expect((note as TextContent).text).toContain("x.png");
  });

  it("downgrades gracefully when the file is missing", async () => {
    const ctx = ops.open("acme");
    const userHome = ctx.userHomeDir("user_a");

    const msg = userMsg([
      imagePart({ path: "/uploads/missing.png", name: "missing.png" }),
    ]);
    const { storage, leafId } = await persistUserMessage(ctx, msg, {
      userHome,
      imageMaxBytes: 5 * 1024 * 1024,
      supportsImages: true,
    });
    const out = (await storage.getPathToRoot(leafId))[0] as {
      type: "message";
      message: UserMessage;
    };
    const content = out.message.content as Array<TextContent | ImageContent>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("text");
    // Error wording is whatever the underlying syscall surfaced; we
    // just want to confirm we degraded to a text note rather than
    // crashing.
    expect((content[0] as TextContent).text).toMatch(
      /\[Attached image: missing\.png — read failed/,
    );
  });

  it("passes already-inlined images through untouched", async () => {
    const ctx = ops.open("acme");
    const userHome = ctx.userHomeDir("user_a");

    const inlined = "AAAA";
    const msg = userMsg([
      {
        type: "image",
        data: inlined,
        mimeType: "image/png",
      } as ImageContent,
    ]);
    const { storage, leafId } = await persistUserMessage(ctx, msg, {
      userHome,
      imageMaxBytes: 5 * 1024 * 1024,
      supportsImages: true,
    });
    const out = (await storage.getPathToRoot(leafId))[0] as {
      type: "message";
      message: UserMessage;
    };
    const content = out.message.content as Array<TextContent | ImageContent>;
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("image");
    expect((content[0] as ImageContent).data).toBe(inlined);
  });

  it("leaves non-user messages alone", async () => {
    // We don't even need imageInflate set — but we plug it in to
    // confirm the user-only branch is the only one that touches
    // content.
    const ctx = ops.open("acme");
    const userHome = ctx.userHomeDir("user_a");
    const session = ensureActiveSession(ctx, "user_a");
    const storage = new SqliteSessionStorage(ctx, session.id, {
      imageInflate: {
        userHome,
        imageMaxBytes: 5 * 1024 * 1024,
        supportsImages: true,
      },
    });
    const userId = await storage.createEntryId();
    await storage.appendEntry({
      id: userId,
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
      message: userMsg([{ type: "text", text: "hi" } as TextContent]),
    });
    const assistantId = await storage.createEntryId();
    await storage.appendEntry({
      id: assistantId,
      parentId: userId,
      timestamp: new Date().toISOString(),
      type: "message",
      message: {
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
      } as never,
    });
    const out = await storage.getPathToRoot(assistantId);
    expect(out).toHaveLength(2);
    expect((out[0] as { type: "message" }).type).toBe("message");
    expect((out[1] as { type: "message" }).type).toBe("message");
  });

  it("skips inflation entirely when imageInflate is unset", async () => {
    const ctx = ops.open("acme");
    const userHome = ctx.userHomeDir("user_a");
    const msg = userMsg([
      imagePart({ path: "/uploads/x.png", name: "x.png" }),
    ]);
    const { storage, leafId } = await persistUserMessage(ctx, msg);
    const out = (await storage.getPathToRoot(leafId))[0] as {
      type: "message";
      message: UserMessage;
    };
    const content = out.message.content as Array<TextContent | ImageContent>;
    expect(content).toHaveLength(1);
    // Stored shape preserved — empty data, no inlining attempted.
    expect((content[0] as ImageContent).data).toBe("");
  });
});
