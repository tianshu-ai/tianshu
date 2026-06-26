// Tiny zustand store for chat state. Mirrors the shape of the
// closed-source predecessor's chat-store.ts but only carries what the
// minimal v0 UI needs (no channel bindings, no workers — those land
// in later PRs). Sessions are not user-facing: the agent manages
// compact / new-conversation itself (ADR-0001 §5).

import { create } from "zustand";
import { api, type Me, type ModelListEntry } from "../lib/api";
import { tianshuWs } from "../lib/ws";
import type { WireAttachment, WireMessage } from "../types/chat";

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
  /** True iff the server reports older messages exist beyond the
   *  oldest one currently in `messages`. Drives the "Load earlier"
   *  button visibility. False after a successful page that
   *  exhausted the source. */
  hasMoreHistory: boolean;
  /** Token returned by the server identifying the cursor we last
   *  asked from. Used to ignore stale `history_page` responses
   *  (e.g. user clicks Load earlier twice fast). */
  loadingMore: boolean;
  isStreaming: boolean;
  streamError: string | null;
  /** Last "history compacted" notice. The chat area renders this as
   *  an inline banner; user can dismiss to clear. */
  compactNotice: {
    reason: "auto" | "manual";
    summarisedCount: number;
    keptCount: number;
    durationMs: number;
  } | null;

  // model selection — persisted to localStorage so the UI remembers your
  // pick across reloads. The server still uses config.defaultModel as a
  // fallback when no preferredModel is supplied with the prompt.
  preferredModel: string | null;

  // ui chrome
  sidebarOpen: boolean;

  // ── channel session selection ─────────────────────────────────────
  /** When non-null, `messages` shows the history of this session
   *  rather than the main webchat thread. Channel plugins
   *  (wechat / telegram / ...) flip this via the plugin-sdk
   *  useChatNav hook from their sidebar sections. The composer
   *  disables itself in this mode because channel sessions are
   *  driven by inbound platform messages, not user-typed prompts. */
  viewingSessionId: string | null;

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
  sendPrompt: (content: string, attachments?: WireAttachment[]) => void;
  abort: () => void;
  /** Request the next older page. No-op when already loading or
   *  when `hasMoreHistory` is false. */
  loadEarlier: () => void;
  clearStreamError: () => void;
  clearCompactNotice: () => void;
  setPreferredModel: (id: string | null) => void;
  /** Pin the chat area to a specific session id. Pass `null` to
   *  return to the main webchat thread. Channel plugins drive
   *  this from their sidebar sections via the plugin-sdk
   *  useChatNav hook; nothing in the host UI calls it directly. */
  selectSession: (sessionId: string | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  me: null,
  models: [],
  meError: null,

  messages: [],
  hasMoreHistory: false,
  loadingMore: false,
  isStreaming: false,
  streamError: null,
  compactNotice: null,

  preferredModel: loadPreferredModel(),

  sidebarOpen: true,

  viewingSessionId: null,

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
      .then(({ models }) => {
        set({ models });
        // Reconcile preferredModel against the freshly loaded
        // catalog. localStorage may hold an id from a previous
        // session against a different tenant; that id won't be
        // in the current catalog and would otherwise cause
        // ModelSelector to show a name nobody can pick, plus the
        // first prompt would go out with a dangling modelId
        // (server then quietly picks its own fallback — user
        // thinks they were chatting with X but were actually on
        // Y). Caught 2026-06-21 on a tenant with only qwen but a
        // preferredModel still pointing at the global default.
        const current = get().preferredModel;
        if (current && !models.some((m) => m.id === current)) {
          storePreferredModel(null);
          set({ preferredModel: null });
        }
      })
      .catch(() => {
        /* best-effort; UI degrades to "—" */
      });

    tianshuWs.connect();
    // History fetch as soon as we're connected. We pin to
    // `viewingSessionId` when set so a deep-link to a channel
    // session paints the right thread on first paint.
    tianshuWs.on("connected", () => {
      const sid = get().viewingSessionId;
      tianshuWs.send(
        sid ? { type: "history", sessionId: sid } : { type: "history" },
      );
    });
    tianshuWs.on("history", (m) =>
      set({ messages: m.messages, hasMoreHistory: m.hasMore, loadingMore: false }),
    );
    tianshuWs.on("history_page", (m) =>
      set((s) => {
        // Drop server-side dupes (a refresh + concurrent load_earlier
        // can race). The server returns oldest-first; we prepend.
        const existing = new Set(s.messages.map((x) => x.id));
        const fresh = m.messages.filter((x) => !existing.has(x.id));
        return {
          messages: [...fresh, ...s.messages],
          hasMoreHistory: m.hasMore,
          loadingMore: false,
        };
      }),
    );
    tianshuWs.on("message_added", (m) =>
      set((s) => {
        // Defensive de-dupe: a re-registered handler (e.g. across HMR
        // boundaries that don't re-run our cleanup) could fire twice for
        // the same message id. We never want to render the same row
        // twice.
        if (s.messages.some((x) => x.id === m.message.id)) return {} as Partial<ChatState>;
        // When the server pushes a finalised assistant turn that
        // arrived via `message_added` (multi-turn agents emit one
        // such message per intermediate tool-use turn), drop any
        // streaming placeholder that's still hanging around so its
        // accumulated deltas don't double the next turn's first
        // message. The placeholder was visually replaced by the
        // streamed text already, but stream_end never fires between
        // turns — only at the end of the whole run — so without this
        // sweep the placeholder keeps accreting deltas from turn 2+.
        const withoutPlaceholder = s.messages.filter((x) => x.id !== STREAMING_ID);
        return { messages: [...withoutPlaceholder, m.message] };
      }),
    );
    tianshuWs.on("stream_start", () =>
      set((s) => {
        // The server emits one stream_start per *user prompt*, not
        // per LLM turn. Multi-turn agent runs (turn 1 → toolUse →
        // turn 2 → …) reuse the same placeholder for every text
        // segment, so always start a fresh empty placeholder on
        // stream_start — there should never be a pre-existing one
        // because the previous run ended with stream_end / error.
        // Stale placeholders (e.g. HMR) get cleaned up here too.
        const withoutStale = s.messages.filter((x) => x.id !== STREAMING_ID);
        return {
          isStreaming: true,
          streamError: null,
          messages: [
            ...withoutStale,
            {
              id: STREAMING_ID,
              sessionId: "",
              role: "assistant",
              text: "",
              createdAt: Date.now(),
            },
          ],
        };
      }),
    );
    tianshuWs.on("stream_delta", (m) =>
      set((s) => {
        // No placeholder yet? This is the first delta of an
        // intermediate turn (the server doesn't send stream_start
        // between toolUse turns). Spawn a fresh placeholder so the
        // text has somewhere to land instead of getting silently
        // dropped or, worse, glued onto the previous turn's text.
        let next = s.messages;
        let idx = next.findIndex((x) => x.id === STREAMING_ID);
        if (idx < 0) {
          next = [
            ...next,
            {
              id: STREAMING_ID,
              sessionId: "",
              role: "assistant",
              text: "",
              createdAt: Date.now(),
            },
          ];
          idx = next.length - 1;
        } else {
          next = next.slice();
        }
        next[idx] = { ...next[idx]!, text: next[idx]!.text + m.delta };
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
    tianshuWs.on("history_compacted", (m) =>
      set({
        compactNotice: {
          reason: m.reason,
          summarisedCount: m.summarisedCount,
          keptCount: m.keptCount,
          durationMs: m.durationMs,
        },
      }),
    );
    tianshuWs.on("plugins_changed", (m) =>
      set((s) => {
        // Drop a compact notice line into the visible chat so the
        // user can see what the agent just learned about. The
        // agent itself gets a richer system message via the server
        // (see renderPluginsChangedNote in packages/server/src/index.ts).
        const parts: string[] = [];
        for (const d of m.enabled ?? []) {
          parts.push(`+ ${d.displayName} enabled`);
        }
        for (const d of m.disabled ?? []) {
          parts.push(`− ${d.displayName} disabled`);
        }
        if (parts.length === 0) return {} as Partial<ChatState>;
        return {
          messages: [
            ...s.messages,
            {
              id: `plugin_change_${Date.now()}`,
              sessionId: "",
              role: "system",
              text: `⛯ plugin: ${parts.join(", ")}`,
              createdAt: Date.now(),
            },
          ],
        };
      }),
    );
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

  selectSession: (sessionId) => {
    set({
      viewingSessionId: sessionId,
      messages: [],
      hasMoreHistory: false,
      loadingMore: false,
      streamError: null,
      compactNotice: null,
    });
    // Re-pull history for the new target. Server returns oldest
    // page by default; client paginates back via history_more.
    tianshuWs.send(
      sessionId
        ? { type: "history", sessionId }
        : { type: "history" },
    );
  },

  sendPrompt: (content: string, attachments?: WireAttachment[]) => {
    const trimmed = content.trim();
    const hasAttachments = attachments && attachments.length > 0;
    // Allow empty text when attachments are present ("look at this")
    // — the server side accepts that shape.
    if (!trimmed && !hasAttachments) return;
    if (get().isStreaming) return;
    const modelId = get().preferredModel ?? undefined;
    tianshuWs.send({
      type: "prompt",
      content: trimmed,
      modelId,
      ...(hasAttachments ? { attachments } : {}),
    });
  },

  abort: () => {
    tianshuWs.send({ type: "abort" });
  },

  loadEarlier: () => {
    const s = get();
    if (s.loadingMore || !s.hasMoreHistory || s.messages.length === 0) return;
    const before = s.messages[0]?.id;
    if (!before) return;
    set({ loadingMore: true });
    tianshuWs.send(
      s.viewingSessionId
        ? { type: "history_more", before, sessionId: s.viewingSessionId }
        : { type: "history_more", before },
    );
  },

  clearStreamError: () => set({ streamError: null }),
  clearCompactNotice: () => set({ compactNotice: null }),

  setPreferredModel: (id) => {
    storePreferredModel(id);
    set({ preferredModel: id });
  },
}));
