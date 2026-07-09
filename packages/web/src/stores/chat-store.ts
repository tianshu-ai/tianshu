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

// ── auto-retry backoff ────────────────────────────────────────────
// On a transient run failure (stream_error) or a socket drop that
// orphaned an in-flight stream, we resend the last prompt with
// exponential backoff until it succeeds or the user stops. Doubling
// from 1s, capped at 30 minutes: 1s,2s,4s,…,512s,1024s→capped 1800s.
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30 * 60 * 1_000; // 30 minutes
const RETRY_JITTER = 0.2;

function retryDelayForAttempt(attempt: number): number {
  // attempt is 1-based (1 => first retry).
  const exp = RETRY_BASE_MS * 2 ** (attempt - 1);
  const capped = Math.min(exp, RETRY_MAX_MS);
  const jitter = capped * RETRY_JITTER * Math.random();
  return Math.round(capped + jitter);
}

// If a sent retry doesn't visibly resume (no stream_start) or fail
// (no stream_error) within this window, we treat it as a lost attempt
// and re-arm the next backoff. Covers the case where the socket is
// down and the retry just sits queued, or the server silently drops
// it — without this the loop would stall (the "…" spinner Yu saw).
const RETRY_WATCHDOG_MS = 15_000;

// Module-scoped state (the store is a singleton).
//   retryTimer     — pending backoff before the next retry send.
//   retryWatchdog  — fires if a sent retry neither resumes nor errors.
//   retryAttempt   — monotonically-climbing attempt count. It must NOT
//                    reset on stream_start (a resumed stream can fail
//                    again); only success / stop / fresh prompt reset
//                    it, so the backoff keeps climbing toward the cap.
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryWatchdog: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function clearRetryTimer(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}
function clearRetryWatchdog(): void {
  if (retryWatchdog) {
    clearTimeout(retryWatchdog);
    retryWatchdog = null;
  }
}
/** Fully stop the auto-retry machinery (success / user stop / fresh
 *  prompt). Resets the climbing attempt counter. */
function resetRetryLoop(): void {
  clearRetryTimer();
  clearRetryWatchdog();
  retryAttempt = 0;
}

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
  /** Latest transient LLM-call retry notice. The chat area renders
   *  this as a small "retrying…" banner while a call is being retried
   *  (rate limit / network / expired token). Cleared automatically
   *  when the next stream starts or ends. */
  retryNotice: {
    attempt: number;
    maxAttempts: number;
    kind: string;
    delayMs: number;
    rateLimited: boolean;
    message: string;
    at: number;
  } | null;
  /** Client-side auto-retry loop state. When a run fails transiently
   *  (stream_error) or the socket drops mid-stream, we keep resending
   *  the last prompt with exponential backoff (1s→2s→… capped at
   *  30min) until it succeeds or the user hits stop. `nextRetryAt` is
   *  an epoch ms the banner counts down to; `attempt` is 1-based. */
  autoRetry: {
    active: boolean;
    attempt: number;
    nextRetryAt: number;
    delayMs: number;
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
  /** Last prompt sent, retained so auto-retry can resend it after a
   *  failed / terminated run. Cleared on a successful stream_end. */
  _lastPrompt: { content: string; attachments?: WireAttachment[] } | null;
  /** Set when the user explicitly hits stop/abort, so the failure that
   *  follows is NOT treated as a transient error worth auto-retrying.
   *  Reset on the next user prompt. */
  _userAborted: boolean;
  /** Internal: (re)arm the exponential-backoff auto-retry loop.
   *  `reason` is a short label surfaced in the banner. */
  _beginAutoRetry: (reason: string) => void;

  // actions
  init: () => void;
  toggleSidebar: () => void;
  sendPrompt: (content: string, attachments?: WireAttachment[]) => void;
  /** Stop the auto-retry loop (the "停止 / stop" button). Cancels any
   *  pending backoff and clears the retry state; the last error banner
   *  stays so the user sees what happened. */
  stopAutoRetry: () => void;
  abort: () => void;
  /** Request the next older page. No-op when already loading or
   *  when `hasMoreHistory` is false. */
  loadEarlier: () => void;
  clearStreamError: () => void;
  clearCompactNotice: () => void;
  clearRetryNotice: () => void;
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
  retryNotice: null,
  autoRetry: null,

  preferredModel: loadPreferredModel(),

  sidebarOpen: true,

  viewingSessionId: null,

  _initialized: false,
  _lastPrompt: null,
  _userAborted: false,

  init: () => {
    if (get()._initialized) return;
    set({ _initialized: true });

    // Detect a socket drop that orphaned an in-flight stream (server
    // restart, network blip). The WS layer auto-reconnects; here we
    // kick the auto-retry loop so the interrupted turn resumes.
    tianshuWs.onStatus((status) => {
      if (status !== "closed") return;
      const s = get();
      // Only if a stream was live and the user didn't abort it.
      if (s.isStreaming && !s._userAborted && s._lastPrompt) {
        get()._beginAutoRetry("connection lost");
      }
    });
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
        // Filter to the session the chat shell is currently
        // viewing. The router broadcasts message_added with a
        // `sessionId` field tagged with the channel session id
        // so we ignore messages destined for other threads.
        // Webchat events have no sessionId and apply when we're
        // viewing the webchat thread.
        if (m.sessionId) {
          if (m.sessionId !== s.viewingSessionId) return {} as Partial<ChatState>;
        } else {
          if (s.viewingSessionId !== null) return {} as Partial<ChatState>;
        }
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
        // A turn is actually streaming now — the (re)send worked. Cancel
        // the retry watchdog and hide the "retrying in Ns…" banner. But
        // DON'T reset the climbing attempt counter: this resumed stream
        // can still fail again, and we want the backoff to keep growing
        // rather than snap back to 1s. Only stream_end (success) resets
        // the loop.
        clearRetryWatchdog();
        return {
          isStreaming: true,
          streamError: null,
          retryNotice: null,
          autoRetry: null,
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
        // A successful completion ends the auto-retry loop entirely
        // (cancels timers + resets the climbing attempt counter).
        resetRetryLoop();
        return {
          messages: alreadyHave ? withoutPlaceholder : [...withoutPlaceholder, m.message],
          isStreaming: false,
          // Turn completed successfully; clear transient notices +
          // retained retry-prompt + auto-retry state.
          retryNotice: null,
          autoRetry: null,
          _lastPrompt: null,
        };
      }),
    );
    tianshuWs.on("stream_error", (m) => {
      const s = get();
      // A user-initiated abort is NOT a transient failure — surface it
      // and stop. Everything else (rate limit exhausted after server
      // retries, connection error, terminated) is worth retrying with
      // backoff until the user says stop.
      const isAbort =
        s._userAborted || /abort|cancel|stopped by user/i.test(m.reason);
      // This failure resolved the pending retry send — cancel the
      // watchdog; _beginAutoRetry will arm the next backoff.
      clearRetryWatchdog();
      set((st) => ({
        isStreaming: false,
        streamError: m.reason,
        retryNotice: null,
        messages: st.messages.filter((x) => x.id !== STREAMING_ID),
      }));
      if (!isAbort && s._lastPrompt) {
        get()._beginAutoRetry(m.reason);
      }
    });
    tianshuWs.on("stream_reset", () =>
      set((s) => {
        // A mid-stream retry is rebuilding the answer. Reset the
        // streaming bubble's text to empty (keep the placeholder) so
        // the replay's deltas don't append onto the aborted half.
        const next = s.messages.map((x) =>
          x.id === STREAMING_ID ? { ...x, text: "" } : x,
        );
        return { messages: next };
      }),
    );
    tianshuWs.on("model_retry", (m) =>
      set(() => ({
        retryNotice: {
          attempt: m.attempt,
          maxAttempts: m.maxAttempts,
          kind: m.kind,
          delayMs: m.delayMs,
          rateLimited: m.rateLimited,
          message: m.message,
          at: Date.now(),
        },
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

    tianshuWs.on("tool_catalog_changed", (m) =>
      set((s) => {
        // Fired once per WS connect when the host version drifted
        // since this session was last stamped — typically the
        // server got upgraded while the tab was closed. The agent
        // gets a richer history note on the next prompt via
        // flushToolDeltaForSession; this banner is purely a UI cue.
        const versionPart = m.fromVersion
          ? `${m.fromVersion} → ${m.toVersion}`
          : `now on ${m.toVersion}`;
        const toolsPart =
          m.newTools.length > 0
            ? ` · new: ${m.newTools.map((t) => t.name).join(", ")}`
            : "";
        return {
          messages: [
            ...s.messages,
            {
              id: `tool_catalog_${Date.now()}`,
              sessionId: "",
              role: "system",
              text: `🔄 server updated (${versionPart})${toolsPart}`,
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
    // Fresh user prompt: cancel any in-flight auto-retry loop (timers +
    // attempt counter) and reset the abort flag. Remember the prompt so
    // auto-retry can resume it.
    resetRetryLoop();
    set({
      _lastPrompt: { content: trimmed, attachments },
      _userAborted: false,
      autoRetry: null,
      streamError: null,
    });
    tianshuWs.send({
      type: "prompt",
      content: trimmed,
      modelId,
      ...(hasAttachments ? { attachments } : {}),
    });
  },

  _beginAutoRetry: (reason: string) => {
    // Guard: user stopped, or a stream is already live — don't arm.
    const s0 = get();
    if (s0._userAborted) return;
    // Coalesce: if a backoff is already pending, don't stack another.
    if (retryTimer) return;
    clearRetryWatchdog();

    // Climb the backoff every time we (re)arm — including when a
    // resumed stream failed again. The counter lives in module scope
    // so stream_start (which clears the visible banner) doesn't reset
    // it; only success / stop / fresh prompt do (resetRetryLoop).
    retryAttempt += 1;
    const attempt = retryAttempt;
    const delayMs = retryDelayForAttempt(attempt);
    set({
      autoRetry: {
        active: true,
        attempt,
        delayMs,
        nextRetryAt: Date.now() + delayMs,
      },
      // Keep the error text visible under the retry banner as context.
      streamError: reason,
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const s = get();
      // Bail if the user stopped or a stream is already live.
      if (!s.autoRetry?.active || s.isStreaming) return;
      const modelId = s.preferredModel ?? undefined;
      // Resume the LAST turn in place — do NOT resend a new prompt.
      // The server re-runs the existing user message (dropping the
      // dangling failed turn first), so history keeps exactly one
      // user message no matter how many times we retry. If the socket
      // is still down, ws queues this and flushes on reconnect.
      tianshuWs.send({ type: "retry", ...(modelId ? { modelId } : {}) });
      // Watchdog: if this retry neither resumes (stream_start) nor
      // fails (stream_error) within the window — e.g. still
      // disconnected and just queued, or the server dropped it —
      // re-arm the next backoff so the loop never stalls.
      clearRetryWatchdog();
      retryWatchdog = setTimeout(() => {
        retryWatchdog = null;
        const st = get();
        if (st._userAborted || st.isStreaming || !st.autoRetry?.active) return;
        get()._beginAutoRetry(reason);
      }, RETRY_WATCHDOG_MS);
    }, delayMs);
  },

  stopAutoRetry: () => {
    resetRetryLoop();
    set({ autoRetry: null, _userAborted: true });
  },

  abort: () => {
    // User stop: cancel auto-retry and mark aborted so the resulting
    // stream_error isn't treated as a transient failure.
    resetRetryLoop();
    set({ _userAborted: true, autoRetry: null });
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
  clearRetryNotice: () => set({ retryNotice: null }),

  setPreferredModel: (id) => {
    storePreferredModel(id);
    set({ preferredModel: id });
  },
}));
