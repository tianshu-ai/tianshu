// Tiny zustand store for chat state. Mirrors the shape of the
// closed-source predecessor's chat-store.ts but only carries what the
// minimal v0 UI needs (no channel bindings, no workers — those land
// in later PRs). Sessions are not user-facing: the agent manages
// compact / new-conversation itself (ADR-0001 §5).

import { create } from "zustand";
import { api, type Me, type ModelListEntry } from "../lib/api";
import { tianshuWs } from "../lib/ws";
import type { WireMessage } from "../types/chat";

const STREAMING_ID = "__streaming__";

const PREFERRED_MODEL_KEY = "tianshu.preferredModel";

function loadPreferredModel(): string | null {
  try {
    return localStorage.getItem(PREFERRED_MODEL_KEY);
  } catch {
    return null;
  }
}
function storePreferredModel(id: string | null): void {
  try {
    if (id) localStorage.setItem(PREFERRED_MODEL_KEY, id);
    else localStorage.removeItem(PREFERRED_MODEL_KEY);
  } catch {
    /* swallow */
  }
}

interface ChatState {
  // identity / branding
  me: Me | null;
  models: ModelListEntry[];
  meError: string | null;

  // conversation
  messages: WireMessage[];
  isStreaming: boolean;
  streamError: string | null;

  // model selection — persisted to localStorage so the UI remembers your
  // pick across reloads. The server still uses config.defaultModel as a
  // fallback when no preferredModel is supplied with the prompt.
  preferredModel: string | null;

  // ui chrome
  sidebarOpen: boolean;

  // ── internal ──
  /**
   * Tracks whether init() has registered its singleton WS handlers /
   * REST bootstrapping. React 19's StrictMode double-invokes effects in
   * development which would otherwise leave us with two handlers per
   * event type — every history/stream_delta/etc. would be processed
   * twice and the UI would render duplicates and interleaved deltas.
   */
  _initialized: boolean;

  // actions
  init: () => void;
  toggleSidebar: () => void;
  sendPrompt: (content: string) => void;
  abort: () => void;
  clearStreamError: () => void;
  setPreferredModel: (id: string | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  me: null,
  models: [],
  meError: null,

  messages: [],
  isStreaming: false,
  streamError: null,

  preferredModel: loadPreferredModel(),

  sidebarOpen: true,

  _initialized: false,

  init: () => {
    if (get()._initialized) return;
    set({ _initialized: true });
    api
      .me()
      .then((me) => set({ me }))
      .catch((e: unknown) =>
        set({ meError: e instanceof Error ? e.message : String(e) }),
      );
    api
      .models()
      .then(({ models }) => set({ models }))
      .catch(() => {
        /* best-effort; UI degrades to "—" */
      });

    tianshuWs.connect();
    // History fetch as soon as we're connected.
    tianshuWs.on("connected", () => tianshuWs.send({ type: "history" }));
    tianshuWs.on("history", (m) => set({ messages: m.messages }));
    tianshuWs.on("message_added", (m) =>
      set((s) => {
        // Defensive de-dupe: a re-registered handler (e.g. across HMR
        // boundaries that don't re-run our cleanup) could fire twice for
        // the same message id. We never want to render the same row
        // twice.
        if (s.messages.some((x) => x.id === m.message.id)) return {} as Partial<ChatState>;
        return { messages: [...s.messages, m.message] };
      }),
    );
    tianshuWs.on("stream_start", () =>
      set((s) => {
        // If a streaming placeholder is already present (e.g. server
        // emitted stream_start twice, or HMR), reuse it rather than
        // stacking another one — deltas only target the first match.
        if (s.messages.some((x) => x.id === STREAMING_ID)) {
          return { isStreaming: true, streamError: null };
        }
        return {
          isStreaming: true,
          streamError: null,
          messages: [
            ...s.messages,
            {
              id: STREAMING_ID,
              sessionId: "",
              role: "assistant",
              content: "",
              createdAt: Date.now(),
            },
          ],
        };
      }),
    );
    tianshuWs.on("stream_delta", (m) =>
      set((s) => {
        const idx = s.messages.findIndex((x) => x.id === STREAMING_ID);
        if (idx < 0) return {} as Partial<ChatState>;
        const next = s.messages.slice();
        next[idx] = { ...next[idx]!, content: next[idx]!.content + m.delta };
        return { messages: next };
      }),
    );
    tianshuWs.on("stream_end", (m) =>
      set((s) => {
        // Drop the streaming placeholder, then append the persisted
        // message — unless we already saw an earlier message_added with
        // the same id (paranoia for re-registered handlers).
        const withoutPlaceholder = s.messages.filter((x) => x.id !== STREAMING_ID);
        const alreadyHave = withoutPlaceholder.some((x) => x.id === m.message.id);
        return {
          messages: alreadyHave ? withoutPlaceholder : [...withoutPlaceholder, m.message],
          isStreaming: false,
        };
      }),
    );
    tianshuWs.on("stream_error", (m) =>
      set((s) => ({
        isStreaming: false,
        streamError: m.reason,
        messages: s.messages.filter((x) => x.id !== STREAMING_ID),
      })),
    );
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  sendPrompt: (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (get().isStreaming) return;
    const modelId = get().preferredModel ?? undefined;
    tianshuWs.send({ type: "prompt", content: trimmed, modelId });
  },

  abort: () => {
    tianshuWs.send({ type: "abort" });
  },

  clearStreamError: () => set({ streamError: null }),

  setPreferredModel: (id) => {
    storePreferredModel(id);
    set({ preferredModel: id });
  },
}));
