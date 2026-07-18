// Wiki plugin — side panel.
//
// Browse the user's LLM Wiki: a searchable list of pages grouped by
// section (sources / entities / concepts / topics) with a Markdown
// reader for the selected page. Data comes from the plugin routes
// GET /api/p/wiki/{list,read,search}. Refreshes on workspace changes.

import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { Notebook, Search, RefreshCw, FileText, Trash2, List, Share2 } from "lucide-react";

// react-force-graph-2d pulls in the whole d3-force / canvas stack, so
// load it lazily — it only ships in a separate chunk fetched when the
// user actually opens the graph view.
const ForceGraph2D = lazy(() => import("react-force-graph-2d"));
import type {
  PanelProps,
  PluginClientExports,
  ComposerActionProps,
} from "@tianshu-ai/plugin-sdk/client";
import { useUiPrimitives, subscribeToWsEvent, useChatNav } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/wiki";

interface WikiPage {
  section: string;
  slug: string;
  title: string;
  updatedAt?: string;
  path: string;
}

const SECTION_ORDER = [
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
  "journal/daily": "Daily",
  "journal/weekly": "Weekly",
  "journal/monthly": "Monthly",
  "journal/yearly": "Yearly",
  topics: "Topics",
  entities: "Entities",
  concepts: "Concepts",
  sources: "Sources",
};

function WikiPanel(_props: PanelProps) {
  const { MarkdownBlock, Modal } = useUiPrimitives();
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [pageTitle, setPageTitle] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [view, setView] = useState<"list" | "graph">("list");

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
      .catch(() => setMarkdown("_Failed to load page._"));
  }, []);

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const shown = q
      ? pages.filter((p) => p.title.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
      : pages;
    const by: Record<string, WikiPage[]> = {};
    for (const p of shown) (by[p.section] ??= []).push(p);
    for (const k of Object.keys(by)) by[k]!.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return by;
  }, [pages, filter]);

  return (
    <div className="flex h-full flex-col overflow-hidden text-fg-default">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <Notebook size={13} className="text-fg-faint" />
        <div className="relative flex-1">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter pages…"
            className="w-full rounded-md bg-bg-raised pl-6 pr-2 py-1 text-xs text-fg-muted placeholder:text-fg-fainter focus:outline-none"
          />
        </div>
        <button
          onClick={() => setView(view === "graph" ? "list" : "graph")}
          title={view === "graph" ? "List view" : "Graph view"}
          className={
            "rounded p-1 transition-colors " +
            (view === "graph"
              ? "text-brand-400 bg-brand-500/10"
              : "text-fg-faint hover:text-fg-default hover:bg-bg-hover")
          }
        >
          {view === "graph" ? <List size={12} /> : <Share2 size={12} />}
        </button>
        <button
          onClick={fetchList}
          title="Refresh"
          className="rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => setConfirmReset(true)}
          title="Reset wiki (wipe all pages + progress)"
          className="rounded p-1 text-fg-faint hover:text-danger hover:bg-bg-hover transition-colors"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <Modal
        isOpen={confirmReset}
        onClose={() => !resetting && setConfirmReset(false)}
        title="Reset wiki?"
        size="sm"
        allowMaximize={false}
      >
        <div className="px-4 py-3 text-[13px] text-fg-muted">
          <p>
            This wipes the <strong>entire wiki</strong> — every page
            (daily / weekly / monthly / yearly journals, topics, entities,
            concepts, sources) and the ingest progress cursor.
          </p>
          <p className="mt-2">
            The next “record” run rebuilds from scratch.{" "}
            <strong className="text-danger">This cannot be undone.</strong>
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={() => setConfirmReset(false)}
              disabled={resetting}
              className="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover transition-colors"
            >
              Cancel
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
                    setMarkdown("_Reset failed — a wiki update may be running. Try again after it finishes._"),
                  )
                  .finally(() => setResetting(false));
              }}
              disabled={resetting}
              className="rounded-md bg-danger/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-danger transition-colors disabled:opacity-60"
            >
              {resetting ? "Resetting…" : "Wipe & rebuild"}
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
      ) : (
      <div className="flex min-h-0 flex-1">
        {/* page list */}
        <div className="w-1/3 min-w-[140px] max-w-[220px] shrink-0 overflow-y-auto border-r border-border-subtle px-1.5 py-2">
          {SECTION_ORDER.filter((s) => (grouped[s]?.length ?? 0) > 0).map((s) => (
            <div key={s} className="mb-2">
              <div className="px-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-fg-fainter">
                {SECTION_LABEL[s] ?? s} ({grouped[s]!.length})
              </div>
              {grouped[s]!.map((p) => (
                <button
                  key={p.path}
                  onClick={() => openPage(p.path)}
                  className={
                    "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12px] transition-colors " +
                    (selected === p.path
                      ? "bg-brand-500/15 text-fg-default"
                      : "text-fg-muted hover:bg-bg-hover")
                  }
                >
                  <FileText size={10} className="shrink-0 text-fg-fainter" />
                  <span className="truncate">{p.title}</span>
                </button>
              ))}
            </div>
          ))}
          {!loading && pages.length === 0 && (
            <div className="px-2 py-6 text-center text-[11px] text-fg-fainter">
              No wiki pages yet. They accrue as the conversation is compacted.
            </div>
          )}
        </div>

        {/* reader */}
        <div
          className="min-w-0 flex-1 overflow-y-auto px-4 py-3"
          onClick={(e) => {
            // Intercept clicks on our rewritten wikilinks (#wiki:path)
            // and navigate in-panel instead of letting the browser
            // treat them as anchors.
            const a = (e.target as HTMLElement).closest("a");
            const href = a?.getAttribute("href") ?? "";
            if (href.startsWith("#wiki:")) {
              e.preventDefault();
              openPage(href.slice("#wiki:".length));
            }
          }}
        >
          {selected ? (
            <div className="prose prose-sm prose-invert max-w-none text-[13px] [&_a]:text-link [&_a]:no-underline hover:[&_a]:underline">
              {pageTitle && <h1 className="mb-2 text-base font-semibold text-fg-default">{pageTitle}</h1>}
              <MarkdownBlock>{renderWikilinks(markdown)}</MarkdownBlock>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-fg-fainter">
              <Notebook size={28} className="mb-2 opacity-30" />
              <span className="text-xs">{loading ? "Loading…" : "Select a page"}</span>
            </div>
          )}
        </div>
      </div>
      )}
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
  const [data, setData] = useState<{ nodes: FGNode[]; links: FGLink[] }>({ nodes: [], links: [] });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

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
  }, [data]);

  useEffect(() => {
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
          <span className="text-xs">No pages to graph yet.</span>
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-[11px] text-fg-fainter">
              Loading graph…
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
            linkColor={() => "rgba(148,163,184,0.22)"}
            linkWidth={1}
            linkDirectionalParticles={0}
            cooldownTicks={140}
            d3VelocityDecay={0.3}
            onNodeClick={(n: FGNodeAny) => onOpen((n as FGNode).path)}
            onEngineStop={() => { /* settle */ }}
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
              const r = nodeRadius(nn.deg);
              const isSel = nn.id === selected;
              // node circle
              ctx.beginPath();
              ctx.arc(x, y, r, 0, 2 * Math.PI);
              ctx.fillStyle = nodeColor(nn.section);
              ctx.globalAlpha = isSel ? 1 : 0.9;
              ctx.fill();
              ctx.globalAlpha = 1;
              if (isSel) {
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 2 / scale;
                ctx.stroke();
              }
              // label BELOW the node, centered — only when zoomed in
              // enough (or the graph is small), so labels don't pile up.
              if (scale > 1.1 || data.nodes.length <= 25) {
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
      {/* legend */}
      {data.nodes.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap gap-x-3 gap-y-1 rounded-md bg-bg-base/70 px-2 py-1 text-[10px] text-fg-muted backdrop-blur-sm">
          {LEGEND.map((l) => (
            <span key={l.section} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.label}
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
  const nav = useChatNav();
  const [busy, setBusy] = useState(false);

  // Poll running state so the button reflects an in-flight update
  // (started from any channel/tab).
  useEffect(() => {
    let alive = true;
    const tick = () => {
      fetch(`${API_BASE}/status`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => alive && j && setBusy(!!j.running))
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const onClick = () => {
    if (busy) return;
    setBusy(true);
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

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={busy ? "Wiki update running…" : "Record this conversation into the wiki"}
      className={
        "rounded p-1.5 transition-colors " +
        (busy
          ? "text-brand-400 animate-pulse cursor-default"
          : "text-fg-faint hover:text-fg-default hover:bg-bg-hover")
      }
    >
      <Notebook size={16} />
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
