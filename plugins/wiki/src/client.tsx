// Wiki plugin — side panel.
//
// Browse the user's LLM Wiki: a searchable list of pages grouped by
// section (sources / entities / concepts / topics) with a Markdown
// reader for the selected page. Data comes from the plugin routes
// GET /api/p/wiki/{list,read,search}. Refreshes on workspace changes.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Notebook, Search, RefreshCw, FileText } from "lucide-react";
import type { PanelProps, PluginClientExports } from "@tianshu-ai/plugin-sdk/client";
import { useUiPrimitives, subscribeToWsEvent } from "@tianshu-ai/plugin-sdk/client";

const API_BASE = "/api/p/wiki";

interface WikiPage {
  section: string;
  slug: string;
  title: string;
  updatedAt?: string;
  path: string;
}

const SECTION_ORDER = ["topics", "entities", "concepts", "sources"];
const SECTION_LABEL: Record<string, string> = {
  topics: "Topics",
  entities: "Entities",
  concepts: "Concepts",
  sources: "Sources",
};

function WikiPanel(_props: PanelProps) {
  const { MarkdownBlock } = useUiPrimitives();
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [markdown, setMarkdown] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

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
    setSelected(p);
    const [section, slug] = p.split("/");
    fetch(
      `${API_BASE}/read?section=${encodeURIComponent(section ?? "")}&slug=${encodeURIComponent(slug ?? "")}`,
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
          onClick={fetchList}
          title="Refresh"
          className="rounded p-1 text-fg-faint hover:text-fg-default hover:bg-bg-hover transition-colors"
        >
          <RefreshCw size={12} />
        </button>
      </div>

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
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
          {selected ? (
            <div className="prose prose-sm prose-invert max-w-none text-[13px]">
              <MarkdownBlock>{markdown}</MarkdownBlock>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-fg-fainter">
              <Notebook size={28} className="mb-2 opacity-30" />
              <span className="text-xs">{loading ? "Loading…" : "Select a page"}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
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

const exports: PluginClientExports = {
  components: { WikiPanel },
};

export default exports;
