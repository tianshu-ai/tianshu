// Smoke tests for the files plugin server module. Hits the route
// handlers directly with stub req/res objects — we don't exercise the
// PluginRegistry here (that's covered by the host's plugins-routes
// tests).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginContext, PluginServerExports } from "@tianshu/plugin-sdk";
import filesPlugin from "./server.js";

interface MockRes {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  status(code: number): MockRes;
  json(body: unknown): MockRes;
}

function makeRes(): MockRes {
  const r: MockRes = {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return r;
}

function makeReq(query: Record<string, string> = {}): {
  query: Record<string, string>;
} {
  return { query };
}

let workspaceDir: string;
let exports_: PluginServerExports;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-files-"));
  fs.mkdirSync(path.join(workspaceDir, "_tenant", "projects", "demo"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(workspaceDir, "_tenant", "projects", "demo", "README.md"), "# Hello");
  fs.writeFileSync(path.join(workspaceDir, "top.txt"), "top-level file");

  const ctx = makeCtx(workspaceDir);
  const out = filesPlugin.activate(ctx);
  exports_ = out instanceof Promise ? ({} as PluginServerExports) : out;
});

afterEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

function makeCtx(dir: string): PluginContext {
  return {
    pluginId: "files",
    tenantId: "test",
    db: {} as never,
    config: {},
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    workspaceDir: dir,
    broadcast: vi.fn(),
  };
}

describe("files plugin: list", () => {
  it("lists workspace root with directories first", async () => {
    const res = makeRes();
    await exports_.routes!.list(makeReq() as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      dir: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(body.dir).toBe("/");
    expect(body.entries[0]!.type).toBe("directory");
    expect(body.entries[0]!.name).toBe("_tenant");
    expect(body.entries.find((e) => e.name === "top.txt")).toBeDefined();
  });

  it("lists nested directories via dir= query", async () => {
    const res = makeRes();
    await exports_.routes!.list(
      makeReq({ dir: "/_tenant/projects/demo" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toContain("README.md");
  });

  it("rejects path traversal", async () => {
    const res = makeRes();
    await exports_.routes!.list(makeReq({ dir: "/../" }) as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("404s missing directory", async () => {
    const res = makeRes();
    await exports_.routes!.list(
      makeReq({ dir: "/nope" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
  });

  it("400s when target is a file, not a dir", async () => {
    const res = makeRes();
    await exports_.routes!.list(
      makeReq({ dir: "/top.txt" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("not_a_directory");
  });
});

describe("files plugin: read", () => {
  it("reads small text files", async () => {
    const res = makeRes();
    await exports_.routes!.read(
      makeReq({ path: "/top.txt" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { content: string; binary: boolean };
    expect(body.binary).toBe(false);
    expect(body.content).toBe("top-level file");
  });

  it("flags binary files without returning content", async () => {
    const binaryPath = path.join(workspaceDir, "blob.bin");
    fs.writeFileSync(binaryPath, Buffer.from([0, 1, 2, 3, 0]));
    const res = makeRes();
    await exports_.routes!.read(
      makeReq({ path: "/blob.bin" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { binary: boolean; content?: string };
    expect(body.binary).toBe(true);
    expect(body.content).toBeUndefined();
  });

  it("413s on files larger than the cap", async () => {
    const big = path.join(workspaceDir, "big.txt");
    fs.writeFileSync(big, Buffer.alloc(1_048_577, 0x61));
    const res = makeRes();
    await exports_.routes!.read(
      makeReq({ path: "/big.txt" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(413);
    expect((res.body as { error: string }).error).toBe("too_large");
  });

  it("400s without a path", async () => {
    const res = makeRes();
    await exports_.routes!.read(makeReq() as never, res as never);
    expect(res.statusCode).toBe(400);
  });

  it("400s on directory paths", async () => {
    const res = makeRes();
    await exports_.routes!.read(
      makeReq({ path: "/_tenant" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toBe("is_directory");
  });

  it("rejects path traversal", async () => {
    const res = makeRes();
    await exports_.routes!.read(
      makeReq({ path: "/../etc/passwd" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});
