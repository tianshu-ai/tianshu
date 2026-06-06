// Skill loader (ADR-0004 §11).
//
// A "skill" is a markdown how-to file that ships alongside its
// owning plugin (host self-ships some too). The agent doesn't see
// skill bodies by default \u2014 instead it sees a list of
// `{ name, description }` and pulls a body into context on demand
// via the host meta-tool `load_skill(name)`.
//
// Frontmatter shape:
//
//   ---
//   name: tianshu-mount-layout
//   description: How the host filesystem maps into the sandbox guest.
//   when:                                # optional
//     toolPresent: exec                  # any of these forms
//     capabilityPresent: sandbox.shell
//   ---
//
// `when` is plain {key:value} \u2014 v0 supports `toolPresent` and
// `capabilityPresent`. Composition (and/or) is v1+.
//
// We intentionally don't bring in gray-matter / js-yaml etc.\u2014a
// minimal hand-parser for `key: value` plus a flat sub-block keeps
// the dependency footprint tiny and the failure modes obvious. If
// authors want richer frontmatter, we'll switch then.

import fs from "node:fs";
import path from "node:path";
import type { SkillContribution } from "@tianshu/plugin-sdk";

export interface LoadedSkill {
  /** `<plugin-id>.<contribution-id>` for logs/registry; the
   *  agent-facing name lives in frontmatter, see `name`. */
  source: { pluginId: string; contributionId: string };
  /** Absolute path to the skill file, for hot-reload diagnostics. */
  filePath: string;
  /** From frontmatter \u2014 unique across all enabled skills. The agent
   *  uses this name when calling `load_skill(name)`. */
  name: string;
  /** From frontmatter \u2014 single-line summary the agent uses to decide
   *  whether to load the skill. Keep it specific. */
  description: string;
  /** Optional gate: only show this skill to the agent when the
   *  predicate is satisfied for the current tenant. */
  when?: SkillWhen;
  /** The full markdown body (after frontmatter). What `load_skill`
   *  returns. */
  body: string;
}

export interface SkillWhen {
  toolPresent?: string;
  capabilityPresent?: string;
}

export interface SkillLoadFailure {
  source: { pluginId: string; contributionId: string };
  filePath: string;
  reason: string;
}

export interface SkillLoadResult {
  skills: LoadedSkill[];
  failures: SkillLoadFailure[];
}

/**
 * Load every `contributes.skills[]` entry for one plugin.
 * `pluginDir` is the manifest's directory; skill paths are resolved
 * against it.
 */
export function loadSkillsForPlugin(args: {
  pluginId: string;
  pluginDir: string;
  contributions: readonly SkillContribution[];
}): SkillLoadResult {
  const skills: LoadedSkill[] = [];
  const failures: SkillLoadFailure[] = [];

  for (const c of args.contributions) {
    const filePath = path.resolve(args.pluginDir, c.path);
    const source = { pluginId: args.pluginId, contributionId: c.id };

    if (!fs.existsSync(filePath)) {
      failures.push({ source, filePath, reason: "skill file not found" });
      continue;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      failures.push({
        source,
        filePath,
        reason: `read failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if (!parsed.ok) {
      failures.push({ source, filePath, reason: parsed.reason });
      continue;
    }
    const { frontmatter, body } = parsed;

    const name = pickString(frontmatter, "name");
    const description = pickString(frontmatter, "description");
    if (!name) {
      failures.push({ source, filePath, reason: "frontmatter missing `name`" });
      continue;
    }
    if (!description) {
      failures.push({
        source,
        filePath,
        reason: "frontmatter missing `description`",
      });
      continue;
    }

    skills.push({
      source,
      filePath,
      name,
      description,
      when: extractWhen(frontmatter),
      body: body.trim(),
    });
  }

  return { skills, failures };
}

// ─── frontmatter parser ─────────────────────────────────────────

type Frontmatter = Record<string, string | Record<string, string>>;

interface ParseOk {
  ok: true;
  frontmatter: Frontmatter;
  body: string;
}
interface ParseErr {
  ok: false;
  reason: string;
}

function parseFrontmatter(src: string): ParseOk | ParseErr {
  // No frontmatter? Treat as empty map, body = whole file. Some
  // skills may legitimately have nothing to declare beyond name/desc;
  // we still require those fields, so authors will see the missing
  // -name error if they skip the block entirely.
  if (!src.startsWith("---")) {
    return { ok: true, frontmatter: {}, body: src };
  }
  const end = src.indexOf("\n---", 3);
  if (end < 0) {
    return { ok: false, reason: "frontmatter open `---` has no closing `---`" };
  }
  const fmText = src.slice(3, end).replace(/^\r?\n/, "");
  let body = src.slice(end + 4);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);

  const fm: Frontmatter = {};
  let currentBlock: { key: string; map: Record<string, string> } | null = null;

  const lines = fmText.split(/\r?\n/);
  for (const lineRaw of lines) {
    if (lineRaw.trim().length === 0) continue;
    const indented = /^\s/.test(lineRaw);
    const line = lineRaw.trimEnd();
    if (!indented) {
      // top-level "key:" or "key: value"
      const m = /^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!m) {
        return { ok: false, reason: `bad frontmatter line: "${line}"` };
      }
      const key = m[1]!;
      const value = m[2]!;
      if (value.length === 0) {
        // start of a sub-block
        const map: Record<string, string> = {};
        currentBlock = { key, map };
        fm[key] = map;
      } else {
        currentBlock = null;
        fm[key] = unquote(value);
      }
    } else {
      if (!currentBlock) {
        return {
          ok: false,
          reason: `indented line "${line.trim()}" without an enclosing block`,
        };
      }
      const m = /^\s+([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
      if (!m) {
        return { ok: false, reason: `bad sub-block line: "${line}"` };
      }
      currentBlock.map[m[1]!] = unquote(m[2]!);
    }
  }
  return { ok: true, frontmatter: fm, body };
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function pickString(fm: Frontmatter, key: string): string | undefined {
  const v = fm[key];
  return typeof v === "string" ? v : undefined;
}

function extractWhen(fm: Frontmatter): SkillWhen | undefined {
  const w = fm["when"];
  if (!w || typeof w !== "object") return undefined;
  const out: SkillWhen = {};
  if (typeof w.toolPresent === "string") out.toolPresent = w.toolPresent;
  if (typeof w.capabilityPresent === "string")
    out.capabilityPresent = w.capabilityPresent;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Filter skills by their `when:` predicate against the current
 * tenant state.
 */
export function filterSkillsForTenant(
  skills: LoadedSkill[],
  ctx: { hasTool(name: string): boolean; hasCapability(name: string): boolean },
): LoadedSkill[] {
  return skills.filter((s) => {
    if (!s.when) return true;
    if (s.when.toolPresent && !ctx.hasTool(s.when.toolPresent)) return false;
    if (s.when.capabilityPresent && !ctx.hasCapability(s.when.capabilityPresent)) {
      return false;
    }
    return true;
  });
}
