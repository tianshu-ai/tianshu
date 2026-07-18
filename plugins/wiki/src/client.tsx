// Wiki plugin — side panel.
//
// Browse the user's LLM Wiki: a searchable list of pages grouped by
// section (sources / entities / concepts / topics) with a Markdown
// reader for the selected page. Data comes from the plugin routes
// GET /api/p/wiki/{list,read,search}. Refreshes on workspace changes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Notebook, Search, RefreshCw, FileText, Trash2, List, Share2 } from "lucide-react";
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
      .then((res: { markdown: string }) => setMarkdown(stripFrontmatter(res.markdown ?? "")))
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

// ─── graph view (zero-dep force layout, SVG) ────────────────────

interface GraphNode { path: string; section: string; title: string }
interface GraphEdge { from: string; to: string }
interface Pt { x: number; y: number; vx: number; vy: number }

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

function WikiGraphView({
  onOpen,
  selected,
  reloadKey,
}: {
  onOpen: (path: string) => void;
  selected: string | null;
  reloadKey: number;
}) {
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const [pos, setPos] = useState<Record<string, Pt>>({});
  const [hover, setHover] = useState<string | null>(null);
  const W = 800;
  const H = 560;

  useEffect(() => {
    fetch(`${API_BASE}/graph`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((g: { nodes: GraphNode[]; edges: GraphEdge[] }) => setGraph(g))
      .catch(() => setGraph({ nodes: [], edges: [] }));
  }, [reloadKey]);

  // Run a short force simulation once the graph loads. Deterministic
  // seed (ring layout) + a few hundred ticks of spring + repulsion +
  // centering. Cheap for the dozens–hundreds of pages we expect.
  useEffect(() => {
    const nodes = graph.nodes;
    const n = nodes.length;
    if (n === 0) {
      setPos({});
      return;
    }
    const p: Record<string, Pt> = {};
    nodes.forEach((nd, i) => {
      const a = (i / n) * Math.PI * 2;
      p[nd.path] = { x: W / 2 + Math.cos(a) * 180, y: H / 2 + Math.sin(a) * 180, vx: 0, vy: 0 };
    });
    const edges = graph.edges.filter((e) => p[e.from] && p[e.to]);
    const K = 0.02; // spring
    const REST = 90;
    const REP = 4000; // repulsion
    for (let iter = 0; iter < 320; iter++) {
      // repulsion (O(n^2), fine for our scale)
      for (let i = 0; i < n; i++) {
        const a = p[nodes[i]!.path]!;
        for (let j = i + 1; j < n; j++) {
          const b = p[nodes[j]!.path]!;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy || 0.01;
          const f = REP / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
      }
      // springs
      for (const e of edges) {
        const a = p[e.from]!, b = p[e.to]!;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = K * (d - REST);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      // integrate + centering + damping
      for (const nd of nodes) {
        const q = p[nd.path]!;
        q.vx += (W / 2 - q.x) * 0.002;
        q.vy += (H / 2 - q.y) * 0.002;
        q.vx *= 0.85; q.vy *= 0.85;
        q.x += q.vx; q.y += q.vy;
        q.x = Math.max(20, Math.min(W - 20, q.x));
        q.y = Math.max(20, Math.min(H - 20, q.y));
      }
    }
    setPos({ ...p });
  }, [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center text-fg-fainter">
        <Share2 size={28} className="mb-2 opacity-30" />
        <span className="text-xs">No pages to graph yet.</span>
      </div>
    );
  }

  const deg: Record<string, number> = {};
  for (const e of graph.edges) { deg[e.from] = (deg[e.from] ?? 0) + 1; deg[e.to] = (deg[e.to] ?? 0) + 1; }

  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="xMidYMid meet">
        {graph.edges.map((e, i) => {
          const a = pos[e.from], b = pos[e.to];
          if (!a || !b) return null;
          const hot = hover === e.from || hover === e.to || selected === e.from || selected === e.to;
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={hot ? "#60a5fa" : "currentColor"}
              strokeOpacity={hot ? 0.7 : 0.15}
              strokeWidth={hot ? 1.5 : 1}
              className="text-fg-fainter"
            />
          );
        })}
        {graph.nodes.map((nd) => {
          const q = pos[nd.path];
          if (!q) return null;
          const r = 4 + Math.min(8, (deg[nd.path] ?? 0) * 1.2);
          const active = selected === nd.path || hover === nd.path;
          return (
            <g
              key={nd.path}
              transform={`translate(${q.x},${q.y})`}
              className="cursor-pointer"
              onClick={() => onOpen(nd.path)}
              onMouseEnter={() => setHover(nd.path)}
              onMouseLeave={() => setHover(null)}
            >
              <circle
                r={r}
                fill={nodeColor(nd.section)}
                stroke={active ? "#fff" : "none"}
                strokeWidth={active ? 1.5 : 0}
                fillOpacity={active ? 1 : 0.85}
              />
              {(active || graph.nodes.length <= 40) && (
                <text
                  x={r + 3}
                  y={3}
                  fontSize={9}
                  className="fill-fg-muted"
                  style={{ pointerEvents: "none" }}
                >
                  {nd.title.length > 22 ? nd.title.slice(0, 22) + "…" : nd.title}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

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
