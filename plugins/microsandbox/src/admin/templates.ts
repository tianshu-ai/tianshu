// Sandboxfile templates surfaced through the admin UI.
//
// Layout: each template is a real `*.yaml` file under
// plugins/microsandbox/templates/. We read them at activate time
// and cache in-memory; they're tiny (a few KB each) so re-reading
// them per request would be fine too — caching just keeps the
// route trivially fast and lets us crash early if a template
// disappears between sync and activate.
//
// The catalog (id + displayName + description) is hand-curated
// here rather than parsed from YAML frontmatter so we keep the
// templates pure-YAML (Yu's preference for "no comment-encoded
// metadata"). When you add a new template:
//   1. drop a *.yaml under templates/
//   2. add a new entry to BUILTIN_TEMPLATES below
//   3. cover any new failure mode in skills/microsandbox-build-use.md

import * as path from "node:path";
import { promises as fs } from "node:fs";

export interface SandboxfileTemplate {
  id: string;
  displayName: string;
  description: string;
  /** Full file content. May contain comments. */
  content: string;
}

interface BuiltinTemplateMeta {
  id: string;
  displayName: string;
  description: string;
  /** Filename relative to the templates directory. */
  file: string;
}

const BUILTIN_TEMPLATES: BuiltinTemplateMeta[] = [
  {
    id: "task-runner",
    displayName: "Task runner (Node + Python + Office libs)",
    description:
      "Recommended Task snapshot. node:22-slim with Python 3.12, git, jq, build-essential, pre-installed data libs (pandas/numpy/matplotlib/openpyxl) + web libs (requests/beautifulsoup4) + office libs (python-docx/python-pptx/pypdf/reportlab/markitdown), libreoffice, CJK + emoji fonts, and CN mirrors for apt/npm/pip. ~700 MB compressed; fast enough for code generation, data analysis, document processing, and shell scripting tasks that don't need a chromium.",
    file: "task-runner.yaml",
  },
  {
    id: "browser",
    displayName: "Browser (CloakBrowser + Playwright MCP + noVNC)",
    description:
      "Stealth Chromium running headed under Xvfb, with Playwright MCP on :3200 and noVNC on :6080. Lights up the agent's browser_* tools and the admin Browser viewport. ~3.2 GB compressed; pick this when the workload genuinely needs to pilot a chromium.",
    file: "browser.yaml",
  },
  {
    id: "task-runner-with-browser",
    displayName: "Task runner + Browser (incremental layer)",
    description:
      "Layered build: take an existing task-runner snapshot and add the browser stack (chromium + Playwright MCP + noVNC) on top. Skips re-installing python/office/libreoffice. MUST be built with the 'based on' dropdown set to a task-runner snapshot \u2014 building this from scratch will fail at the first apt step. Result image is roughly task-runner + 2.5 GB for the chromium binaries.",
    file: "task-runner-with-browser.yaml",
  },
];

/**
 * Load every template file from the plugin's templates directory.
 * Throws if any declared template is missing — better to fail
 * activation loudly than silently drop a broken option from the
 * dropdown. Called once at activate(); the catalog is then served
 * read-only.
 */
export async function loadTemplates(
  templatesDir: string,
): Promise<SandboxfileTemplate[]> {
  const out: SandboxfileTemplate[] = [];
  for (const meta of BUILTIN_TEMPLATES) {
    const abs = path.join(templatesDir, meta.file);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      throw new Error(
        `microsandbox: missing template file "${meta.file}" at ${abs}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    out.push({
      id: meta.id,
      displayName: meta.displayName,
      description: meta.description,
      content,
    });
  }
  return out;
}
