import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import type { ModelListEntry } from "../lib/api";
import { useT } from "../hooks/useT";

/**
 * Pill-shaped model picker rendered inside ChatInput's footer row,
 * mirroring the closed-source ChatInput → ModelSelector pattern.
 *
 *  - reads `models` + `preferredModel` from the store
 *  - falls back to `me.defaultModel` when the user hasn't picked one
 *  - dropdown is a portal anchored above the button so it doesn't get
 *    clipped by the composer's overflow-hidden chrome
 *  - groups entries by `group` (Cloud / Local / …) — pure UI hint from
 *    the provider catalog, no server-side meaning
 */
/**
 * Props let a caller override the model source + sink. The chat
 * shell's composer calls `<ModelSelector />` with no props and
 * the picker drives the user's preferred-model store as before.
 * Channel sessions render `<ModelSelector value={...} onChange={...} />`
 * so picking a model writes back to the binding's config instead.
 */
export interface ModelSelectorProps {
  /** Override active model id. When set, the component ignores
   *  preferredModel / fallbackId for highlight + label. */
  value?: string | null;
  /** Override change handler. When provided the component does not
   *  call setPreferred; the caller persists the value wherever it
   *  belongs (binding, user pref, ...). */
  onChange?: (id: string) => void;
}

export default function ModelSelector({ value, onChange }: ModelSelectorProps = {}) {
  const t = useT();
  const models = useChatStore((s) => s.models);
  const preferred = useChatStore((s) => s.preferredModel);
  const setPreferred = useChatStore((s) => s.setPreferredModel);
  const fallbackId = useChatStore((s) => s.me?.defaultModel?.id ?? null);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    if (!buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setPos({ top: r.top, right: window.innerWidth - r.right });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePos();
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onResize = () => updatePos();
    document.addEventListener("mousedown", onClick);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("resize", onResize);
    };
  }, [open, updatePos]);

  if (models.length === 0) return null;

  // Pick an activeId that's actually in the catalog. The naive
  // `preferred ?? fallbackId ?? models[0]` fails when:
  //   - preferredModel was saved in localStorage during a session
  //     against a different tenant whose catalog had that model;
  //     after a tenant switch the id is dangling, but the ??
  //     chain still hands it to us
  //   - server returned a tenant-scoped fallbackId that's stale
  //     for similar reasons (config drift)
  // Either way the button renders a model name that isn't in the
  // dropdown — user can't see what's actually selected and the
  // dropdown's highlight points at nothing. Caught 2026-06-21 on
  // a tenant with only qwen but a preferredModel from before.
  const inCatalog = (id: string | null | undefined): id is string =>
    !!id && models.some((m) => m.id === id);
  // Channel-session callers pass `value`; standalone composer
  // callers fall back to the user's stored preferred model.
  const activeId = inCatalog(value)
    ? value
    : inCatalog(preferred)
      ? preferred
      : inCatalog(fallbackId)
        ? fallbackId
        : models[0]!.id;
  const active = models.find((m) => m.id === activeId);
  const displayName = active?.name ?? activeId.split("/").pop() ?? t("model.fallbackName");

  const groups: { label: string; items: ModelListEntry[] }[] = [];
  const otherLabel = t("model.groupOther");
  for (const m of models) {
    const label = m.group ?? otherLabel;
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [] };
      groups.push(g);
    }
    g.items.push(m);
  }

  const choose = (id: string) => {
    setOpen(false);
    if (id === activeId) return;
    if (onChange) {
      onChange(id);
      return;
    }
    setPreferred(id);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full bg-bg-hover/60 py-1 pl-2.5 pr-2 text-xs font-medium text-fg-muted transition-colors hover:bg-bg-hover"
        title={activeId}
      >
        <span className="max-w-[160px] truncate">{displayName}</span>
        <ChevronDown
          size={12}
          className={`text-fg-muted transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            className="fixed z-[9999] max-h-80 w-64 overflow-y-auto rounded-xl border border-border-default bg-bg-raised py-1 shadow-2xl"
            style={{
              bottom: `calc(100vh - ${pos.top}px + 8px)`,
              right: `${pos.right}px`,
            }}
          >
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-3 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
                  {g.label}
                </div>
                {g.items.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => choose(m.id)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors " +
                      (m.id === activeId
                        ? "bg-bg-hover text-fg-default"
                        : "text-fg-muted hover:bg-bg-hover/40")
                    }
                    title={m.id}
                  >
                    <span className="flex-1 truncate">{m.name}</span>
                    {m.reasoning && (
                      <span className="shrink-0 rounded bg-amber-500/15 px-1 py-px text-[9px] text-warning">
                        reasoning
                      </span>
                    )}
                    {m.id === activeId && (
                      <Check size={14} className="shrink-0 text-link" />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
