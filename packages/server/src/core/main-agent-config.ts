// Main-agent config (ADR-0008 Phase 3, Apply target).
//
// When a Solution is applied, its main-agent customisations land
// here so the live chat path picks them up every turn (no
// restart — same fs-read-on-each-turn model as tenant skills /
// worker agents):
//
//   _tenant/config/main/
//     main-agent.json        ← this shape (the index)
//     prompt.md              ← tenant prompt override body
//     execution-bias.md      ← host-block override bodies
//     reply-style.md
//     user-onboarding.md
//     fragments/<id>.md      ← custom fragment bodies
//
// The file is OPTIONAL: a tenant that never applied a solution
// has no main-agent.json, and the chat path behaves exactly as
// before (no overrides, no deny lists). This keeps Apply additive
// and reversible — delete the dir and the main agent reverts to
// host defaults.

import fs from "node:fs";
import path from "node:path";

import { getTenantMainConfigDir } from "./paths.js";

const CONFIG_FILE = "main-agent.json";

/** On-disk index. Paths are relative to the main config dir. */
export interface MainAgentConfigJson {
  schema: "tianshu.main-agent.v1";
  /** Relative path to the tenant prompt override body, or null. */
  tenantPromptPath: string | null;
  /** Host-block override sidecar paths (null = use host default). */
  overrides: {
    executionBias: string | null;
    replyStyle: string | null;
    userOnboarding: string | null;
  };
  /** Custom fragments appended to the prompt. */
  customFragments: Array<{ id: string; title: string; path: string }>;
  /** Skill / tool deny lists for the main agent. */
  skillsDeny: string[];
  toolsDeny: string[];
}

/** Resolved config with sidecar bodies inlined, ready for the
 *  chat path to consume. All fields have safe defaults so callers
 *  can use it unconditionally. */
export interface ResolvedMainAgentConfig {
  tenantPrompt: string | null;
  overrides: {
    executionBias: string | null;
    replyStyle: string | null;
    userOnboarding: string | null;
  };
  customFragments: Array<{ id: string; title: string; body: string }>;
  skillsDeny: Set<string>;
  toolsDeny: Set<string>;
  /** True iff a main-agent.json was present + parsed. */
  present: boolean;
}

const EMPTY: ResolvedMainAgentConfig = {
  tenantPrompt: null,
  overrides: { executionBias: null, replyStyle: null, userOnboarding: null },
  customFragments: [],
  skillsDeny: new Set(),
  toolsDeny: new Set(),
  present: false,
};

/** Load + resolve the main-agent config for a tenant. Returns a
 *  safe empty config when nothing is applied. Never throws — a
 *  malformed file degrades to defaults with a warning so a bad
 *  apply can't brick the chat path. */
export function loadMainAgentConfig(
  tenantId: string,
  home?: string,
): ResolvedMainAgentConfig {
  const dir = getTenantMainConfigDir(tenantId, home);
  const file = path.join(dir, CONFIG_FILE);
  let json: MainAgentConfigJson;
  try {
    if (!fs.existsSync(file)) return EMPTY;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.schema == null) {
      return EMPTY;
    }
    json = parsed as MainAgentConfigJson;
  } catch (err) {
    console.warn(
      `[main-agent-config] failed to read ${file}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return EMPTY;
  }

  const read = (rel: string | null): string | null => {
    if (!rel) return null;
    try {
      return fs.readFileSync(path.join(dir, rel), "utf8");
    } catch {
      return null;
    }
  };

  return {
    tenantPrompt: read(json.tenantPromptPath),
    overrides: {
      executionBias: read(json.overrides?.executionBias ?? null),
      replyStyle: read(json.overrides?.replyStyle ?? null),
      userOnboarding: read(json.overrides?.userOnboarding ?? null),
    },
    customFragments: (json.customFragments ?? [])
      .map((f) => ({
        id: f.id,
        title: f.title,
        body: read(f.path) ?? "",
      }))
      .filter((f) => f.body.trim().length > 0),
    skillsDeny: new Set(json.skillsDeny ?? []),
    toolsDeny: new Set(json.toolsDeny ?? []),
    present: true,
  };
}
