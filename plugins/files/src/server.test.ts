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

describe("files plugin: raw", () => {
  it("sets Content-Type and pipes the file", async () => {
    fs.writeFileSync(path.join(workspaceDir, "hello.png"), Buffer.from([1, 2, 3]));

    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let ended = false;
    const fakeRes = {
      statusCode: 200,
      headersSent: false,
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        // Used only on error paths; capture so the assertions can detect.
        (this as unknown as { body: unknown }).body = body;
        return this;
      },
      // Stream-style sink: createReadStream(...).pipe(res) calls
      // res.write / res.end. Vitest doesn't have a Writable stub so
      // we hand-roll a minimal one.
      on() { return this; },
      once() { return this; },
      emit() { return true; },
      write(chunk: Buffer) {
        chunks.push(chunk);
        return true;
      },
      end(chunk?: Buffer) {
        if (chunk) chunks.push(chunk);
        ended = true;
      },
    };

    await exports_.routes!.raw(
      makeReq({ path: "/hello.png" }) as never,
      fakeRes as never,
    );
    // Wait a tick for the pipe to flush.
    await new Promise((r) => setTimeout(r, 30));

    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["Content-Length"]).toBe("3");
    expect(ended).toBe(true);
    const concatenated = Buffer.concat(chunks);
    expect(concatenated.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("404s missing file", async () => {
    const res = makeRes();
    await exports_.routes!.raw(
      makeReq({ path: "/nope.png" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = makeRes();
    await exports_.routes!.raw(
      makeReq({ path: "/../etc/passwd" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});
