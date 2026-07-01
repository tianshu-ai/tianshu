// Solution export / import (file round-trip).
//
// Studio already round-trips a SolutionDetail back through the
// frozen `/solutions/save` contract via useSolutionEdits().save().
// Export/import reuse the SAME SolutionSpecInput shape so a file
// written by Export can be fed straight into `/solutions/save` on
// Import — no new server routes, no schema drift.
//
// Wire format is a thin envelope around that payload:
//
//   {
//     "format": "tianshu.workforce-studio.solution",
//     "version": 1,
//     "exportedAt": "<ISO>",
//     "spec": { ...SolutionSpecInput }
//   }
//
// The envelope lets Import validate it's looking at the right kind
// of file (and reject a random JSON) and gives us a version knob
// for future migrations without breaking older exports.

import {
  seedFragments,
  seedOverrides,
  type SolutionDetail,
} from "./solution-state.js";

export const SOLUTION_FILE_FORMAT = "tianshu.workforce-studio.solution";
export const SOLUTION_FILE_VERSION = 1;

/** The save() payload shape (mirrors SolutionSpecInput on the SDK
 *  side). Kept local + structural so this module doesn't depend on
 *  server-only types. */
export interface SolutionSpecInputLike {
  slug: string;
  name: string;
  description: string;
  plugins: { enabled: string[] };
  mainAgent: {
    tenantPrompt: string | null;
    skillsAllow: string[] | null;
    skillsDeny: string[];
    toolsAllow: string[] | null;
    toolsDeny: string[];
    overrides: {
      executionBias: string | null;
      replyStyle: string | null;
      userOnboarding: string | null;
    };
    customFragments: Array<{ id: string; title: string; body: string }>;
  };
  workers: Array<{
    slug: string;
    kind: string;
    name: string;
    description: string | null;
    modelId: string | null;
    enabled: boolean;
    systemPrompt: string | null;
    toolsAllow: string[] | null;
    skillsAllow: string[] | null;
    overrides?: { executionBias: string | null };
    source?: string;
  }>;
}

export interface SolutionFileEnvelope {
  format: string;
  version: number;
  exportedAt: string;
  spec: SolutionSpecInputLike;
}

/** Convert a loaded SolutionDetail into the canonical save() input.
 *  This is the read-path equivalent of useSolutionEdits().save():
 *  it inlines the sidecar bodies (prompts, SOUL.md, overrides,
 *  fragments) the host expects on the write path, WITHOUT any of
 *  the interactive edit state. Passing the result to
 *  `/solutions/save` reproduces the solution faithfully. */
export function detailToInput(detail: SolutionDetail): SolutionSpecInputLike {
  const { spec } = detail;

  // Reuse the exact same block-detection helpers the interactive
  // editor seeds from, so an exported file reproduces what Save
  // would have written.
  const overrides = seedOverrides(detail.mainBlocks);
  const fragments = seedFragments(detail.mainBlocks).filter(
    (f) => f.body.trim().length > 0,
  );

  return {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    plugins: { enabled: [...spec.plugins.enabled].sort() },
    mainAgent: {
      tenantPrompt:
        detail.tenantPrompt && detail.tenantPrompt.trim().length > 0
          ? detail.tenantPrompt
          : null,
      skillsAllow: null,
      skillsDeny: [...spec.mainAgent.skillsDeny].sort(),
      toolsAllow: null,
      toolsDeny: [...(spec.mainAgent.toolsDeny ?? [])].sort(),
      overrides: {
        executionBias: overrides.executionBias,
        replyStyle: overrides.replyStyle,
        userOnboarding: overrides.userOnboarding,
      },
      customFragments: fragments,
    },
    workers: spec.workers.map((w) => {
      // Per-worker execution-bias override lives in the worker
      // view's blocks (overrideKey === "executionBias").
      const ebBlock = detail.workerViews[w.slug]?.blocks.find(
        (b) => b.overrideKey === "executionBias",
      );
      return {
        slug: w.slug,
        kind: w.kind,
        name: w.name,
        description: w.description,
        modelId: w.modelId,
        enabled: w.enabled,
        systemPrompt: detail.workerPrompts?.[w.slug] ?? null,
        toolsAllow: w.toolsAllow ?? null,
        skillsAllow: w.skillsAllow ?? null,
        overrides: {
          executionBias: ebBlock?.overridden ? ebBlock.text : null,
        },
        source: w.source,
      };
    }),
  };
}

/** Build the downloadable envelope + filename for a solution. */
export function buildSolutionFile(detail: SolutionDetail): {
  filename: string;
  json: string;
} {
  const envelope: SolutionFileEnvelope = {
    format: SOLUTION_FILE_FORMAT,
    version: SOLUTION_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    spec: detailToInput(detail),
  };
  return {
    filename: `${detail.spec.slug}.solution.json`,
    json: JSON.stringify(envelope, null, 2),
  };
}

/** Trigger a browser download of a solution file. */
export function downloadSolution(detail: SolutionDetail): void {
  const { filename, json } = buildSolutionFile(detail);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Parse + validate an uploaded solution file. Accepts either the
 *  full envelope OR a bare SolutionSpecInput (so hand-written specs
 *  and older exports still import). Throws with a readable message
 *  on anything malformed. */
export function parseSolutionFile(text: string): SolutionSpecInputLike {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON.");
  }
  if (!data || typeof data !== "object") {
    throw new Error("File is empty or not an object.");
  }
  const obj = data as Record<string, unknown>;

  // Envelope form.
  let spec: unknown = obj;
  if (typeof obj.format === "string" || "spec" in obj) {
    if (obj.format && obj.format !== SOLUTION_FILE_FORMAT) {
      throw new Error(
        `Unrecognised file format "${String(obj.format)}". Expected a Workforce Studio solution export.`,
      );
    }
    if (
      typeof obj.version === "number" &&
      obj.version > SOLUTION_FILE_VERSION
    ) {
      throw new Error(
        `File version ${obj.version} is newer than this build supports (${SOLUTION_FILE_VERSION}). Upgrade Tianshu.`,
      );
    }
    spec = obj.spec;
  }

  if (!spec || typeof spec !== "object") {
    throw new Error("Missing solution spec.");
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.slug !== "string" || s.slug.length === 0) {
    throw new Error("Spec has no slug.");
  }
  if (typeof s.name !== "string") {
    throw new Error("Spec has no name.");
  }
  if (!s.plugins || typeof s.plugins !== "object") {
    throw new Error("Spec has no plugins block.");
  }
  if (!Array.isArray(s.workers)) {
    throw new Error("Spec has no workers array.");
  }
  if (!s.mainAgent || typeof s.mainAgent !== "object") {
    throw new Error("Spec has no mainAgent block.");
  }
  return spec as SolutionSpecInputLike;
}

/** Slugify a candidate string into the studio's allowed alphabet
 *  (lowercase letters, digits, - and _). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Pick a slug that doesn't collide with existing slugs by
 *  appending -2, -3, … when needed. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  const root = slugify(base) || "imported-solution";
  if (!taken.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const cand = `${root}-${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${root}-${Date.now()}`;
}
