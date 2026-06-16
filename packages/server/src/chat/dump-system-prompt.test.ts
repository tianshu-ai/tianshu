import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dumpSystemPrompt,
  dumpSystemPromptEnabled,
} from "./dump-system-prompt.js";
import type { TenantContext } from "../core/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-dump-prompt-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeCtx(opts: {
  enabled?: boolean;
  tenantId?: string;
}): TenantContext {
  return {
    tenantId: opts.tenantId ?? "acme",
    config: {
      logging: opts.enabled ? { dumpSystemPrompt: true } : {},
    },
    logsDir: path.join(tmp, "logs"),
  } as unknown as TenantContext;
}

describe("dumpSystemPromptEnabled", () => {
  it("returns false by default", () => {
    expect(dumpSystemPromptEnabled(fakeCtx({}))).toBe(false);
  });

  it("returns true when logging.dumpSystemPrompt is set", () => {
    expect(dumpSystemPromptEnabled(fakeCtx({ enabled: true }))).toBe(true);
  });
});

describe("dumpSystemPrompt", () => {
  it("writes to logsDir/system-prompt-<role>-<userId>.txt when enabled", () => {
    const ctx = fakeCtx({ enabled: true });
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "alice",
      systemPrompt: "Hello, world.",
    });
    const file = path.join(ctx.logsDir, "system-prompt-main-alice.txt");
    expect(fs.existsSync(file)).toBe(true);
    const body = fs.readFileSync(file, "utf8");
    expect(body).toContain("# tenant=acme role=main user=alice");
    expect(body).toContain("# bytes=13");
    expect(body).toContain("Hello, world.");
  });

  it("does nothing when disabled", () => {
    const ctx = fakeCtx({});
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "alice",
      systemPrompt: "Hello, world.",
    });
    // logs dir shouldn't even be created
    expect(fs.existsSync(ctx.logsDir)).toBe(false);
  });

  it("creates logsDir lazily on first write", () => {
    const ctx = fakeCtx({ enabled: true });
    expect(fs.existsSync(ctx.logsDir)).toBe(false);
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "alice",
      systemPrompt: "x",
    });
    expect(fs.existsSync(ctx.logsDir)).toBe(true);
  });

  it("overwrites the same role+user file across calls", () => {
    const ctx = fakeCtx({ enabled: true });
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "alice",
      systemPrompt: "first",
    });
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "alice",
      systemPrompt: "second",
    });
    const body = fs.readFileSync(
      path.join(ctx.logsDir, "system-prompt-main-alice.txt"),
      "utf8",
    );
    expect(body).toContain("second");
    expect(body).not.toContain("first");
  });

  it("uses separate files for different roles + users", () => {
    const ctx = fakeCtx({ enabled: true });
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "alice",
      systemPrompt: "main-alice",
    });
    dumpSystemPrompt({
      ctx,
      role: "worker:coder",
      userId: "alice",
      systemPrompt: "worker-alice",
    });
    dumpSystemPrompt({
      ctx,
      role: "main",
      userId: "bob",
      systemPrompt: "main-bob",
    });
    const files = fs.readdirSync(ctx.logsDir).sort();
    // worker:coder gets sanitised but the colon survives.
    expect(files).toEqual([
      "system-prompt-main-alice.txt",
      "system-prompt-main-bob.txt",
      "system-prompt-worker:coder-alice.txt",
    ]);
  });

  it("sanitises unsafe characters in role / userId", () => {
    const ctx = fakeCtx({ enabled: true });
    dumpSystemPrompt({
      ctx,
      role: "../escape",
      userId: "weird/user name",
      systemPrompt: "x",
    });
    const files = fs.readdirSync(ctx.logsDir);
    // `.` and `_` are safe; `/` and space become `_`. The
    // `..` segment in role becomes `..` (still valid), but the
    // `/` separator gets neutered, so no path traversal.
    expect(files).toHaveLength(1);
    const name = files[0]!;
    expect(name).not.toContain("/");
    expect(name).not.toContain(" ");
    expect(name).toContain("escape");
  });

  it("never throws when the underlying write fails", () => {
    // Point logsDir at a path under a regular file: mkdir will
    // fail. The dump helper should swallow the error.
    const blocker = path.join(tmp, "blocker");
    fs.writeFileSync(blocker, "not a directory");
    const ctx = {
      tenantId: "acme",
      config: { logging: { dumpSystemPrompt: true } },
      logsDir: path.join(blocker, "logs"),
    } as unknown as TenantContext;
    // Should not throw.
    expect(() =>
      dumpSystemPrompt({
        ctx,
        role: "main",
        userId: "alice",
        systemPrompt: "x",
      }),
    ).not.toThrow();
  });
});
