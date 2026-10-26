/**
 * @ mention popup for the composer.
 *
 * Typing "@" opens a two-level picker:
 *   Level 1: pick a provider (e.g. "Task")
 *   Level 2: pick an item from that provider (e.g. a specific task)
 *
 * Selecting an item pins it to the composer via useComposerStore.
 * Extensible: register new providers via the `providers` array.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CheckCircle2, ChevronLeft, ChevronRight, Cylinder, FileText, Folder, Globe, ListTodo, Pin, Search, Users } from "lucide-react";
import { useComposerStore, type PinnedContext } from "../stores/composer-store";

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// ─── Provider interface ──────────────────────────────────────
export interface MentionItem {
  id: string;
  label: string;
  /** Optional second line. */
  description?: string;
  /** Build the PinnedContext to pin. */
  toPin: () => PinnedContext;
  /** If set, this item can be drilled into (e.g. a folder). */
  drillDown?: () => Promise<MentionItem[]>;
  /** Icon override for this item. */
  itemIcon?: React.ReactNode;
}

export interface MentionProvider {
  id: string;
  label: string;
  icon: React.ReactNode;
  /** Fetch items. Should be fast. */
  fetchItems: () => Promise<MentionItem[]>;
}

// ─── Built-in: Task provider ─────────────────────────────────
const taskProvider: MentionProvider = {
  id: "task",
  label: "Task",
  icon: <ListTodo size={14} />,
  fetchItems: async () => {
    try {
      const res = await fetch("/api/p/workboard/tasks", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const tasks: Array<{
        id: string;
        title: string;
        description?: string;
        status: string;
        priority: number;
        createdAt: number;
        startedAt?: number;
        endedAt?: number;
        workerAgentId?: string;
      }> = data.tasks ?? data;
      // Sort by time descending (most recent first)
      tasks.sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
      return tasks.map((t) => {
        const ts = t.endedAt ?? t.startedAt ?? t.createdAt;
        const parts: string[] = [];
        if (t.workerAgentId) parts.push(t.workerAgentId);
        parts.push(relativeTime(ts));
        const statusNode = t.status === "in_progress" ? (
          <span className="w-3.5 h-3.5 flex items-center justify-center"><span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" /></span>
        ) : t.status === "done" ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
        ) : (
          <span className="w-3.5 h-3.5 flex items-center justify-center"><span className="w-2 h-2 rounded-full border border-fg-faint" /></span>
        );
        return {
          id: `task:${t.id}`,
          label: t.title,
          description: parts.join(" · "),
          itemIcon: statusNode,
          toPin: () => ({
            id: `task:${t.id}`,
            kind: "task" as const,
            label: t.title,
            summary: `task_id=${t.id}`,
          }),
        };
      });
    } catch {
      return [];
    }
  },
};

// ─── Built-in: Worker provider ───────────────────────────────
const workerProvider: MentionProvider = {
  id: "worker",
  label: "Worker",
  icon: <Bot size={14} />,
  fetchItems: async () => {
    try {
      const res = await fetch("/api/p/workboard/agents", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const agents: Array<{
        id: string;
        name: string;
        enabled: boolean;
        kind?: string;
        description?: string;
      }> = data.agents ?? [];
      return agents
        .filter((a) => a.enabled)
        .map((a) => {
          const parts: string[] = [];
          if (a.kind) parts.push(a.kind);
          if (a.description) parts.push(a.description);
          return {
          id: `worker:${a.id}`,
          label: a.name || a.id,
          description: parts.join(" · ") || undefined,
          toPin: () => ({
            id: `worker:${a.id}`,
            kind: "task" as const,
            label: `@${a.name || a.id}`,
            summary: `worker=${a.id}`,
          }),
        };
        });
    } catch {
      return [];
    }
  },
};

// ─── Built-in: Contact provider ─────────────────────────────────
const contactProvider: MentionProvider = {
  id: "contact",
  label: "Contact",
  icon: <Users size={14} />,
  fetchItems: async () => {
    try {
      const res = await fetch("/api/p/messenger/contacts", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const contacts: Array<{
        id: string;
        name: string;
        type: string;
        enabled: boolean;
        lastMessage?: { text: string; createdAt: number } | null;
      }> = data.contacts ?? [];
      return contacts
        .filter((c) => c.enabled)
        .map((c) => {
          const parts: string[] = [c.type];
          if (c.lastMessage) parts.push(relativeTime(c.lastMessage.createdAt));
          return {
            id: `contact:${c.id}`,
            label: c.name,
            description: parts.join(" · "),
            toPin: () => ({
              id: `contact:${c.id}`,
              kind: "task" as const,
              label: `@${c.name}`,
              summary: `contact_id=${c.id} contact_name=${c.name} contact_type=${c.type}`,
            }),
          };
        });
    } catch {
      return [];
    }
  },
};

// ─── Built-in: Board provider ─────────────────────────────────────
const boardProvider: MentionProvider = {
  id: "board",
  label: "Board",
  icon: <Globe size={14} />,
  fetchItems: async () => {
    try {
      const res = await fetch("/api/p/board/boards", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const meta: Array<{ name: string; title: string | null }> = data.boardsMeta ?? (data.boards ?? []).map((b: string) => ({ name: b, title: null }));
      return meta.map((b) => ({
        id: `board:${b.name}`,
        label: b.name,
        description: b.title || undefined,
        toPin: () => ({
          id: `board:${b.name}`,
          kind: "task" as const,
          label: `board:${b.name}`,
          summary: `board=${b.name}`,
        }),
      }));
    } catch {
      return [];
    }
  },
};

// ─── Built-in: Datasource provider ──────────────────────────────
const datasourceProvider: MentionProvider = {
  id: "datasource",
  label: "Datasource",
  icon: <Cylinder size={14} />,
  fetchItems: async () => {
    try {
      const res = await fetch("/api/p/datasource/connections", { credentials: "include" });
      if (!res.ok) return [];
      const data = await res.json();
      const conns: Array<{ name: string; type: string; description?: string }> = data.connections ?? [];
      return conns.map((c) => {
        const parts: string[] = [c.type];
        if (c.description) parts.push(c.description);
        return {
          id: `ds:${c.name}`,
          label: c.name,
          description: parts.join(" · "),
          toPin: () => ({
            id: `ds:${c.name}`,
            kind: "task" as const,
            label: `ds:${c.name}`,
            summary: `datasource=${c.name} type=${c.type}`,
          }),
        };
      });
    } catch {
      return [];
    }
  },
};

// ─── Built-in: Workspace File provider ──────────────────────────────

function fetchDirItems(dir: string): Promise<MentionItem[]> {
  return fetch(`/api/p/files/list?dir=${encodeURIComponent(dir)}`, { credentials: "include" })
    .then((r) => r.ok ? r.json() : { entries: [] })
    .then((data: { entries?: Array<{ name: string; path: string; type: string; size: number }> }) => {
      const entries = data.entries ?? [];
      const sorted = [...entries].sort((a, b) => {
        if (a.type === "directory" && b.type !== "directory") return -1;
        if (a.type !== "directory" && b.type === "directory") return 1;
        return a.name.localeCompare(b.name);
      });
      return sorted.map((e): MentionItem => {
        const isDir = e.type === "directory";
        return {
          id: `file:${e.path}`,
          label: e.name + (isDir ? "/" : ""),
          description: e.path,
          itemIcon: isDir ? <Folder size={14} className="text-yellow-500" /> : <FileText size={14} className="text-fg-muted" />,
          toPin: () => ({
            id: `file:${e.path}`,
            kind: "task" as const,
            label: isDir ? `📁 ${e.name}` : `file:${e.name}`,
            summary: `${isDir ? "dir" : "file"}=${e.path}`,
          }),
          ...(isDir ? { drillDown: () => fetchDirItems(e.path) } : {}),
        };
      });
    })
    .catch(() => []);
}

const fileProvider: MentionProvider = {
  id: "file",
  label: "File",
  icon: <FileText size={14} />,
  fetchItems: () => fetchDirItems("/"),
};

const defaultProviders: MentionProvider[] = [taskProvider, workerProvider, contactProvider, boardProvider, datasourceProvider, fileProvider];

// ─── Component ───────────────────────────────────────────────
export default function AtMentionPopup({
  active,
  filter,
  onClose,
  onAccept,
  anchorRef,
}: {
  active: boolean;
  /** Text after the "@". */
  filter: string;
  onClose: () => void;
  /** Called after an item is pinned — the parent should clear the "@..." text. */
  onAccept: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const [level, setLevel] = useState<"providers" | "items">("providers");
  const [selectedProvider, setSelectedProvider] = useState<MentionProvider | null>(null);
  const [items, setItems] = useState<MentionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Breadcrumb stack for drill-down navigation (e.g. file browser)
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ label: string; items: MentionItem[] }>>([]);

  // Reset state on open/close
  useEffect(() => {
    if (active) {
      setLevel("providers");
      setSelectedProvider(null);
      setItems([]);
      setHighlight(0);
      setSearch("");
      setBreadcrumbs([]);
    }
  }, [active]);


  const pickProvider = useCallback(async (p: MentionProvider) => {
    setSelectedProvider(p);
    setLevel("items");
    setLoading(true);
    setHighlight(0);
    try {
      const fetched = await p.fetchItems();
      setItems(fetched);
    } catch {
      setItems([]);
    }
    setLoading(false);
    // Focus search after items load
    setTimeout(() => searchRef.current?.focus(), 50);
  }, []);

  const drillInto = useCallback(async (item: MentionItem) => {
    if (!item.drillDown) return;
    setLoading(true);
    setSearch("");
    setHighlight(0);
    setBreadcrumbs((prev) => [...prev, { label: item.label, items }]);
    try {
      const children = await item.drillDown();
      setItems(children);
    } catch {
      setItems([]);
    }
    setLoading(false);
    setTimeout(() => searchRef.current?.focus(), 50);
  }, [items]);

  const goBack = useCallback(() => {
    setBreadcrumbs((prev) => {
      if (prev.length === 0) {
        // Go back to provider list
        setLevel("providers");
        setSelectedProvider(null);
        setItems([]);
        return [];
      }
      const next = [...prev];
      const parent = next.pop()!;
      setItems(parent.items);
      setSearch("");
      setHighlight(0);
      return next;
    });
  }, []);

  const pickItem = useCallback((item: MentionItem) => {
    const pin = item.toPin();
    const store = useComposerStore.getState();
    if (!store.pinnedContexts.some((c) => c.id === pin.id)) {
      store.pinContext(pin);
    }
    onAccept();
    onClose();
  }, [onAccept, onClose]);

  // Filter items by search
  const filtered = useMemo(() => {
    const q = (search || filter).toLowerCase().trim();
    if (!q) return items;
    return items.filter((i) =>
      i.label.toLowerCase().includes(q) ||
      i.description?.toLowerCase().includes(q)
    );
  }, [items, search, filter]);

  // Keyboard navigation
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const max = (level === "providers" ? defaultProviders.length : filtered.length) - 1;
        setHighlight((h) => h >= max ? 0 : h + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const max = (level === "providers" ? defaultProviders.length : filtered.length) - 1;
        setHighlight((h) => h <= 0 ? max : h - 1);
        return;
      }
      // ArrowRight: drill into folder (or pick provider)
      if (e.key === "ArrowRight") {
        e.preventDefault();
        if (level === "providers") {
          const p = defaultProviders[highlight];
          if (p) pickProvider(p);
        } else {
          const item = filtered[highlight];
          if (item?.drillDown) drillInto(item);
        }
        return;
      }
      // ArrowLeft: go back up
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (level === "items") goBack();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        if (level === "providers") {
          const p = defaultProviders[highlight];
          if (p) pickProvider(p);
        } else {
          const item = filtered[highlight];
          if (item) pickItem(item);
        }
        return;
      }
    };
    // Capture phase so we intercept before textarea
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [active, level, highlight, filtered, pickProvider, pickItem, drillInto, onClose]);

  // Scroll highlighted item into view
  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    const el = container.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  // Close on outside click
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, onClose]);

  if (!active) return null;

  return (
    <div
      ref={popupRef}
      className="absolute bottom-full left-0 z-50 mb-2 w-72 max-h-64 overflow-hidden rounded-xl border border-border-default bg-bg-surface shadow-lg"
    >
      {level === "items" && (
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
          <Search size={13} className="text-fg-faint" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setHighlight(0); }}
            placeholder={`Search ${selectedProvider?.label ?? ""}…`}
            className="flex-1 bg-transparent text-xs text-fg-default placeholder:text-fg-faint outline-none"
            onKeyDown={(e) => {
              // Let the global handler manage navigation keys
              if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
            }}
          />
          <button
            type="button"
            className="flex items-center gap-0.5 text-[10px] text-fg-fainter hover:text-fg-muted"
            onClick={() => breadcrumbs.length > 0 ? goBack() : (() => { setLevel("providers"); setHighlight(0); })()}
          >
            <ChevronLeft size={10} />
            {breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1]!.label.replace(/\/$/,"") : "Back"}
          </button>
        </div>
      )}

      <div ref={listRef} className="overflow-y-auto max-h-52">
        {level === "providers" ? (
          defaultProviders.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => pickProvider(p)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors ${
                i === highlight ? "bg-accent/10 text-accent" : "text-fg-default hover:bg-bg-hover"
              }`}
            >
              <span className="flex-shrink-0">{p.icon}</span>
              <span className="font-medium">{p.label}</span>
            </button>
          ))
        ) : loading ? (
          <div className="flex items-center justify-center py-4 text-xs text-fg-faint">
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-4 text-xs text-fg-faint">
            No items
          </div>
        ) : (
          filtered.map((item, i) => {
            const alreadyPinned = useComposerStore.getState().pinnedContexts.some((c) => c.id === item.id);
            return (
              <div
                key={item.id}
                className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                  i === highlight ? "bg-accent/10" : "hover:bg-bg-hover"
                } ${alreadyPinned ? "opacity-50" : ""}`}
              >
                {item.itemIcon && <span className="flex-shrink-0">{item.itemIcon}</span>}
                <button
                  type="button"
                  onClick={() => item.drillDown ? drillInto(item) : pickItem(item)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className={`block truncate text-xs font-medium ${
                    i === highlight ? "text-accent" : "text-fg-default"
                  }`}>
                    {item.label}
                  </span>
                  {item.description && (
                    <span className="block truncate text-[10px] text-fg-faint">
                      {item.description}
                    </span>
                  )}
                </button>
                {item.drillDown && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); pickItem(item); }}
                    className="flex-shrink-0 rounded p-0.5 text-fg-fainter hover:text-accent"
                    title="Pin this folder"
                  >
                    <Pin size={10} />
                  </button>
                )}
                {item.drillDown && (
                  <ChevronRight size={12} className="flex-shrink-0 text-fg-fainter" />
                )}
                {alreadyPinned && (
                  <span className="text-[10px] text-accent">pinned</span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
