// Host-provided <Modal> primitive.
//
// Implements the small subset of dialog UX every chat-shell modal
// needs:
//   - render into a portal so it escapes any overflow:hidden parent
//   - ESC closes
//   - clicking the backdrop closes
//   - clicking inside the content does NOT close (stopPropagation)
//   - lock body scroll while open
//   - autofocus the first focusable element inside the panel
//   - Tab / Shift+Tab wraps inside the panel (basic focus trap)
//   - a close ✕ button in the top-right
//
// We deliberately do NOT use Radix or HeadlessUI: keeps the
// dependency footprint flat, and the surface area we need is tiny.
//
// Plugins and the chat shell both render <Modal> through the
// plugin-sdk hook (useUiPrimitives) so a future swap (e.g. to
// Radix when accessibility requirements grow) is a one-place
// change.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ModalProps } from "@tianshu-ai/plugin-sdk/client";

const SIZE_CLASS: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "max-w-md",
  md: "max-w-2xl",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
};

// Selector list cribbed from focus-trap / Radix. Any element a user
// can Tab to. We only use it for the Tab wrap; the autofocus call
// just picks the first one.
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  isOpen,
  onClose,
  title,
  size = "md",
  className = "",
  hideHeader = false,
  children,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Stash the element that was focused before we opened, so we can
  // restore it on close. Without this, hitting ESC inside a modal
  // teleports focus to <body>, which is mildly disorienting.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Body scroll lock — set on open, restore on close. We don't
  // bother with paddingRight to compensate for scrollbar width;
  // the dark theme uses an overlay scrollbar so the layout doesn't
  // shift.
  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  // ESC + initial focus + restore focus on unmount.
  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);

    // Focus the first focusable on next tick — the panel needs to
    // render once for the ref to be live.
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    }, 0);

    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      // Best-effort focus restore. Skip when the previously focused
      // element has been removed from the DOM since we opened.
      const prev = previousFocusRef.current;
      if (prev && document.body.contains(prev)) {
        prev.focus();
      }
    };
  }, [isOpen, onClose]);

  // Tab / Shift+Tab wrap. We do NOT trap focus for arrow-keys etc.;
  // the panel is meant to feel like a regular page chunk inside.
  function handleKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute("inert"));
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey) {
      if (document.activeElement === first) {
        last.focus();
        e.preventDefault();
      }
    } else {
      if (document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    }
  }

  function handleBackdropClick(e: ReactMouseEvent<HTMLDivElement>) {
    // Only close if the click landed on the backdrop itself, not
    // an event that bubbled up from inside the panel.
    if (e.target === e.currentTarget) onClose();
  }

  if (!isOpen) return null;

  // Portal target: <body>. Avoids overflow:hidden / transform
  // ancestors clipping the modal.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onMouseDown={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={panelRef}
        className={`flex max-h-[85vh] w-full ${SIZE_CLASS[size]} flex-col overflow-hidden rounded-xl border border-gray-700 bg-gray-900 shadow-2xl ${className}`}
        onKeyDown={handleKeyDown}
      >
        {/* Header. Rendered by default so the close button has a
            consistent location. Callers with their own bespoke
            header (e.g. workboard's TaskModal) pass `hideHeader`
            so the chrome doesn't double up. */}
        {!hideHeader && (
          <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2.5">
            <div className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost p-1.5"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {/* Body. We do NOT add padding or a scroll container here.
            Callers control both:
              - some want a full-bleed image preview (no padding)
              - some want padded prose
              - some already include their own `overflow-auto`
                scroll container, and a wrapping one here would
                produce two stacked scrollbars and let the inner
                content scroll out from under the top header.
            We do make the body itself a flex column with bounded
            height (min-h-0 + flex-1). Callers whose first child
            is `flex flex-col` then nest cleanly: their `flex-1`
            children get the body's height directly without
            needing an explicit `h-full` (which doesn't propagate
            reliably through flex when there's no explicit pixel
            height anywhere up the tree). */}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
