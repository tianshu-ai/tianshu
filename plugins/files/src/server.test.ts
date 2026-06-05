// Smoke tests for the files plugin server module. Hits the route
// handlers directly with stub req/res objects — we don't exercise the
// PluginRegistry here (that's covered by the host's plugins-routes
// tests).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { PluginContext, PluginServerExports } from "@tianshu/plugin-sdk";
import filesPlugin, { sanitiseFilename, pickNonClashingPath } from "./server.js";

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

function makeReq(query: Record<string, string> = {}, userId = "dev"): {
  query: Record<string, string>;
  ctx: { userId: string };
} {
  return { query, ctx: { userId } };
}

const USER_ID = "dev";
let workspaceDir: string;
let userHome: string;
let exports_: PluginServerExports;

beforeEach(() => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-files-"));
  userHome = path.join(workspaceDir, "users", USER_ID);
  // Seed the shared `_tenant/` area so we can prove the plugin doesn't
  // expose it: it sits next to `users/<id>/` but the plugin must keep
  // the user's view rooted at their own home.
  fs.mkdirSync(path.join(workspaceDir, "_tenant", "projects", "demo"), {
    recursive: true,
  });
  fs.writeFileSync(path.join(workspaceDir, "_tenant", "projects", "demo", "README.md"), "# Hello");
  fs.mkdirSync(path.join(userHome, "sub"), { recursive: true });
  fs.writeFileSync(path.join(userHome, "top.txt"), "top-level file");

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
    userHomeDir: (userId: string) => path.join(dir, "users", userId),
    broadcast: vi.fn(),
  };
}

describe("files plugin: list", () => {
  it("lists the user's home as root, with directories first", async () => {
    const res = makeRes();
    await exports_.routes!.list(makeReq() as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as {
      dir: string;
      entries: Array<{ name: string; type: string }>;
    };
    expect(body.dir).toBe("/");
    expect(body.entries[0]!.name).toBe("sub");
    expect(body.entries[0]!.type).toBe("directory");
    expect(body.entries.find((e) => e.name === "top.txt")).toBeDefined();
    // Crucially, the shared `_tenant/` directory must NOT show up:
    // the user's root is their home, not the tenant workspace.
    expect(body.entries.find((e) => e.name === "_tenant")).toBeUndefined();
  });

  it("lists nested directories via dir= query", async () => {
    fs.writeFileSync(path.join(userHome, "sub", "a.md"), "a");
    const res = makeRes();
    await exports_.routes!.list(
      makeReq({ dir: "/sub" }) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toContain("a.md");
  });

  it("creates the user home if missing", async () => {
    fs.rmSync(userHome, { recursive: true, force: true });
    const res = makeRes();
    await exports_.routes!.list(makeReq() as never, res as never);
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(userHome)).toBe(true);
  });

  it("401s when no userId is on the request", async () => {
    const res = makeRes();
    // makeReq with empty userId simulates an unauthenticated request.
    await exports_.routes!.list(
      { query: {}, ctx: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(401);
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
    const binaryPath = path.join(userHome, "blob.bin");
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
    const big = path.join(userHome, "big.txt");
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
      makeReq({ path: "/sub" }) as never,
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
    fs.writeFileSync(path.join(userHome, "hello.png"), Buffer.from([1, 2, 3]));

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

// ─── upload ──────────────────────────────────────────────────────────

describe("sanitiseFilename", () => {
  it("returns a basename with the original extension", () => {
    expect(sanitiseFilename("data.csv")).toBe("data.csv");
    expect(sanitiseFilename("photo.JPG")).toBe("photo.JPG");
  });

  it("strips directory components", () => {
    expect(sanitiseFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitiseFilename("/abs/path/to/x.txt")).toBe("x.txt");
    expect(sanitiseFilename("dir/sub/dir/x.txt")).toBe("x.txt");
  });

  it("replaces unsafe characters", () => {
    // path.basename doesn't treat `:` or `?` as separators, so the
    // basename is `c?d.txt`; we then substitute the `?` with `_`.
    expect(sanitiseFilename("a:b/c?d.txt")).toBe("c_d.txt");
    expect(sanitiseFilename("hello*world?.png")).toMatch(
      /^hello_world_?\.png$/,
    );
  });

  it("keeps CJK characters", () => {
    expect(sanitiseFilename("数据集.csv")).toBe("数据集.csv");
  });

  it("rejects empty / dotty noise", () => {
    expect(sanitiseFilename("")).toBe("");
    expect(sanitiseFilename(".")).toBe("");
    expect(sanitiseFilename("..")).toBe("");
  });

  it("caps absurdly long names at 200 chars", () => {
    const long = "a".repeat(500) + ".txt";
    expect(sanitiseFilename(long).length).toBeLessThanOrEqual(200);
  });
});

describe("pickNonClashingPath", () => {
  it("returns the candidate as-is when the path is free", () => {
    expect(pickNonClashingPath(userHome, "fresh.txt")).toBe(
      path.join(userHome, "fresh.txt"),
    );
  });

  it("appends -1, -2, … when prior names exist", () => {
    fs.writeFileSync(path.join(userHome, "x.txt"), "");
    expect(pickNonClashingPath(userHome, "x.txt")).toBe(
      path.join(userHome, "x-1.txt"),
    );
    fs.writeFileSync(path.join(userHome, "x-1.txt"), "");
    expect(pickNonClashingPath(userHome, "x.txt")).toBe(
      path.join(userHome, "x-2.txt"),
    );
  });
});

describe("files plugin: upload", () => {
  function fakeUploadReq(filename: string | undefined, body: Buffer) {
    const headers: Record<string, string | string[]> = {};
    if (filename !== undefined) headers["x-filename"] = filename;
    const stream = Readable.from([body]) as Readable & {
      headers: typeof headers;
      ctx: { userId: string };
    };
    stream.headers = headers;
    stream.ctx = { userId: USER_ID };
    return stream;
  }

  it("writes the file under uploads/ and returns its workspace path", async () => {
    const res = makeRes();
    const body = Buffer.from("hello, world\n");
    await exports_.routes!.upload(
      fakeUploadReq(encodeURIComponent("note.txt"), body) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ path: "/uploads/note.txt", size: body.length });
    const written = fs.readFileSync(
      path.join(userHome, "uploads", "note.txt"),
      "utf8",
    );
    expect(written).toBe("hello, world\n");
  });

  it("auto-suffixes colliding filenames", async () => {
    const uploadsDir = path.join(userHome, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(uploadsDir, "x.txt"), "old");

    const res = makeRes();
    await exports_.routes!.upload(
      fakeUploadReq(encodeURIComponent("x.txt"), Buffer.from("new")) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { path: string }).path).toBe("/uploads/x-1.txt");
    expect(fs.readFileSync(path.join(uploadsDir, "x.txt"), "utf8")).toBe("old");
    expect(fs.readFileSync(path.join(uploadsDir, "x-1.txt"), "utf8")).toBe(
      "new",
    );
  });

  it("rejects requests without an X-Filename header", async () => {
    const res = makeRes();
    await exports_.routes!.upload(
      fakeUploadReq(undefined, Buffer.from("x")) as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: "missing_filename" });
  });

  it("sanitises path-traversal filenames down to a basename", async () => {
    const res = makeRes();
    await exports_.routes!.upload(
      fakeUploadReq(
        encodeURIComponent("../../etc/passwd"),
        Buffer.from("nope"),
      ) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect((res.body as { path: string }).path).toBe("/uploads/passwd");
    expect(
      fs.existsSync(path.join(userHome, "uploads", "passwd")),
    ).toBe(true);
    // Confirm nothing escaped.
    expect(
      fs.existsSync(path.join(workspaceDir, "etc", "passwd")),
    ).toBe(false);
  });

  it("401s when no user is attached to the request", async () => {
    const res = makeRes();
    const stream = Readable.from([Buffer.from("x")]) as Readable & {
      headers: Record<string, string>;
    };
    stream.headers = { "x-filename": encodeURIComponent("a.txt") };
    await exports_.routes!.upload(stream as never, res as never);
    expect(res.statusCode).toBe(401);
  });
});
