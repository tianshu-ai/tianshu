// Sanity tests for the templates loader.
//
// We don't snapshot the YAML bodies — those evolve with every
// dependency rev. Instead we lock down:
//   1. All built-in templates load successfully against the real
//      plugin templates dir (catches missing-file regressions
//      before activate-time).
//   2. The catalog ordering is stable (task-runner first because
//      it's the recommended Task snapshot; browser second;
//      task-runner-with-browser last as the incremental option)
//      — UI relies on this for the dropdown's default.
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
      "task-runner-with-browser",
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
    // Data libs
    expect(tr!.content).toMatch(/pandas/);
    expect(tr!.content).toMatch(/matplotlib/);
    // Office libs (the original missing piece)
    expect(tr!.content).toMatch(/python-docx/);
    expect(tr!.content).toMatch(/python-pptx/);
    expect(tr!.content).toMatch(/markitdown/);
    // CN mirror config wired up
    expect(tr!.content).toMatch(/aliyun\.com|tsinghua\.edu\.cn|npmmirror\.com/);
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

  it("task-runner-with-browser template ships the browser stack but not the task-runner pip layer", async () => {
    const templates = await loadTemplates(realTemplatesDir);
    const layered = templates.find((t) => t.id === "task-runner-with-browser");
    expect(layered).toBeDefined();
    // Browser bits present
    expect(layered!.content).toMatch(/cloakbrowser/i);
    expect(layered!.content).toMatch(/@playwright\/mcp/);
    expect(layered!.content).toMatch(/novnc/i);
    // Office / data layer NOT re-installed (it lives in the
    // base snapshot we layer on top of)
    expect(layered!.content).not.toMatch(/pip3 install.*pandas/);
    expect(layered!.content).not.toMatch(/libreoffice-writer/);
  });

  it("raises a descriptive error when a template file is missing", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "msb-templates-"));
    // Empty dir → loader expects task-runner.yaml first; fails
    // fast on the first missing file.
    await expect(loadTemplates(tmp)).rejects.toThrow(/task-runner\.yaml/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
