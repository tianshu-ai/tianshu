// Composer state store.
//
// Holds the staged-attachments list + the registered draft transforms
// so plugin components (anywhere in the tree) and the ChatInput share
// a single source of truth.
//
// We keep this in zustand rather than a plain React context because
// (a) plugin components and the ChatInput live in unrelated subtrees
//     under ChatLayout, and re-rendering them coherently from a
//     context provider further up requires careful memoisation;
// (b) `submitWithTransforms()` and `disableSend` are called from
//     non-React code paths (the chat-store action that ultimately
//     runs WebSocket sends), and a hook-free getter is convenient.

import { create } from "zustand";
import type {
  Attachment,
  ComposerApi,
  DraftTransform,
} from "@tianshu-ai/plugin-sdk/client";

interface ComposerState {
  attachments: Attachment[];
  /** Registered draft transforms in registration order. */
  transforms: DraftTransform[];
  /** Monotonic counter for attachment ids. Reset on clearAll(). */
  _nextId: number;

  // ── mutations exposed via the public API ──
  addAttachment: (a: Omit<Attachment, "id">) => string;
  updateAttachment: (
    id: string,
    patch: Partial<Omit<Attachment, "id">>,
  ) => void;
  removeAttachment: (id: string) => void;
  registerDraftTransform: (fn: DraftTransform) => () => void;

  // ── helpers used by ChatInput ──
  clearAll: () => void;
  /**
   * True if the composer should refuse to send because at least one
   * attachment has not finished uploading. Errored attachments do
   * **not** block — the user can remove them or send anyway.
   */
  hasPending: () => boolean;
  /**
   * Run the user's draft text through all registered transforms in
   * order. Returns the final text. Skips transforms when there are
   * no attachments AND no transforms (fast path).
   */
  applyTransforms: (text: string) => Promise<string>;
}

function shortId(n: number): string {
  return `att-${n.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const useComposerStore = create<ComposerState>((set, get) => ({
  attachments: [],
  transforms: [],
  _nextId: 1,

  addAttachment: (a) => {
    const n = get()._nextId;
    const id = shortId(n);
    set((s) => ({
      _nextId: s._nextId + 1,
      attachments: [...s.attachments, { ...a, id }],
    }));
    return id;
  },

  updateAttachment: (id, patch) =>
    set((s) => {
      const idx = s.attachments.findIndex((a) => a.id === id);
      if (idx < 0) return {};
      const next = s.attachments.slice();
      next[idx] = { ...next[idx]!, ...patch };
      return { attachments: next };
    }),

  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),

  registerDraftTransform: (fn) => {
    // Idempotent: don't double-register the same fn (e.g. across HMR
    // re-runs of a plugin's effect).
    set((s) =>
      s.transforms.includes(fn) ? {} : { transforms: [...s.transforms, fn] },
    );
    return () => {
      set((s) => ({ transforms: s.transforms.filter((t) => t !== fn) }));
    };
  },

  clearAll: () => set({ attachments: [] }),

  hasPending: () => get().attachments.some((a) => a.status === "uploading"),

  applyTransforms: async (text) => {
    const { transforms, attachments } = get();
    if (transforms.length === 0) return text;
    // Only pass ready attachments to transforms — errored ones the
    // user explicitly chose to ignore by sending. We deliberately
    // include them only via the hasPending() gate, not the payload.
    const ready = attachments.filter((a) => a.status === "ready");
    let acc = text;
    for (const t of transforms) {
      acc = await t(acc, ready);
    }
    return acc;
  },
}));

/** Stable accessor that mirrors `ComposerApi` for `useComposer()`. */
export function getComposerApi(): ComposerApi {
  const s = useComposerStore.getState();
  return {
    get attachments() {
      return useComposerStore.getState().attachments;
    },
    addAttachment: s.addAttachment,
    updateAttachment: s.updateAttachment,
    removeAttachment: s.removeAttachment,
    registerDraftTransform: s.registerDraftTransform,
  };
}
