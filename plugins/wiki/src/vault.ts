// Wiki vault storage — layout, path safety, and Markdown+frontmatter
// read/write helpers shared by the server tools and the compact hook.
//
// Layout (per user, host filesystem):
//   users/<userId>/wiki/
//     sources/     one page per compacted conversation segment (raw
//                  evidence layer — the LLM-generated compaction
//                  summary, filed verbatim)
//     entities/    people / projects / systems (LLM-synthesised)
//     concepts/    reusable knowledge (LLM-synthesised)
//     topics/      cross-segment topic syntheses / digests
//     .wiki/       bookkeeping: ingest cursor etc.
//
// Everything is plain Markdown with YAML-ish frontmatter so the vault
// is Obsidian-compatible (wikilinks, graph, etc.).

import fs from "node:fs";
import path from "node:path";

export const WIKI_DIR = "wiki";
export const SECTIONS = ["sources", "entities", "concepts", "topics"] as const;
export type Section = (typeof SECTIONS)[number];

const NAME_RE = /^[A-Za-z0-9._\u4e00-\u9fff-]+$/;

/** A slug safe as a single path segment (no slashes, no traversal). */
export function safeSlug(s: string): string {
  const base = s
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._\u4e00-\u9fff-]/g, "")
    .slice(0, 80);
  return base || "untitled";
}

export function isSafeSlug(s: string): boolean {
  return NAME_RE.test(s) && s !== "." && s !== "..";
}

/** `<userHome>/wiki`. userHome is `<tenant>/workspace/users/<userId>`. */
export function wikiRoot(userHome: string): string {
  return path.join(userHome, WIKI_DIR);
}

function sectionDir(userHome: string, section: Section): string {
  return path.join(wikiRoot(userHome), section);
}

/** Resolve a `<section>/<slug>.md` path, confined to the wiki dir.
 *  Returns null if the section or slug is unsafe / escapes root. */
export function resolvePage(
  userHome: string,
  section: string,
  slug: string,
): string | null {
  if (!SECTIONS.includes(section as Section)) return null;
  if (!isSafeSlug(slug)) return null;
  const file = path.join(sectionDir(userHome, section as Section), `${slug}.md`);
  const root = path.resolve(wikiRoot(userHome));
  if (!path.resolve(file).startsWith(root + path.sep)) return null;
  return file;
}

export interface PageMeta {
  [key: string]: string | number | string[] | undefined;
}

/** Serialise minimal YAML frontmatter + body. Keeps it dependency-free
 *  (Obsidian only needs simple key: value / list frontmatter). */
export function renderPage(meta: PageMeta, body: string): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n") + body.replace(/\s*$/, "") + "\n";
}

function yamlScalar(v: string | number): string {
  if (typeof v === "number") return String(v);
  // Quote when the value could confuse a YAML parser.
  if (/^[\w .@/\u4e00-\u9fff-]+$/.test(v) && !/^\s|\s$/.test(v)) return v;
  return JSON.stringify(v);
}

/** Write a page atomically (temp + rename). Creates the section dir. */
export function writePage(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export interface ListedPage {
  section: Section;
  slug: string;
  title: string;
  updatedAt?: string;
  path: string; // "<section>/<slug>"
}

/** List all pages across sections with their frontmatter title. */
export function listPages(userHome: string): ListedPage[] {
  const out: ListedPage[] = [];
  for (const section of SECTIONS) {
    const dir = sectionDir(userHome, section);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".md"));
    } catch {
      continue;
    }
    for (const name of names) {
      const slug = name.slice(0, -3);
      const file = path.join(dir, name);
      let title = slug;
      let updatedAt: string | undefined;
      try {
        const head = fs.readFileSync(file, "utf8").slice(0, 800);
        const t = head.match(/^title:\s*(.+)$/m);
        if (t) title = t[1]!.trim().replace(/^"|"$/g, "");
        const u = head.match(/^updatedAt:\s*(.+)$/m);
        if (u) updatedAt = u[1]!.trim().replace(/^"|"$/g, "");
      } catch {
        /* ignore */
      }
      out.push({ section, slug, title, updatedAt, path: `${section}/${slug}` });
    }
  }
  return out;
}

/** Read one page's raw markdown (incl. frontmatter). */
export function readPage(userHome: string, section: string, slug: string): string | null {
  const file = resolvePage(userHome, section, slug);
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Naive full-text search across all pages. Returns matching pages with
 *  a short snippet around the first hit. */
export function searchPages(
  userHome: string,
  query: string,
  limit = 20,
): Array<ListedPage & { snippet: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<ListedPage & { snippet: string; score: number }> = [];
  for (const p of listPages(userHome)) {
    const file = resolvePage(userHome, p.section, p.slug);
    if (!file) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    const titleHit = p.title.toLowerCase().includes(q);
    if (idx < 0 && !titleHit) continue;
    const at = idx < 0 ? 0 : idx;
    const snippet = text
      .slice(Math.max(0, at - 60), at + 140)
      .replace(/\s+/g, " ")
      .trim();
    hits.push({ ...p, snippet, score: titleHit ? 0 : 1 });
  }
  hits.sort((a, b) => a.score - b.score);
  return hits.slice(0, limit).map(({ score: _score, ...rest }) => rest);
}

// ─── ingest cursor (bookkeeping) ────────────────────────────────

function cursorFile(userHome: string): string {
  return path.join(wikiRoot(userHome), ".wiki", "cursor.json");
}

export interface IngestCursor {
  /** session ids already filed as sources (dedupe). */
  ingestedSessionIds: string[];
  updatedAt: string;
}

export function readCursor(userHome: string): IngestCursor {
  try {
    const raw = fs.readFileSync(cursorFile(userHome), "utf8");
    const c = JSON.parse(raw) as Partial<IngestCursor>;
    return {
      ingestedSessionIds: Array.isArray(c.ingestedSessionIds) ? c.ingestedSessionIds : [],
      updatedAt: typeof c.updatedAt === "string" ? c.updatedAt : "",
    };
  } catch {
    return { ingestedSessionIds: [], updatedAt: "" };
  }
}

export function markIngested(userHome: string, sessionId: string): void {
  const c = readCursor(userHome);
  if (c.ingestedSessionIds.includes(sessionId)) return;
  c.ingestedSessionIds.push(sessionId);
  // Keep the list bounded — the last few hundred ids are plenty for
  // dedupe (older segments are already filed and won't re-ingest).
  if (c.ingestedSessionIds.length > 500) {
    c.ingestedSessionIds = c.ingestedSessionIds.slice(-500);
  }
  c.updatedAt = new Date().toISOString();
  const file = cursorFile(userHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function alreadyIngested(userHome: string, sessionId: string): boolean {
  return readCursor(userHome).ingestedSessionIds.includes(sessionId);
}
