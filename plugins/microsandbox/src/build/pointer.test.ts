// Tests for the dual-role pointer file (browser + task) and the
// auto-upgrade path from the legacy single-pointer shape.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pointerPath,
  readPointer,
  readPointers,
  writePointer,
  writePointers,
  type SandboxPointer,
} from "./pointer.js";

let workspace: string;

const MK_POINTER = (suffix: string): SandboxPointer => ({
  snapshotName: `snap-${suffix}`,
  baseImage: "node:22-slim",
  publishedAt: "2026-06-17T16:00:00.000Z",
  publishedBy: "alice",
});

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-ptr-"));
});
afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("dual-role sandbox pointer", () => {
  it("returns nulls when the pointer file does not exist", async () => {
    const pointers = await readPointers(workspace);
    expect(pointers.browser).toBeNull();
    expect(pointers.task).toBeNull();
    expect(await readPointer(workspace)).toBeNull();
  });

  it("legacy single-pointer files upgrade to both roles on read", async () => {
    // Hand-write a legacy file that has only the top-level fields.
    const legacy = MK_POINTER("legacy");
    const file = pointerPath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + "\n", "utf8");

    const pointers = await readPointers(workspace);
    expect(pointers.browser).toEqual(legacy);
    expect(pointers.task).toEqual(legacy);
    // Legacy reader keeps working too.
    expect(await readPointer(workspace)).toEqual(legacy);
  });

  it("writePointers persists per-role entries plus a legacy mirror", async () => {
    const browser = MK_POINTER("browser");
    const task = MK_POINTER("task");
    await writePointers(workspace, { browser, task });

    const raw = JSON.parse(fs.readFileSync(pointerPath(workspace), "utf8"));
    expect(raw.browser).toEqual(browser);
    expect(raw.task).toEqual(task);
    // Legacy mirror = browser pointer
    expect(raw.snapshotName).toBe(browser.snapshotName);
    expect(raw.baseImage).toBe(browser.baseImage);
  });

  it("writePointer (legacy single-pointer API) sets BOTH roles", async () => {
    const ptr = MK_POINTER("shared");
    await writePointer(workspace, ptr);
    const pointers = await readPointers(workspace);
    expect(pointers.browser).toEqual(ptr);
    expect(pointers.task).toEqual(ptr);
  });

  it("can split the two roles to point at different snapshots", async () => {
    const browser = MK_POINTER("for-browser");
    const task = MK_POINTER("for-task");
    await writePointers(workspace, { browser, task });
    const pointers = await readPointers(workspace);
    expect(pointers.browser?.snapshotName).toBe("snap-for-browser");
    expect(pointers.task?.snapshotName).toBe("snap-for-task");
  });

  it("falls back to the task entry for the legacy mirror when browser is null", async () => {
    const task = MK_POINTER("task-only");
    await writePointers(workspace, { browser: null, task });
    const raw = JSON.parse(fs.readFileSync(pointerPath(workspace), "utf8"));
    expect(raw.browser).toBeNull();
    expect(raw.task).toEqual(task);
    expect(raw.snapshotName).toBe(task.snapshotName);
  });

  it("malformed JSON returns nulls (defensive)", async () => {
    const file = pointerPath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");
    const pointers = await readPointers(workspace);
    expect(pointers).toEqual({ browser: null, task: null });
  });
});
