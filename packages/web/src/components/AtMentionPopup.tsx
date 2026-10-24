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
import { ListTodo, Search } from "lucide-react";
import { useComposerStore, type PinnedContext } from "../stores/composer-store";

// ─── Provider interface ──────────────────────────────────────
export interface MentionItem {
  id: string;
  label: string;
  /** Optional second line. */
  description?: string;
  /** Build the PinnedContext to pin. */
  toPin: () => PinnedContext;
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
      }> = data.tasks ?? data;
      // Sort by time descending (most recent first)
      tasks.sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
      return tasks.map((t) => ({
        id: `task:${t.id}`,
        label: t.title,
        description: t.status === "in_progress" ? "🟡 In Progress" : t.status === "done" ? "✅ Done" : "⬜ " + t.status,
        toPin: () => ({
          id: `task:${t.id}`,
          kind: "task" as const,
          label: t.title,
          summary: `task_id=${t.id}`,
        }),
      }));
    } catch {
      return [];
    }
  },
};

const defaultProviders: MentionProvider[] = [taskProvider];

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
  const [search, setSearch] = useState("");
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset state on open/close
  useEffect(() => {
    if (active) {
      setLevel("providers");
      setSelectedProvider(null);
      setItems([]);
      setHighlight(0);
      setSearch("");
    }
  }, [active]);

  // If there's only one provider, skip to items
  useEffect(() => {
    if (active && level === "providers" && defaultProviders.length === 1) {
      pickProvider(defaultProviders[0]!);
    }
  }, [active, level]);

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
        setHighlight((h) => Math.min(h + 1, (level === "providers" ? defaultProviders.length : filtered.length) - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
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
  }, [active, level, highlight, filtered, pickProvider, pickItem, onClose]);

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
      className="absolute bottom-full left-0 z-50 mb-2 w-72 max-h-64 overflow-hidden rounded-xl border border-border-default bg-bg-elevated shadow-lg"
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
          {defaultProviders.length > 1 && (
            <button
              type="button"
              className="text-[10px] text-fg-fainter hover:text-fg-muted"
              onClick={() => { setLevel("providers"); setHighlight(0); }}
            >
              Back
            </button>
          )}
        </div>
      )}

      <div className="overflow-y-auto max-h-52">
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
              <button
                key={item.id}
                type="button"
                onClick={() => pickItem(item)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                  i === highlight ? "bg-accent/10" : "hover:bg-bg-hover"
                } ${alreadyPinned ? "opacity-50" : ""}`}
              >
                <div className="min-w-0 flex-1">
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
                </div>
                {alreadyPinned && (
                  <span className="text-[10px] text-accent">pinned</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
