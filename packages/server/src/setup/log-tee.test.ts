// Unit tests for the rolling-log tee.
//
// installLogTee is module-scoped-singleton (persists its install
// state in a `let state`). Every test that needs a fresh install
// must vi.resetModules() and dynamically re-import the module,
// otherwise idempotency short-circuits the second install and the
// prune logic (which runs inside install) never re-runs against
// the new env.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `tianshu-log-tee-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function freshInstall() {
  vi.resetModules();
  const mod = await import("./log-tee.js");
  mod.installLogTee();
  return mod;
}

describe("installLogTee", () => {
  let tmpDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    savedEnv = {
      TIANSHU_LOG_DIR: process.env.TIANSHU_LOG_DIR,
      TIANSHU_LOG_KEEP_DAYS: process.env.TIANSHU_LOG_KEEP_DAYS,
      TIANSHU_LOG_DISABLE: process.env.TIANSHU_LOG_DISABLE,
    };
    process.env.TIANSHU_LOG_DIR = tmpDir;
    delete process.env.TIANSHU_LOG_KEEP_DAYS;
    delete process.env.TIANSHU_LOG_DISABLE;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates the log file on install and writes the boot header", async () => {
    const mod = await freshInstall();
    const path = mod.currentLogPath();
    expect(path).toBeTruthy();
    expect(path!.startsWith(tmpDir)).toBe(true);
    expect(path!).toMatch(/server-\d{4}-\d{2}-\d{2}\.log$/);
    expect(existsSync(path!)).toBe(true);
    expect(mod.isLogTeeInstalled()).toBe(true);
    const contents = readFileSync(path!, "utf8");
    expect(contents).toContain("tianshu server boot");
  });

  it("tees a raw process.stdout.write to the file", async () => {
    // We check process.stdout.write directly — that's the exact
    // hook the tee patches. console.log routes through the same
    // path in production, but vitest wraps `console` for its own
    // reporter, so testing at the process.stdout layer isolates
    // the tee's contract from the test-runner's console handling.
    const mod = await freshInstall();
    const path = mod.currentLogPath()!;
    process.stdout.write("[test] hello via stdout 12345\n");
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("[test] hello via stdout 12345");
  });

  it("tees a raw process.stderr.write to the file", async () => {
    const mod = await freshInstall();
    const path = mod.currentLogPath()!;
    process.stderr.write("[test] stderr sample 67890\n");
    const contents = readFileSync(path, "utf8");
    expect(contents).toContain("[test] stderr sample 67890");
  });

  it("prunes log files older than the retention window", async () => {
    const oldPath = join(tmpDir, "server-2020-01-01.log");
    writeFileSync(oldPath, "ancient contents\n");
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldPath, oldTime, oldTime);

    const recentPath = join(tmpDir, "server-2024-01-01.log");
    writeFileSync(recentPath, "recent-ish\n");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(recentPath, twoDaysAgo, twoDaysAgo);

    process.env.TIANSHU_LOG_KEEP_DAYS = "7";
    await freshInstall();

    const remaining = readdirSync(tmpDir).filter((n) => n.startsWith("server-") && n.endsWith(".log"));
    expect(remaining).not.toContain("server-2020-01-01.log");
    expect(remaining).toContain("server-2024-01-01.log");
    expect(remaining.length).toBeGreaterThanOrEqual(2);
  });

  it("does not delete recent logs when keep-days is small", async () => {
    const path = join(tmpDir, "server-2024-06-01.log");
    writeFileSync(path, "keep me\n");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(path, twoDaysAgo, twoDaysAgo);

    process.env.TIANSHU_LOG_KEEP_DAYS = "3";
    await freshInstall();

    expect(existsSync(path)).toBe(true);
  });

  it("only prunes files matching the server-YYYY-MM-DD.log pattern", async () => {
    const stranger = join(tmpDir, "important-user-data.txt");
    writeFileSync(stranger, "not a log\n");
    const ancient = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(stranger, ancient, ancient);

    await freshInstall();
    expect(existsSync(stranger)).toBe(true);
  });

  it("is idempotent within one module instance", async () => {
    const mod = await freshInstall();
    const firstPath = mod.currentLogPath();
    mod.installLogTee(); // second call, same module
    const secondPath = mod.currentLogPath();
    expect(firstPath).toBe(secondPath);
  });

  it("respects TIANSHU_LOG_DISABLE=1 and skips install", async () => {
    process.env.TIANSHU_LOG_DISABLE = "1";
    vi.resetModules();
    const mod = await import("./log-tee.js");
    mod.installLogTee();
    expect(mod.isLogTeeInstalled()).toBe(false);
    expect(mod.currentLogPath()).toBeNull();
    // And no log file got created.
    const files = readdirSync(tmpDir).filter((n) => n.startsWith("server-"));
    expect(files.length).toBe(0);
  });
});
