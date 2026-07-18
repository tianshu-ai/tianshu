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
// Flat synthesis sections + the time-journal levels. The journal lives
// under wiki/journal/<level>/<period>.md; we treat "journal/<level>"
// as a section string so the same path-safe read/write/list plumbing
// serves both.
export const FLAT_SECTIONS = ["sources", "entities", "concepts", "topics"] as const;
export const JOURNAL_LEVELS = ["daily", "weekly", "monthly", "yearly"] as const;
export const SECTIONS = [
  ...FLAT_SECTIONS,
  ...JOURNAL_LEVELS.map((l) => `journal/${l}` as const),
] as const;
export type Section = (typeof SECTIONS)[number];
export type JournalLevel = (typeof JOURNAL_LEVELS)[number];

// ─── period keys + ISO week helpers ─────────────────────────────

/** Validate a period key for a journal level:
 *    daily   YYYY-MM-DD
 *    weekly  YYYY-Www   (ISO week)
 *    monthly YYYY-MM
 *    yearly  YYYY
 */
export function isValidPeriod(level: JournalLevel, period: string): boolean {
  switch (level) {
    case "daily":
      return /^\d{4}-\d{2}-\d{2}$/.test(period);
    case "weekly":
      return /^\d{4}-W\d{2}$/.test(period);
    case "monthly":
      return /^\d{4}-\d{2}$/.test(period);
    case "yearly":
      return /^\d{4}$/.test(period);
  }
}

/** ISO-8601 week number + week-year for a date (week starts Monday;
 *  week 1 is the week containing the first Thursday). */
export function isoWeek(d: Date): { year: number; week: number } {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // shift to Thursday
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: date.getUTCFullYear(), week };
}

/** Monday(start)..Sunday(end) date range for an ISO week key, as
 *  YYYY-MM-DD strings. Used to label weekly journals with the real
 *  dates they cover. */
export function isoWeekRange(weekKey: string): { start: string; end: string } | null {
  const m = weekKey.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Jan 4 is always in ISO week 1; find that week's Monday, then add.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const mon = new Date(week1Mon);
  mon.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const sun = new Date(mon);
  sun.setUTCDate(mon.getUTCDate() + 6);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return { start: fmt(mon), end: fmt(sun) };
}

/** Period key for a date at a given level. */
export function periodFor(level: JournalLevel, d: Date): string {
  const iso = d.toISOString();
  switch (level) {
    case "daily":
      return iso.slice(0, 10);
    case "weekly": {
      const { year, week } = isoWeek(d);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "monthly":
      return iso.slice(0, 7);
    case "yearly":
      return iso.slice(0, 4);
  }
}

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

/** A short body excerpt for a page (frontmatter + heading stripped),
 *  for search results — so the agent can judge relevance without a
 *  second read. Returns "" when the page is missing/empty. */
export function pageSnippet(userHome: string, pagePath: string, max = 200): string {
  const parts = pagePath.split("/");
  const slug = parts[parts.length - 1] ?? "";
  const section = parts.slice(0, -1).join("/");
  const md = readPage(userHome, section, slug);
  if (!md) return "";
  // strip frontmatter
  let body = md;
  if (body.startsWith("---")) {
    const end = body.indexOf("\n---", 3);
    if (end >= 0) {
      const after = body.indexOf("\n", end + 1);
      body = after >= 0 ? body.slice(after + 1) : "";
    }
  }
  // drop leading markdown heading + blockquote markers, collapse ws
  body = body
    .replace(/^#.*$/m, "")
    .replace(/^>.*$/gm, "")
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return body.length > max ? body.slice(0, max) + "…" : body;
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

// ─── link graph ─────────────────────────────────────────

export interface GraphNode {
  path: string;
  section: string;
  title: string;
}
export interface GraphEdge {
  from: string;
  to: string;
}
export interface WikiGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Match [[section/slug]] or [[section/slug|label]] wikilinks.
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

/** Normalise a link target: strip leading slash, .md, whitespace. */
function normLink(s: string): string {
  return s.trim().replace(/^\//, "").replace(/\.md$/, "");
}

/** Extract outbound link targets from a page's raw markdown: the
 *  frontmatter `links:` list + inline [[wikilinks]]. De-duped. */
export function extractLinks(markdown: string): string[] {
  const out = new Set<string>();
  const fmEnd = markdown.startsWith("---") ? markdown.indexOf("\n---", 3) : -1;
  if (fmEnd >= 0) {
    const fm = markdown.slice(0, fmEnd);
    const m = fm.match(/\nlinks:\n((?:\s*-\s*.+\n?)+)/);
    if (m) {
      for (const line of m[1]!.split("\n")) {
        const v = line.replace(/^\s*-\s*/, "").trim().replace(/^"|"$/g, "");
        if (v) out.add(normLink(v));
      }
    }
  }
  let mm: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((mm = WIKILINK_RE.exec(markdown)) !== null) {
    const t = mm[1]!.trim();
    if (t) out.add(normLink(t));
  }
  return [...out];
}

/** Whole-vault link graph: every page a node, every resolvable
 *  outbound link an edge (edges to missing pages dropped). */
export function buildGraph(userHome: string): WikiGraph {
  const pages = listPages(userHome);
  const known = new Set(pages.map((p) => p.path));
  const nodes: GraphNode[] = pages.map((p) => ({
    path: p.path,
    section: p.section,
    title: p.title,
  }));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    const file = resolvePage(userHome, p.section, p.slug);
    if (!file) continue;
    let md: string;
    try {
      md = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const target of extractLinks(md)) {
      if (!known.has(target) || target === p.path) continue;
      const key = `${p.path}\u0000${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: p.path, to: target });
    }
  }
  return { nodes, edges };
}

// ─── reset ───────────────────────────────────────────

export interface ResetResult {
  ok: boolean;
  removedPages: number;
  reason?: string;
}

/** Wipe the whole wiki vault for a user: every page across all
 *  sections AND the ingest cursor, so the next run rebuilds from
 *  scratch. Destructive + intentional (a strategy change means old
 *  pages are stale). Confined to `<userHome>/wiki` — never touches
 *  anything above it. */
export function resetVault(userHome: string): ResetResult {
  const root = wikiRoot(userHome);
  // Count pages before removal for the confirmation message.
  let removed = 0;
  try {
    removed = listPages(userHome).length;
  } catch {
    /* ignore */
  }
  // Defense in depth: only ever rm the resolved wiki dir.
  const resolvedRoot = path.resolve(root);
  if (!resolvedRoot.endsWith(`${path.sep}${WIKI_DIR}`)) {
    return { ok: false, removedPages: 0, reason: "refusing to reset a non-wiki path" };
  }
  try {
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      removedPages: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, removedPages: removed };
}
