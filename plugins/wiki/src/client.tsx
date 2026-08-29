// Wiki plugin — side panel.
//
// Browse the user's LLM Wiki: a searchable list of pages grouped by
// section (sources / entities / concepts / topics) with a Markdown
// reader for the selected page. Data comes from the plugin routes
// GET /api/p/wiki/{list,read,search}. Refreshes on workspace changes.

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { Notebook, Search, RefreshCw, FileText, Trash2, List, Share2, Boxes, ChevronLeft, ChevronDown, Sparkles, Clock, Calendar } from "lucide-react";

// react-force-graph-2d pulls in the whole d3-force / canvas stack, so
// load it lazily — it only ships in a separate chunk fetched when the
// user actually opens the graph view.
const ForceGraph2D = lazy(() => import("react-force-graph-2d"));
import type {
  PanelProps,
  PluginClientExports,
  ComposerActionProps,
} from "@tianshu-ai/plugin-sdk/client";
import { useUiPrimitives, subscribeToWsEvent, useChatNav, usePluginT } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/wiki";

/** Maps a wiki section id to its short translation key. Rendered
 *  labels resolve through `t(SECTION_LABEL_KEY[section])`; the
 *  English SECTION_LABEL below stays as a fallback for unknown ids. */
const SECTION_LABEL_KEY: Record<string, string> = {
  knowledge: "section.knowledge",
  "journal/daily": "section.daily",
  "journal/weekly": "section.weekly",
  "journal/monthly": "section.monthly",
  "journal/yearly": "section.yearly",
  topics: "section.topics",
  entities: "section.entities",
  concepts: "section.concepts",
  sources: "section.sources",
};

interface WikiPage {
  section: string;
  slug: string;
  title: string;
  updatedAt?: string;
  path: string;
}

const SECTION_ORDER = [
  "knowledge",
  "journal/daily",
  "journal/weekly",
  "journal/monthly",
  "journal/yearly",
  "topics",
  "entities",
  "concepts",
  "sources",
];
const SECTION_LABEL: Record<string, string> = {
  knowledge: "Knowledge",
  "journal/daily": "Daily",
  "journal/weekly": "Weekly",
  "journal/monthly": "Monthly",
  "journal/yearly": "Yearly",
  topics: "Topics",
  entities: "Entities",
  concepts: "Concepts",
  sources: "Sources",
};
/** Sections with many entries show this many initially; click "Show more" to expand. */
const SECTION_PREVIEW_COUNT = 5;
/** Journal sections that grow unbounded — default collapsed when > PREVIEW. */
const JOURNAL_SECTIONS = new Set(["journal/daily", "journal/weekly", "journal/monthly", "journal/yearly"]);

const SECTION_EMOJI: Record<string, string> = {
  knowledge: "📖",
  "journal/daily": "📅",
  "journal/weekly": "📆",
  "journal/monthly": "🗓️",
  "journal/yearly": "🗓️",
  topics: "📰",
  entities: "👤",
  concepts: "💡",
  sources: "📚",
};

/** Format an ISO date string as a short relative/absolute label. */
function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function WikiPanel(_props: PanelProps) {
  const { MarkdownBlock, Modal } = useUiPrimitives();
  const t = usePluginT("wiki");
  const [tab, setTab] = useState<"browse" | "indexing">("browse");
  const [sourceFilter, setSourceFilter] = useState<"all" | "kb" | "session">("all");
  const [pages, setPages] = useState<WikiPage[]>([]);
  // Date range for session view
  type RangePreset = "7d" | "1m" | "3m" | "all" | "custom";
  const [rangePreset, setRangePreset] = useState<RangePreset>("1m");
  const [customFrom, setCustomFrom] = useState<string>("");
  const [customTo, setCustomTo] = useState<string>("");

  // Compute effective date range [from, to] as YYYY-MM-DD strings
  const dateRange = useMemo(() => {
    const now = new Date();
    const toStr = (d: Date) => d.toISOString().slice(0, 10);
    const to = toStr(now);
    if (rangePreset === "custom" && customFrom) {
      return { from: customFrom, to: customTo || to };
    }
    if (rangePreset === "all") return { from: "2000-01-01", to };
    const daysMap: Record<string, number> = { "7d": 7, "1m": 30, "3m": 90 };
    const days = daysMap[rangePreset] ?? 30;
    const from = new Date(now.getTime() - days * 86400000);
    return { from: toStr(from), to };
  }, [rangePreset, customFrom, customTo]);
  const [selected, setSelected] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [pageTitle, setPageTitle] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);
  // Section collapse/expand state; journal sections default collapsed
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  // Per-section "show more" limit (starts at SECTION_PREVIEW_COUNT)
  const [sectionLimits, setSectionLimits] = useState<Record<string, number>>({});
  // Semantic search
  const [searchMode, setSearchMode] = useState<"filter" | "semantic">("filter");
  const [searchResults, setSearchResults] = useState<Array<{ path: string; title: string; score?: number }> | null>(null);
  const [searching, setSearching] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const rebuildIndex = useCallback(() => {
    setReindexing(true);
    setReindexMsg(null);
    fetch(`${API_BASE}/reindex`, { method: "POST", credentials: "include" })
      .then(async (r) => {
        const body = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          indexed?: number;
          total?: number;
          note?: string;
          error?: string;
        };
        if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
        setReindexMsg(
          body.note
            ? body.note
            : t("reindex.done", { indexed: body.indexed ?? 0, total: body.total ?? 0 }),
        );
      })
      .catch((e: unknown) =>
        setReindexMsg(
          t("reindex.failed", { error: e instanceof Error ? e.message : String(e) }),
        ),
      )
      .finally(() => {
        setReindexing(false);
        setTimeout(() => setReindexMsg(null), 6000);
      });
  }, [t]);

  const runSemanticSearch = useCallback((q: string) => {
    if (!q.trim()) { setSearchResults(null); return; }
    setSearching(true);
    fetch(`${API_BASE}/semantic-search?q=${encodeURIComponent(q)}&limit=10`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((res: { hits: Array<{ path: string; title: string; score?: number }>; mode?: string }) => {
        setSearchResults(res.hits ?? []);
      })
      .catch(() => setSearchResults([]))
      .finally(() => setSearching(false));
  }, []);

  const fetchList = useCallback(() => {
    fetch(`${API_BASE}/list`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { pages: WikiPage[] }) => setPages(res.pages ?? []))
      .catch(() => setPages([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchList();
    return subscribeToWsEvent<{ type: string; event?: string }>("plugin_event", (ev) => {
      if (ev.event && /wiki|workspace/i.test(ev.event)) fetchList();
    });
  }, [fetchList]);

  const openPage = useCallback((p: string) => {
    setView("list");
    setSelected(p);
    // Last segment is the slug; everything before is the section, so a
    // journal path "journal/daily/2026-07-18" resolves to
    // section="journal/daily", slug="2026-07-18" (not section="journal").
    const parts = p.split("/");
    const slug = parts[parts.length - 1] ?? "";
    const section = parts.slice(0, -1).join("/");
    fetch(
      `${API_BASE}/read?section=${encodeURIComponent(section)}&slug=${encodeURIComponent(slug)}`,
      { credentials: "include" },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((res: { markdown: string }) => {
        const raw = res.markdown ?? "";
        setPageTitle(frontmatterTitle(raw));
        setMarkdown(stripFrontmatter(raw));
      })
      .catch(() => setMarkdown(t("page.loadFailed")));
  }, [t]);

  /** Extract a comparable YYYY-MM-DD date string from a page (slug or updatedAt). */
  const pageDate = useCallback((p: WikiPage): string | null => {
    // Daily: "2026-08-29" → exact
    const dm = p.slug.match(/^(\d{4}-\d{2}-\d{2})/);
    if (dm) return dm[1]!;
    // Weekly: "2026-W35" → approximate to Monday of that ISO week
    const wm = p.slug.match(/^(\d{4})-W(\d+)/);
    if (wm) {
      const jan4 = new Date(Number(wm[1]), 0, 4);
      const d = new Date(jan4.getTime() + (Number(wm[2]) - 1) * 7 * 86400000);
      return d.toISOString().slice(0, 10);
    }
    // Monthly: "2026-08" → first of month
    const mm = p.slug.match(/^(\d{4}-\d{2})$/);
    if (mm) return `${mm[1]}-01`;
    // Yearly: "2026" → Jan 1
    const ym = p.slug.match(/^(\d{4})$/);
    if (ym) return `${ym[1]}-01-01`;
    // Non-journal: use updatedAt
    const um = p.updatedAt?.match(/^(\d{4}-\d{2}-\d{2})/);
    if (um) return um[1]!;
    return null;
  }, []);

  const grouped = useMemo(() => {
    const q = searchMode === "filter" ? filter.trim().toLowerCase() : "";
    let shown = q
      ? pages.filter((p) => p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : pages;
    // Apply source filter
    if (sourceFilter === "kb") {
      shown = shown.filter((p) => p.section === "knowledge");
    } else if (sourceFilter === "session") {
      shown = shown.filter((p) => {
        if (p.section === "knowledge") return false;
        const d = pageDate(p);
        if (!d) return true; // can't determine date, show anyway
        return d >= dateRange.from && d <= dateRange.to;
      });
    }
    const by: Record<string, WikiPage[]> = {};
    for (const p of shown) (by[p.section] ??= []).push(p);
    for (const k of Object.keys(by)) by[k]!.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return by;
  }, [pages, filter, sourceFilter, searchMode, dateRange, pageDate]);

  // Recently updated pages (top 5, across all sections)
  const recentPages = useMemo(() => {
    if (filter.trim() || searchMode === "semantic") return []; // hide when searching
    return [...pages]
      .filter((p) => p.updatedAt)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 5);
  }, [pages, filter, searchMode]);

  return (
    <div className="flex h-full flex-col overflow-hidden text-fg-default">
      {/* Tab bar */}
      <div className="flex flex-shrink-0 border-b border-border-subtle">
        <button
          onClick={() => setTab("browse")}
          className={"flex-1 px-3 py-1.5 text-xs font-medium transition-colors " + (tab === "browse" ? "text-brand-400 border-b-2 border-brand-400" : "text-fg-muted hover:text-fg-default")}
        >
          {t("tab.browse")}
        </button>
        <button
          onClick={() => setTab("indexing")}
          className={"flex-1 px-3 py-1.5 text-xs font-medium transition-colors " + (tab === "indexing" ? "text-brand-400 border-b-2 border-brand-400" : "text-fg-muted hover:text-fg-default")}
        >
          {t("tab.indexing")}
        </button>
      </div>

      {tab === "indexing" ? (
        <IndexingTab />
      ) : (<>
      {/* Search bar — full width, clean */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <div className="relative flex-1">
          {searchMode === "semantic" ? (
            <Sparkles size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-brand-400" />
          ) : (
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint" />
          )}
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              if (searchMode === "semantic") {
                // Debounce semantic search
                if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                const q = e.target.value;
                if (!q.trim()) { setSearchResults(null); return; }
                searchTimerRef.current = setTimeout(() => runSemanticSearch(q), 400);
              } else {
                setSearchResults(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchMode === "semantic" && filter.trim()) {
                if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                runSemanticSearch(filter);
              }
            }}
            placeholder={searchMode === "semantic" ? (t("panel.semanticPlaceholder") || "Semantic search…") : t("panel.filterPlaceholder")}
            className="w-full rounded-md bg-bg-raised pl-7 pr-2 py-1.5 text-xs text-fg-muted placeholder:text-fg-fainter focus:outline-none focus:ring-1 focus:ring-brand-400/40"
          />
        </div>
        <button
          onClick={() => {
            const next = searchMode === "filter" ? "semantic" : "filter";
            setSearchMode(next);
            setSearchResults(null);
            if (next === "semantic" && filter.trim()) runSemanticSearch(filter);
          }}
          title={searchMode === "semantic" ? "Switch to filter" : "Switch to semantic search"}
          className={
            "rounded-md p-1.5 transition-colors " +
            (searchMode === "semantic"
              ? "text-brand-400 bg-brand-500/10"
              : "text-fg-faint hover:text-fg-default hover:bg-bg-hover")
          }
        >
          <Sparkles size={14} />
        </button>
        <button
          onClick={() => setView(view === "graph" ? "list" : "graph")}
          title={view === "graph" ? t("panel.listView") : t("panel.graphView")}
          className={
            "rounded-md p-1.5 transition-colors " +
            (view === "graph"
              ? "text-brand-400 bg-brand-500/10"
              : "text-fg-faint hover:text-fg-default hover:bg-bg-hover")
          }
        >
          {view === "graph" ? <List size={14} /> : <Share2 size={14} />}
        </button>

      </div>
      {/* Source filter + stats */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border-subtle px-3 py-1">
        {(["all", "kb", "session"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setSourceFilter(f)}
            className={"rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-colors " + (sourceFilter === f ? "bg-brand-500/15 text-brand-400" : "text-fg-muted hover:bg-bg-hover")}
          >
            {f === "all" ? t("filter.all") : f === "kb" ? t("filter.kb") : t("filter.session")}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-fg-fainter">
          {pages.length} {pages.length === 1 ? "page" : "pages"}
        </span>
        <button
          onClick={() => setConfirmReset(true)}
          title={t("panel.resetTitle")}
          className="ml-1 rounded p-1 text-fg-fainter hover:text-danger hover:bg-bg-hover transition-colors"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {/* Date range selector (session view only) */}
      {sourceFilter === "session" && (
        <div className="flex flex-shrink-0 flex-col gap-1.5 border-b border-border-subtle px-3 py-2">
          {/* Preset buttons */}
          <div className="flex items-center gap-1">
            <Calendar size={12} className="shrink-0 text-fg-fainter" />
            {(["7d", "1m", "3m", "all"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setRangePreset(p)}
                className={"rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors " +
                  (rangePreset === p
                    ? "bg-brand-500/15 text-brand-400"
                    : "text-fg-muted hover:bg-bg-hover")}
              >
                {p === "7d" ? "7 天" : p === "1m" ? "1 个月" : p === "3m" ? "3 个月" : "全部"}
              </button>
            ))}
            <button
              onClick={() => {
                setRangePreset("custom");
                if (!customFrom) {
                  const d = new Date();
                  d.setDate(d.getDate() - 30);
                  setCustomFrom(d.toISOString().slice(0, 10));
                  setCustomTo(new Date().toISOString().slice(0, 10));
                }
              }}
              className={"rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors " +
                (rangePreset === "custom"
                  ? "bg-brand-500/15 text-brand-400"
                  : "text-fg-muted hover:bg-bg-hover")}
            >
              自定义
            </button>
          </div>
          {/* Custom date inputs */}
          {rangePreset === "custom" && (
            <div className="flex items-center gap-1.5">
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="flex-1 rounded-md bg-bg-raised px-2 py-1 text-[11px] text-fg-muted focus:outline-none focus:ring-1 focus:ring-brand-400/40"
              />
              <span className="text-[10px] text-fg-fainter">–</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                className="flex-1 rounded-md bg-bg-raised px-2 py-1 text-[11px] text-fg-muted focus:outline-none focus:ring-1 focus:ring-brand-400/40"
              />
            </div>
          )}
          {/* Range summary */}
          <div className="text-[10px] text-fg-fainter">
            {rangePreset === "all" ? "显示全部记录" : `${dateRange.from} – ${dateRange.to}`}
          </div>
        </div>
      )}
      {reindexMsg && (
        <div className="flex-shrink-0 border-b border-border-subtle bg-bg-raised px-3 py-1 text-[11px] text-fg-muted">
          {reindexMsg}
        </div>
      )}

      <Modal
        isOpen={confirmReset}
        onClose={() => !resetting && setConfirmReset(false)}
        title={t("reset.title")}
        size="sm"
        allowMaximize={false}
      >
        <div className="px-4 py-3 text-[13px] text-fg-muted">
          <p>
            {t("reset.body1a")}<strong>{t("reset.body1b")}</strong>{t("reset.body1c")}
          </p>
          <p className="mt-2">
            {t("reset.body2a")}
            <strong className="text-danger">{t("reset.body2b")}</strong>
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover transition-colors"
            >
              {t("reset.cancel")}
            </button>
            <button
              onClick={() => {
                setResetting(true);
                fetch(`${API_BASE}/reset`, { method: "POST", credentials: "include" })
                  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
                  .then(() => {
                    setSelected(null);
                    setMarkdown("");
                    setPageTitle("");
                    setConfirmReset(false);
                    fetchList();
                  })
                  .catch(() =>
                    setMarkdown(t("reset.failed")),
                  )
                  .finally(() => setResetting(false));
              }}
              disabled={resetting}
              className="rounded-md bg-danger/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-danger transition-colors disabled:opacity-60"
            >
              {resetting ? t("reset.resetting") : t("reset.wipeRebuild")}
            </button>
          </div>
        </div>
      </Modal>

      {view === "graph" ? (
        <WikiGraphView
          onOpen={openPage}
          selected={selected}
          reloadKey={pages.length}
        />
      ) : selected ? (
        /* ─── Reader (full-width, with back nav) ─── */
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Back bar */}
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle px-2 py-1.5">
            <button
              onClick={() => { setSelected(null); setMarkdown(""); setPageTitle(""); }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg-default transition-colors"
            >
              <ChevronLeft size={14} />
              <span>{t("reader.backToList") || "Back"}</span>
            </button>
            {pageTitle && (
              <span className="truncate text-[12px] font-medium text-fg-default">{pageTitle}</span>
            )}
          </div>
          {/* Content */}
          <div
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest("a");
              const href = a?.getAttribute("href") ?? "";
              if (href.startsWith("#wiki:")) {
                e.preventDefault();
                openPage(href.slice("#wiki:".length));
              }
            }}
          >
            <div className="prose prose-sm prose-invert max-w-none text-[13px] [&_a]:text-link [&_a]:no-underline hover:[&_a]:underline">
              {pageTitle && <h1 className="mb-3 text-lg font-semibold text-fg-default">{pageTitle}</h1>}
              <MarkdownBlock>{renderWikilinks(markdown)}</MarkdownBlock>
            </div>
          </div>
        </div>
      ) : (
        /* ─── Page list (full-width) ─── */
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {/* Semantic search results */}
          {searchMode === "semantic" && searchResults !== null && (
            <div className="mb-2">
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-fg-muted">
                <Sparkles size={12} className="text-brand-400" />
                <span>{searching ? "Searching…" : `${searchResults.length} result${searchResults.length !== 1 ? "s" : ""}`}</span>
              </div>
              {searchResults.map((h) => (
                <button
                  key={h.path}
                  onClick={() => openPage(h.path)}
                  className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-hover"
                >
                  <FileText size={14} className="shrink-0 text-fg-fainter group-hover:text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] leading-snug text-fg-muted group-hover:text-fg-default">
                      {h.title}
                    </div>
                    {h.score != null && (
                      <div className="text-[10px] text-fg-fainter">
                        relevance {Math.round(h.score * 100)}%
                      </div>
                    )}
                  </div>
                  <ChevronLeft size={12} className="shrink-0 rotate-180 text-fg-fainter opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
              {searchResults.length === 0 && !searching && (
                <div className="px-3 py-4 text-center text-[11px] text-fg-fainter">No results</div>
              )}
            </div>
          )}
          {/* Recently updated (only when not searching) */}
          {recentPages.length > 0 && searchResults === null && sourceFilter === "all" && (
            <div className="mb-1">
              <div className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-fg-muted">
                <Clock size={12} />
                <span>Recently Updated</span>
              </div>
              {recentPages.map((p) => (
                <button
                  key={`recent-${p.path}`}
                  onClick={() => openPage(p.path)}
                  className="group flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-left transition-colors hover:bg-bg-hover"
                >
                  <FileText size={14} className="shrink-0 text-fg-fainter group-hover:text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] leading-snug text-fg-muted group-hover:text-fg-default">{p.title}</div>
                    <div className="text-[10px] text-fg-fainter">{p.updatedAt ? formatRelativeDate(p.updatedAt) : ""}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {/* Section groups (hide when showing semantic results) */}
          {(searchResults === null || searchMode === "filter") && SECTION_ORDER.filter((s) => (grouped[s]?.length ?? 0) > 0).map((s) => {
            const items = grouped[s]!;
            const isCollapsed = collapsedSections[s] ?? false;
            const limit = sectionLimits[s] ?? SECTION_PREVIEW_COUNT;
            const visibleItems = isCollapsed ? [] : items.slice(0, limit);
            const hiddenCount = isCollapsed ? items.length : Math.max(0, items.length - limit);
            return (
            <div key={s} className="mb-1">
              <button
                onClick={() => setCollapsedSections((prev) => ({ ...prev, [s]: !isCollapsed }))}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-fg-muted hover:text-fg-default transition-colors"
              >
                <ChevronDown size={12} className={"shrink-0 transition-transform " + (isCollapsed ? "-rotate-90" : "")} />
                <span>{SECTION_EMOJI[s] ?? "\ud83d\udcc4"}</span>
                <span>
                  {SECTION_LABEL_KEY[s] ? t(SECTION_LABEL_KEY[s]) : SECTION_LABEL[s] ?? s}
                </span>
                <span className="ml-auto rounded-full bg-bg-raised px-1.5 py-0.5 text-[9px] font-normal text-fg-fainter">
                  {items.length}
                </span>
              </button>
              {visibleItems.map((p) => (
                <button
                  key={p.path}
                  onClick={() => openPage(p.path)}
                  className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-hover"
                >
                  <FileText size={14} className="shrink-0 text-fg-fainter group-hover:text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] leading-snug text-fg-muted group-hover:text-fg-default">
                      {p.title}
                    </div>
                    {p.updatedAt && (
                      <div className="text-[10px] text-fg-fainter">
                        {formatRelativeDate(p.updatedAt)}
                      </div>
                    )}
                  </div>
                  <ChevronLeft size={12} className="shrink-0 rotate-180 text-fg-fainter opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ))}
              {!isCollapsed && hiddenCount > 0 && (
                <button
                  onClick={() => setSectionLimits((prev) => ({ ...prev, [s]: limit + 20 }))}
                  className="flex w-full items-center justify-center gap-1 rounded-md px-3 py-1.5 text-[11px] text-fg-muted hover:bg-bg-hover hover:text-fg-default transition-colors"
                >
                  Show {hiddenCount} more
                </button>
              )}
            </div>
            );
          })}
          {!loading && pages.length === 0 && (
            <div className="px-3 py-8 text-center text-[11px] text-fg-fainter">
              {t("list.empty")}
            </div>
          )}
        </div>
      )}
      </>)}
    </div>
  );
}

/** Rewrite [[section/slug]] and [[section/slug|label]] into markdown
 *  links with a #wiki: scheme the reader intercepts for in-panel
 *  navigation. Leaves normal markdown untouched. */
function renderWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_all, target: string, label?: string) => {
    const path = target.trim().replace(/^\//, "").replace(/\.md$/, "");
    const text = (label ?? path.split("/").pop() ?? path).trim();
    return `[${text}](#wiki:${path})`;
  });
}

/** Pull the `title:` out of leading YAML frontmatter (for the reader
 *  header, since we render the body without it). */
function frontmatterTitle(md: string): string {
  if (!md.startsWith("---")) return "";
  const end = md.indexOf("\n---", 3);
  if (end < 0) return "";
  const fm = md.slice(3, end);
  const m = fm.match(/^title:\s*(.+)$/m);
  return m ? m[1]!.trim().replace(/^"|"$/g, "") : "";
}

/** Drop leading YAML frontmatter for display (keep it in storage). */
function stripFrontmatter(md: string): string {
  if (md.startsWith("---")) {
    const end = md.indexOf("\n---", 3);
    if (end >= 0) {
      const after = md.indexOf("\n", end + 1);
      return after >= 0 ? md.slice(after + 1) : "";
    }
  }
  return md;
}

// ─── Knowledge Base tab ───────────────────────────────────────────

interface KbStatus {
  folders: { path: string; label?: string; fileCount: number }[];
  totalFiles: number;
  indexedFiles: number;
  pendingFiles: number;
  lastScanAt: number | null;
}

interface EmbeddingStatus {
  enabled: boolean;
  model: string | null;
  indexed: number;
  totalPages: number;
}

function IndexingTab() {
  const t = usePluginT("wiki");
  const [kbStatus, setKbStatus] = useState<KbStatus | null>(null);
  const [sessionStatus, setSessionStatus] = useState<{ running: boolean; progress: number; indexedDays: number; totalDays: number; pendingDays: number } | null>(null);
  const [embStatus, setEmbStatus] = useState<EmbeddingStatus | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMsg, setReindexMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const nav = useChatNav();

  const fetchStatus = useCallback(() => {
    Promise.all([
      fetch(`${API_BASE}/kb/status`, { credentials: "include" }).then((r) => r.json()).catch(() => null),
      fetch(`${API_BASE}/status`, { credentials: "include" }).then((r) => r.json()).catch(() => null),
      fetch(`${API_BASE}/embedding-status`, { credentials: "include" }).then((r) => r.json()).catch(() => null),
    ]).then(([kb, wiki, emb]: [KbStatus | null, { running?: boolean; progress?: number; indexedDays?: number; totalDays?: number; pendingDays?: number } | null, EmbeddingStatus | null]) => {
      setKbStatus(kb);
      setSessionStatus(wiki ? { running: !!wiki.running, progress: wiki.progress ?? 0, indexedDays: wiki.indexedDays ?? 0, totalDays: wiki.totalDays ?? 0, pendingDays: wiki.pendingDays ?? 0 } : null);
      setEmbStatus(emb);
      const isRunning = !!wiki?.running || false;
      setRunning(isRunning);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, running ? 2000 : 8000);
    return () => clearInterval(id);
  }, [fetchStatus, running]);

  const triggerUpdate = () => {
    setRunning(true);
    // Fire session record + KB scan only; embedding reindex is manual via its own button
    Promise.all([
      fetch(`${API_BASE}/record`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: nav.viewingSessionId ?? null }),
      }).catch(() => null),
      fetch(`${API_BASE}/kb/scan`, { method: "POST", credentials: "include" }).catch(() => null),
    ]).then(() => {
      setTimeout(fetchStatus, 1500);
    });
  };

  const isIdle = !running && !sessionStatus?.running;
  const hasPendingKb = (kbStatus?.pendingFiles ?? 0) > 0;
  const hasWork = hasPendingKb || isIdle; // always allow session record

  // Compute overall progress percentage for the header ring
  const sessionPct = sessionStatus ? Math.round(sessionStatus.progress * 100) : 0;
  const embPct = embStatus?.enabled && embStatus.totalPages > 0
    ? Math.round((embStatus.indexed / embStatus.totalPages) * 100) : 0;

  return (
    <div className="flex h-full flex-col overflow-y-auto px-3 py-4 text-xs">
      {/* ── Header: overall status + update button ── */}
      <div className="flex items-center gap-3 mb-5">
        {/* Circular progress ring */}
        <div className="relative shrink-0 w-11 h-11">
          <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3" className="stroke-bg-raised" />
            <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3"
              className={running ? "stroke-brand-400" : "stroke-green-500"}
              strokeDasharray={`${sessionPct * 0.94} 94`}
              strokeLinecap="round"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-fg-default">
            {sessionPct}%
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg-default">索引状态</div>
          <div className="text-[11px] text-fg-muted mt-0.5">
            {running ? "正在更新…" : sessionStatus?.totalDays
              ? `${sessionStatus.indexedDays}/${sessionStatus.totalDays} 天已录入`
              : "尚无对话记录"}
          </div>
        </div>
        <button
          onClick={triggerUpdate}
          disabled={running || !isIdle}
          className={
            "shrink-0 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-all border " +
            (running
              ? "border-brand-500/30 bg-brand-500/5 text-brand-400 cursor-wait"
              : "border-border-subtle text-fg-muted hover:text-fg-default hover:bg-bg-hover")
          }
        >
          {running ? (
            <span className="flex items-center gap-1.5">
              <RefreshCw size={13} className="animate-spin" />
              更新中
            </span>
          ) : (
            <span className="flex items-center gap-1.5">
              <RefreshCw size={13} />
              更新 Wiki
            </span>
          )}
        </button>
      </div>

      {/* ── Cards ── */}
      <div className="space-y-3">

        {/* ① Session records */}
        <div className="rounded-xl bg-bg-raised/50 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-brand-500/10">
              <Notebook size={14} className="text-brand-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-fg-default">{t("indexing.sessions")}</div>
            </div>
            <span className={"text-[10px] px-2 py-0.5 rounded-full font-medium " +
              (sessionStatus?.running
                ? "bg-brand-500/10 text-brand-400"
                : sessionStatus && sessionStatus.pendingDays > 0
                  ? "bg-amber-500/10 text-amber-500"
                  : "bg-green-500/10 text-green-500")}>
              {sessionStatus?.running ? "录入中" : sessionStatus && sessionStatus.pendingDays > 0 ? `${sessionStatus.pendingDays} 天待录` : "已完成"}
            </span>
          </div>
          {sessionStatus && sessionStatus.totalDays > 0 && (<>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-green-500 font-medium">{sessionStatus.indexedDays}</span>
              <span className="text-fg-fainter">/</span>
              <span className="text-fg-muted">{sessionStatus.totalDays} 天</span>
            </div>
            <div className="h-1.5 rounded-full bg-bg-default overflow-hidden">
              <div
                className={"h-full rounded-full transition-all duration-700 " + (sessionStatus.running ? "bg-brand-400" : "bg-green-500")}
                style={{ width: `${sessionPct}%` }}
              />
            </div>
          </>)}
          {sessionStatus && sessionStatus.totalDays === 0 && (
            <div className="text-[11px] text-fg-muted">{t("indexing.sessionsDesc")}</div>
          )}
        </div>

        {/* ② Knowledge base */}
        <div className="rounded-xl bg-bg-raised/50 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-brand-500/10">
              <FileText size={14} className="text-brand-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-fg-default">{t("indexing.kb")}</div>
            </div>
            <span className={"text-[10px] px-2 py-0.5 rounded-full font-medium " +
              (running && hasPendingKb
                ? "bg-brand-500/10 text-brand-400"
                : (kbStatus?.pendingFiles ?? 0) > 0
                  ? "bg-amber-500/10 text-amber-500"
                  : "bg-green-500/10 text-green-500")}>
              {running && hasPendingKb ? "扫描中" : (kbStatus?.pendingFiles ?? 0) > 0 ? `${kbStatus!.pendingFiles} 待扫` : "已完成"}
            </span>
          </div>
          {loading ? (
            <div className="text-[11px] text-fg-fainter">{t("indexing.loading")}</div>
          ) : kbStatus && kbStatus.totalFiles > 0 ? (<>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-green-500 font-medium">{kbStatus.indexedFiles}</span>
              <span className="text-fg-fainter">/</span>
              <span className="text-fg-muted">{kbStatus.totalFiles} 文件</span>
            </div>
            <div className="h-1.5 rounded-full bg-bg-default overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all duration-700"
                style={{ width: `${kbStatus.totalFiles > 0 ? Math.round((kbStatus.indexedFiles / kbStatus.totalFiles) * 100) : 0}%` }}
              />
            </div>
            {kbStatus.lastScanAt && (
              <div className="text-[10px] text-fg-fainter">上次扫描 {new Date(kbStatus.lastScanAt).toLocaleString()}</div>
            )}
          </>) : (
            <div className="text-[11px] text-fg-muted">{t("indexing.kbPlaceholder")}</div>
          )}
        </div>

        {/* ③ Semantic search / Embedding */}
        <div className="rounded-xl bg-bg-raised/50 p-3.5 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className={"flex items-center justify-center w-7 h-7 rounded-lg " +
              (embStatus?.enabled ? "bg-brand-500/10" : "bg-bg-default")}>
              <Sparkles size={14} className={embStatus?.enabled ? "text-brand-400" : "text-fg-fainter"} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-medium text-fg-default">语义搜索</div>
            </div>
            {/* Reindex action — inline in header */}
            <button
              onClick={() => {
                if (!embStatus?.enabled) return;
                setReindexing(true);
                setReindexMsg(null);
                fetch(`${API_BASE}/reindex`, { method: "POST", credentials: "include" })
                  .then((r) => r.json())
                  .then((body: { indexed?: number; total?: number; error?: string }) => {
                    setReindexMsg(body.error
                      ? `❌ ${body.error}`
                      : `✅ ${body.indexed ?? 0}/${body.total ?? 0} 已索引`);
                    fetchStatus();
                  })
                  .catch((e: unknown) => setReindexMsg(`❌ ${e instanceof Error ? e.message : String(e)}`))
                  .finally(() => setReindexing(false));
              }}
              disabled={reindexing || !embStatus?.enabled}
              className={
                "inline-flex items-center gap-1 text-[10px] transition-colors " +
                (!embStatus?.enabled
                  ? "text-fg-fainter cursor-not-allowed"
                  : reindexing
                    ? "text-brand-400 cursor-wait"
                    : "text-fg-muted hover:text-fg-default cursor-pointer")
              }
            >
              <RefreshCw size={10} className={reindexing ? "animate-spin" : ""} />
              {reindexing ? "重建中" : "重建"}
            </button>
            <span className={"text-[10px] px-2 py-0.5 rounded-full font-medium " +
              (embStatus?.enabled ? "bg-green-500/10 text-green-500" : "bg-bg-default text-fg-fainter")}>
              {embStatus?.enabled ? "已启用" : "未配置"}
            </span>
          </div>
          {embStatus?.enabled ? (<>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-green-500 font-medium">{embStatus.indexed}</span>
              <span className="text-fg-fainter">/</span>
              <span className="text-fg-muted">{embStatus.totalPages} 页面</span>
              {embStatus.indexed < embStatus.totalPages && (
                <span className="text-amber-500 ml-1">{embStatus.totalPages - embStatus.indexed} 待索引</span>
              )}
            </div>
            {embStatus.totalPages > 0 && (
              <div className="h-1.5 rounded-full bg-bg-default overflow-hidden">
                <div className="h-full bg-green-500 rounded-full transition-all duration-700" style={{ width: `${embPct}%` }} />
              </div>
            )}
            <div className="text-[10px] text-fg-fainter">{embStatus.model}</div>
          </>) : (
            <div className="text-[11px] text-fg-muted">
              在设置 → 插件 → Wiki 中配置 Embedding 模型
            </div>
          )}
          {reindexMsg && <div className="text-[10px] text-fg-muted">{reindexMsg}</div>}
        </div>
      </div>
    </div>
  );
}


// ─── graph view (react-force-graph-2d, lazy-loaded) ─────────────

interface GraphNode { path: string; section: string; title: string }
interface GraphEdge { from: string; to: string }

const SECTION_COLOR: Record<string, string> = {
  "journal/daily": "#60a5fa",
  "journal/weekly": "#3b82f6",
  "journal/monthly": "#2563eb",
  "journal/yearly": "#1d4ed8",
  topics: "#f59e0b",
  entities: "#10b981",
  concepts: "#a78bfa",
  sources: "#9ca3af",
};
function nodeColor(section: string): string {
  return SECTION_COLOR[section] ?? "#9ca3af";
}

type FGNode = GraphNode & { id: string; deg: number };
type FGLink = { source: string; target: string };
// The lib types nodes loosely (NodeObject); accessor params come in as
// that shape, so we take `any` and cast to FGNode inside.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FGNodeAny = any;

function WikiGraphView({
  onOpen,
  selected,
  reloadKey,
}: {
  onOpen: (path: string) => void;
  selected: string | null;
  reloadKey: number;
}) {
  const t = usePluginT("wiki");
  const [data, setData] = useState<{ nodes: FGNode[]; links: FGLink[] }>({ nodes: [], links: [] });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const fittedRef = useRef(false);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Clicked node awaiting confirmation (don't navigate on a stray click;
  // show a small card with an Open button first).
  const [picked, setPicked] = useState<{ path: string; title: string; section: string; sx: number; sy: number } | null>(null);

  // Adjacency: focus id -> set of neighbour ids (incl. itself). Used to
  // highlight a picked node + its neighbours + their links, dimming the
  // rest.
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      (m.get(a) ?? m.set(a, new Set([a])).get(a)!).add(b);
    };
    for (const l of data.links) {
      add(l.source, l.target);
      add(l.target, l.source);
    }
    return m;
  }, [data.links]);
  const focusSet = picked ? adjacency.get(picked.path) ?? new Set([picked.path]) : null;
  // Normalise a link endpoint (object after sim, or raw id before).
  const endId = (e: unknown): string =>
    typeof e === "string" ? e : ((e as { id?: string })?.id ?? "");

  // Loosen the layout: stronger repulsion + longer links so nodes
  // spread out (default clumps them, which is what made the graph a
  // ball of overlapping circles).
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || data.nodes.length === 0) return;
    try {
      fg.d3Force("charge")?.strength(-220);
      fg.d3Force("link")?.distance(70);
      fg.d3ReheatSimulation?.();
    } catch { /* ref API not ready */ }
    // Fallback fit in case onEngineStop already fired / never fires.
    const t = setTimeout(() => {
      if (fittedRef.current) return;
      fittedRef.current = true;
      try { fgRef.current?.zoomToFit?.(400, 60); } catch { /* ref not ready */ }
    }, 700);
    return () => clearTimeout(t);
  }, [data]);

  useEffect(() => {
    setPicked(null);
    fittedRef.current = false; // re-fit after a reload
    fetch(`${API_BASE}/graph`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((g: { nodes: GraphNode[]; edges: GraphEdge[] }) => {
        const deg: Record<string, number> = {};
        for (const e of g.edges ?? []) {
          deg[e.from] = (deg[e.from] ?? 0) + 1;
          deg[e.to] = (deg[e.to] ?? 0) + 1;
        }
        setData({
          nodes: (g.nodes ?? []).map((n) => ({ ...n, id: n.path, deg: deg[n.path] ?? 0 })),
          links: (g.edges ?? []).map((e) => ({ source: e.from, target: e.to })),
        });
      })
      .catch(() => setData({ nodes: [], links: [] }));
  }, [reloadKey]);

  // Track container size so the canvas fills the panel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
      {data.nodes.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center text-fg-fainter">
          <Share2 size={28} className="mb-2 opacity-30" />
          <span className="text-xs">{t("graph.empty")}</span>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[11px] text-fg-fainter">
              {t("graph.loading")}
            </div>
          }
        >
          <ForceGraph2D
            ref={fgRef}
            width={size.w || undefined}
            height={size.h || undefined}
            graphData={data}
            backgroundColor="rgba(0,0,0,0)"
            nodeRelSize={NODE_R}
            // Keep areas modest: radius grows slowly with degree so a
            // hub doesn't balloon over everything (nodeVal is AREA).
            nodeVal={() => 1}
            linkColor={(l: FGNodeAny) => {
              if (!focusSet) return "rgba(148,163,184,0.22)";
              const a = endId((l as { source: unknown }).source);
              const b = endId((l as { target: unknown }).target);
              const on = focusSet.has(a) && focusSet.has(b) && (a === picked!.path || b === picked!.path);
              return on ? "rgba(96,165,250,0.9)" : "rgba(148,163,184,0.06)";
            }}
            linkWidth={(l: FGNodeAny) => {
              if (!focusSet) return 1;
              const a = endId((l as { source: unknown }).source);
              const b = endId((l as { target: unknown }).target);
              return focusSet.has(a) && focusSet.has(b) && (a === picked!.path || b === picked!.path) ? 2 : 1;
            }}
            linkDirectionalParticles={0}
            cooldownTicks={140}
            d3VelocityDecay={0.3}
            onNodeClick={(n: FGNodeAny) => {
              const nn = n as FGNode & { x?: number; y?: number };
              // Convert graph coords → screen (container-relative) so the
              // popover sits next to the clicked node.
              let sx = size.w / 2, sy = size.h / 2;
              try {
                const p = fgRef.current?.graph2ScreenCoords?.(nn.x ?? 0, nn.y ?? 0);
                if (p) { sx = p.x; sy = p.y; }
              } catch { /* fall back to centre */ }
              setPicked({ path: nn.path, title: nn.title, section: nn.section, sx, sy });
            }}
            onBackgroundClick={() => setPicked(null)}
            onEngineStop={() => {
              // Fit the whole graph into view once the layout settles, so
              // the initial zoom isn't blown up (few/spread nodes made
              // the first render look like giant circles).
              if (!fittedRef.current) {
                fittedRef.current = true;
                try { fgRef.current?.zoomToFit?.(400, 60); } catch { /* ref not ready */ }
              }
            }}
            nodePointerAreaPaint={(n: FGNodeAny, color: string, ctx: CanvasRenderingContext2D) => {
              const nn = n as FGNode & { x?: number; y?: number };
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(nn.x ?? 0, nn.y ?? 0, nodeRadius(nn.deg), 0, 2 * Math.PI);
              ctx.fill();
            }}
            nodeCanvasObject={(n: FGNodeAny, ctx: CanvasRenderingContext2D, scale: number) => {
              const nn = n as FGNode & { x?: number; y?: number };
              const x = nn.x ?? 0, y = nn.y ?? 0;
              // Screen-constant radius: divide the target screen size by
              // the zoom so nodes stay ~the same pixel size regardless of
              // how far zoomToFit zoomed in (few nodes = high zoom, which
              // otherwise made the circles huge).
              const r = nodeRadius(nn.deg) / scale;
              const isPicked = nn.id === picked?.path;
              const isSel = nn.id === selected || isPicked;
              const inFocus = !focusSet || focusSet.has(nn.id);
              // node circle — dim nodes outside the focused neighbourhood.
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fillStyle = nodeColor(nn.section);
              ctx.globalAlpha = inFocus ? (isPicked ? 1 : 0.92) : 0.12;
              ctx.fill();
              ctx.globalAlpha = 1;
              if (isSel) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 2 / scale;
                ctx.stroke();
              }
              // label BELOW the node, centered — shown when zoomed in, the
              // graph is small, or the node is in the focused set.
              if (inFocus && (scale > 1.1 || data.nodes.length <= 25 || (focusSet && focusSet.has(nn.id)))) {
                const label = nn.title.length > 22 ? nn.title.slice(0, 22) + "…" : nn.title;
                const fs = Math.max(9 / scale, 2.5);
                ctx.font = `${fs}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = isSel ? "rgba(226,232,240,0.95)" : "rgba(148,163,184,0.85)";
                ctx.fillText(label, x, y + r + 1.5 / scale);
              }
            }}
          />
        </Suspense>
      )}
      {/* click-to-open popover */}
      {picked && (
        <div
          className="absolute z-10 w-56 -translate-x-1/2 rounded-lg border border-border-default bg-bg-overlay p-2.5 shadow-lg"
          style={{
            left: Math.max(90, Math.min(size.w - 90, picked.sx)),
            top: Math.max(8, Math.min(size.h - 90, picked.sy + 10)),
          }}
        >
          <div className="mb-0.5 flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: nodeColor(picked.section) }}
            />
            <span className="truncate text-[10px] uppercase tracking-wide text-fg-fainter">
              {SECTION_LABEL_KEY[picked.section] ? t(SECTION_LABEL_KEY[picked.section]) : SECTION_LABEL[picked.section] ?? picked.section}
            </span>
          </div>
          <div className="mb-2 line-clamp-2 text-[13px] font-medium text-fg-default">{picked.title}</div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPicked(null)}
              className="rounded px-2 py-1 text-[11px] text-fg-muted hover:bg-bg-hover transition-colors"
            >
              {t("graph.cancel")}
            </button>
            <button
              onClick={() => {
                const p = picked.path;
                setPicked(null);
                onOpen(p);
              }}
              className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-fg-on-accent hover:bg-accent-hover transition-colors"
            >
              {t("graph.open")}
            </button>
          </div>
        </div>
      )}

      {/* legend */}
      {data.nodes.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-bg-base/70 px-2 py-1 text-[10px] text-fg-muted backdrop-blur-sm">
          {LEGEND.map((l) => (
            <span key={l.section} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {SECTION_LABEL_KEY[l.section] ? t(SECTION_LABEL_KEY[l.section]) : l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// Node radius (canvas units) grows gently with link degree, capped so
// hubs stay readable and labels have room.
const NODE_R = 5;
function nodeRadius(deg: number): number {
  return NODE_R + Math.min(6, Math.sqrt(deg) * 2);
}

const LEGEND: Array<{ section: string; label: string; color: string }> = [
  { section: "journal/daily", label: "Daily", color: SECTION_COLOR["journal/daily"]! },
  { section: "journal/weekly", label: "Weekly", color: SECTION_COLOR["journal/weekly"]! },
  { section: "journal/monthly", label: "Monthly", color: SECTION_COLOR["journal/monthly"]! },
  { section: "topics", label: "Topics", color: SECTION_COLOR["topics"]! },
  { section: "entities", label: "Entities", color: SECTION_COLOR["entities"]! },
  { section: "concepts", label: "Concepts", color: SECTION_COLOR["concepts"]! },
  { section: "sources", label: "Sources", color: SECTION_COLOR["sources"]! },
];

// ─── composer button: record wiki ───────────────────────────────

function WikiRecordButton(_props: ComposerActionProps) {
  const t = usePluginT("wiki");
  const nav = useChatNav();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  // Poll status; faster cadence while running so the ring moves.
  useEffect(() => {
    let alive = true;
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      fetch(`${API_BASE}/status`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { running?: boolean; progress?: number } | null) => {
          if (!alive || !j) return;
          setBusy(!!j.running);
          if (typeof j.progress === "number") setProgress(j.progress);
          id = setTimeout(tick, j.running ? 1500 : 5000);
        })
        .catch(() => {
          if (alive) id = setTimeout(tick, 5000);
        });
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, []);

  const onClick = () => {
    if (busy) return;
    setBusy(true);
    setProgress(0);
    // Spawn the background wiki-worker (its own session; won't pollute
    // this conversation). It notifies this session when done.
    fetch(`${API_BASE}/record`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: nav.viewingSessionId ?? null }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { started?: boolean }) => {
        if (!j.started) setBusy(false);
      })
      .catch(() => setBusy(false));
  };

  // iOS-app-install-style ring: a track circle + a progress arc that
  // sweeps clockwise as done/total climbs, wrapping the Notebook icon.
  const R = 10, C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(1, progress));

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={busy ? t("record.running", { pct: Math.round(pct * 100) }) : t("record.record")}
      className={
        "relative flex h-7 w-7 items-center justify-center rounded transition-colors " +
        (busy ? "cursor-default text-brand-400" : "text-fg-faint hover:text-fg-default hover:bg-bg-hover")
      }
    >
      {busy && (
        <svg className="absolute inset-0 -rotate-90" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.2" />
          <circle
            cx="12" cy="12" r={R} fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
            style={{ transition: "stroke-dashoffset 0.5s ease" }}
          />
        </svg>
      )}
      <Notebook size={busy ? 12 : 16} />
    </button>
  );
}

const exports: PluginClientExports = {
  components: {
    WikiPanel: WikiPanel as PluginClientExports["components"][string],
    WikiRecordButton: WikiRecordButton as PluginClientExports["components"][string],
  },
};

export default exports;
