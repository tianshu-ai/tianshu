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
    id: "minimal",
    displayName: "Minimal",
    description:
      "python:3.12-slim with no extra layers. Same as the new-Sandboxfile placeholder.",
    file: "minimal.yaml",
  },
  {
    id: "browser",
    displayName: "Browser (CloakBrowser + Playwright MCP + noVNC)",
    description:
      "Stealth Chromium running headed under Xvfb, with Playwright MCP on :3200 and noVNC on :6080. Lights up the agent's browser_* tools and the admin Browser viewport.",
    file: "browser.yaml",
  },
  {
    id: "node-python",
    displayName: "Node.js + Python",
    description:
      "node:22-slim base image (skips slow Node install) plus apt-installed Python 3 and CN mirrors. Use when you need both toolchains in one sandbox.",
    file: "node-python.yaml",
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
