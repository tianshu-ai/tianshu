// Sanity tests for the templates loader.
//
// We don't snapshot the YAML bodies — those evolve with every
// dependency rev. Instead we lock down:
//   1. All built-in templates load successfully against the real
//      plugin templates dir (catches missing-file regressions
//      before activate-time).
//   2. The catalog ordering is stable (task-runner first because
//      it's the recommended Task snapshot, then browser, then
//      node-python, then minimal) — UI relies on this for the
//      dropdown's default.
//   3. Missing files raise a descriptive error pointing at the
//      offending path so plugin authors can fix it fast.

import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { loadTemplates } from "./templates.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const realTemplatesDir = path.resolve(here, "..", "..", "templates");

describe("microsandbox sandboxfile templates", () => {
  it("loads all built-in templates from the plugin templates dir", async () => {
    const templates = await loadTemplates(realTemplatesDir);
    expect(templates.map((t) => t.id)).toEqual([
      "task-runner",
      "browser",
      "node-python",
      "minimal",
    ]);
    for (const t of templates) {
      expect(t.content.length).toBeGreaterThan(0);
      expect(t.displayName).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });

  it("task-runner template uses node:22-slim and pre-installs common pip libs", async () => {
    const templates = await loadTemplates(realTemplatesDir);
    const tr = templates.find((t) => t.id === "task-runner");
    expect(tr).toBeDefined();
    expect(tr!.content).toMatch(/image:\s*node:22-slim/);
    expect(tr!.content).toMatch(/pandas/);
    expect(tr!.content).toMatch(/matplotlib/);
    // CN mirror config wired up
    expect(tr!.content).toMatch(/aliyun\.com|tsinghua\.edu\.cn|npmmirror\.com/);
  });

  it("minimal template starts with the python:3.12-slim image header (placeholder)", async () => {
    const templates = await loadTemplates(realTemplatesDir);
    const minimal = templates.find((t) => t.id === "minimal");
    expect(minimal).toBeDefined();
    expect(minimal!.content).toMatch(/image:\s*python:3\.12-slim/);
  });

  it("browser template includes CloakBrowser + Playwright MCP + noVNC", async () => {
    // We don't lock down the precise URL — that bumps with chromium
    // releases — but the three logical layers should all be present
    // because that's the whole point of this template.
    const templates = await loadTemplates(realTemplatesDir);
    const browser = templates.find((t) => t.id === "browser");
    expect(browser).toBeDefined();
    expect(browser!.content).toMatch(/cloakbrowser/i);
    expect(browser!.content).toMatch(/@playwright\/mcp/);
    expect(browser!.content).toMatch(/novnc/i);
  });

  it("node-python template uses node:22-slim and installs python3 + npmmirror", async () => {
    const templates = await loadTemplates(realTemplatesDir);
    const np = templates.find((t) => t.id === "node-python");
    expect(np).toBeDefined();
    expect(np!.content).toMatch(/image:\s*node:22-slim/);
    expect(np!.content).toMatch(/python3/);
    expect(np!.content).toMatch(/npmmirror\.com/);
  });

  it("raises a descriptive error when a template file is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msb-templates-"));
    // Empty dir → loader expects task-runner.yaml + browser.yaml +
    // node-python.yaml + minimal.yaml; the loader fails fast on
    // the first missing file (task-runner, since it's first).
    await expect(loadTemplates(tmp)).rejects.toThrow(/task-runner\.yaml/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
