// Tiny zustand store for chat state. Mirrors the shape of the
// closed-source predecessor's chat-store.ts but only carries what the
// minimal v0 UI needs (no sessions list, no channel bindings, no
// workers — those land in later PRs).

import { create } from "zustand";
import { api, type Me, type ModelListEntry } from "../lib/api";
import { tianshuWs } from "../lib/ws";
import type { WireMessage } from "../types/chat";

const STREAMING_ID = "__streaming__";

interface ChatState {
  // identity / branding
  me: Me | null;
  models: ModelListEntry[];
  meError: string | null;

  // conversation
  messages: WireMessage[];
  isStreaming: boolean;
  streamError: string | null;

  // ui chrome
  sidebarOpen: boolean;

  // actions
  init: () => void;
  toggleSidebar: () => void;
  sendPrompt: (content: string) => void;
  abort: () => void;
  clearStreamError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  me: null,
  models: [],
  meError: null,

  messages: [],
  isStreaming: false,
  streamError: null,

  sidebarOpen: true,

  init: () => {
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
      set((s) => ({ messages: [...s.messages, m.message] })),
    );
    tianshuWs.on("stream_start", () =>
      set((s) => ({
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
      })),
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
        const idx = s.messages.findIndex((x) => x.id === STREAMING_ID);
        if (idx < 0) return { isStreaming: false };
        const next = s.messages.slice();
        next[idx] = m.message;
        return { messages: next, isStreaming: false };
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
    tianshuWs.send({ type: "prompt", content: trimmed });
  },

  abort: () => {
    tianshuWs.send({ type: "abort" });
  },

  clearStreamError: () => set({ streamError: null }),
}));
