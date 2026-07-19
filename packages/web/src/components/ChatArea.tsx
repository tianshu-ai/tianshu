import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Puzzle, RotateCw } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import MessageBubble from "./MessageBubble";
import { mergeToolTurns } from "../lib/merge-tool-turns";
import ChatInput from "./ChatInput";
import ModelSelector from "./ModelSelector";
import PluginManager from "./PluginManager";
import PluginTopBarButtons from "./PluginTopBarButtons";
import { useT } from "../hooks/useT";

/**
 * Main column.
 *
 *   - h-12 top bar with sidebar toggle on the left, identity strip in
 *     the middle
 *   - scrolling message list (max-w-3xl)
 *   - composer at the bottom
 *
 * The top bar's right side is **manifest-driven**: each active
 * plugin's `contributes.topBarButtons` becomes a button here, and
 * clicking one toggles the matching `rightPanels` entry in the
 * column rendered by ChatLayout. The Plugin Manager itself is part
 * of the bundled chat shell (per ADR-0003) and stays put.
 */
export default function ChatArea() {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const me = useChatStore((s) => s.me);
  const viewingSessionId = useChatStore((s) => s.viewingSessionId);
  const sidebarOpen = useChatStore((s) => s.sidebarOpen);
  const toggleSidebar = useChatStore((s) => s.toggleSidebar);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamError = useChatStore((s) => s.streamError);
  const clearStreamError = useChatStore((s) => s.clearStreamError);
  const autoRetry = useChatStore((s) => s.autoRetry);
  const stopAutoRetry = useChatStore((s) => s.stopAutoRetry);
  const compactNotice = useChatStore((s) => s.compactNotice);
  const clearCompactNotice = useChatStore((s) => s.clearCompactNotice);
  const retryNotice = useChatStore((s) => s.retryNotice);
  const clearRetryNotice = useChatStore((s) => s.clearRetryNotice);
  const hasMoreHistory = useChatStore((s) => s.hasMoreHistory);
  const loadingMore = useChatStore((s) => s.loadingMore);
  const loadEarlier = useChatStore((s) => s.loadEarlier);

  const bottomRef = useRef<HTMLDivElement>(null);
  // Track the previous last-message id so we can tell "new tail
  // arrived" (auto-scroll) apart from "older page prepended"
  // (do nothing — the user just clicked Load earlier and would
  // be confused if we yanked them back to the bottom).
  const prevLastIdRef = useRef<string | null>(null);
  useEffect(() => {
    const lastId = messages.length > 0 ? messages[messages.length - 1].id : null;
    if (lastId && lastId !== prevLastIdRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevLastIdRef.current = lastId;
  }, [messages]);

  const [pluginManagerOpen, setPluginManagerOpen] = useState(false);

  const brand = me?.config.branding;
  const brandName = brand?.name ?? "Tianshu";
  const brandEmoji = brand?.emoji ?? "⭐";
  const empty = messages.length === 0;

  // Merge tool-result rows into their owning assistant turn ONCE per
  // change to `messages`. Without this memo the whole transcript is
  // walked twice + rebuilt into fresh objects on every render — and
  // during streaming that's once per token, which also defeats the
  // React.memo on MessageBubble (every child would get new props).
  const merged = useMemo(() => mergeToolTurns(messages), [messages]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <header className="flex h-12 items-center justify-between border-b border-border-subtle bg-bg-elevated/50 px-4 backdrop-blur">
        <div className="flex items-center">
          <button
            type="button"
            onClick={toggleSidebar}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
            title={sidebarOpen ? t("chat.hideSidebar") : t("chat.showSidebar")}
          >
            {sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <h1 className="ml-3 text-sm font-medium text-fg-muted">main</h1>
          <span className="ml-3 text-[11px] text-fg-faint">
            tenant <span className="text-fg-muted">{me?.tenantId ?? "…"}</span> · user{" "}
            <span className="text-fg-muted">{me?.displayName ?? me?.userId ?? "…"}</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <PluginTopBarButtons />
          <button
            type="button"
            onClick={() => setPluginManagerOpen(true)}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
            title={t("chat.pluginManager")}
            aria-label={t("chat.openPluginManager")}
          >
            <Puzzle size={16} />
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {empty ? (
          <EmptyState
            brandName={brandName}
            brandEmoji={brandEmoji}
            tenantId={me?.tenantId ?? "default"}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {hasMoreHistory && (
              // "Load earlier" button at the top of the transcript.
              // Server-paginated: clicking sends `history_more` with
              // the oldest current message id as cursor; the
              // returned page is prepended in chat-store.
              <button
                type="button"
                onClick={loadEarlier}
                disabled={loadingMore}
                className="w-full rounded-lg bg-bg-raised/50 py-2 text-xs text-fg-faint hover:text-fg-muted disabled:cursor-default disabled:opacity-60"
              >
                {loadingMore ? t("chat.loading") : t("chat.loadEarlier")}
              </button>
            )}
            {merged.map((m, i) => (
              <div key={m.id} className={i === 0 ? "" : "mt-4"}>
                <MessageBubble m={m} />
              </div>
            ))}
            {/* No "streaming…" label here — the streaming bubble
             *  itself shows incoming text or a typing indicator,
             *  which is visual enough. */}
            {autoRetry?.active ? (
              <AutoRetryBanner
                attempt={autoRetry.attempt}
                nextRetryAt={autoRetry.nextRetryAt}
                reason={streamError}
                onStop={stopAutoRetry}
              />
            ) : (
              streamError && (
                <div className="flex items-center justify-between rounded-md border border-rose-700/50 bg-rose-950/40 px-3 py-2 text-sm text-danger">
                  <span className="truncate">{streamError}</span>
                  <button
                    type="button"
                    onClick={clearStreamError}
                    className="ml-3 flex-none text-[11px] uppercase tracking-wider text-rose-300/80 hover:text-white"
                  >
                    dismiss
                  </button>
                </div>
              )
            )}
            {retryNotice && (
              <div className="flex items-center justify-between rounded-md border border-sky-700/40 bg-sky-950/30 px-3 py-2 text-sm text-sky-200">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-sky-400" />
                  <span className="truncate">
                    {retryNotice.rateLimited ? "⏳" : "🔁"}{" "}
                    {retryNotice.rateLimited
                      ? t("chat.rateLimited")
                      : retryNotice.kind === "http-401" || retryNotice.kind === "http-403"
                        ? t("chat.authExpired")
                        : t("chat.connectionIssue")}
                    {t("chat.retryIn", {
                      s: (retryNotice.delayMs / 1000).toFixed(retryNotice.delayMs < 1000 ? 1 : 0),
                      a: retryNotice.attempt,
                      max: retryNotice.maxAttempts,
                    })}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={clearRetryNotice}
                  className="ml-3 text-[11px] uppercase tracking-wider text-sky-300/80 hover:text-white"
                >
                  {t("chat.dismiss")}
                </button>
              </div>
            )}
            {compactNotice && (
              <div className="flex items-center justify-between rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
                <span className="truncate">
                  {t("chat.compacted", {
                    mode:
                      compactNotice.reason === "auto"
                        ? t("chat.compactAuto")
                        : t("chat.compactManual"),
                    summarised: compactNotice.summarisedCount,
                    kept: compactNotice.keptCount,
                  })}
                </span>
                <button
                  type="button"
                  onClick={clearCompactNotice}
                  className="ml-3 text-[11px] uppercase tracking-wider text-amber-300/80 hover:text-white"
                >
                  {t("chat.dismiss")}
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {viewingSessionId === null ? (
        <ChatInput />
      ) : (
        <ChannelSessionFooter sessionId={viewingSessionId} />
      )}

      <PluginManager
        open={pluginManagerOpen}
        onClose={() => setPluginManagerOpen(false)}
      />
    </main>
  );
}

function EmptyState({
  brandName,
  brandEmoji,
  tenantId,
}: {
  brandName: string;
  brandEmoji: string;
  tenantId: string;
}) {
  const t = useT();
  void tenantId;
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-600/20">
        <span className="text-2xl">{brandEmoji}</span>
      </div>
      <h2 className="mb-2 text-xl font-semibold text-fg-default">
        {t("chat.welcome", { name: brandName })}
      </h2>
      <p className="max-w-md text-sm text-fg-faint">{t("chat.welcomeBody")}</p>
    </div>
  );
}

/**
 * Footer rendered below ChatArea when the user is viewing a
 * channel session. Two roles:
 *   1. Surface "this thread is read-only" so the missing composer
 *      doesn't look like a bug.
 *   2. Let the user retarget the model the agent uses to reply to
 *      THIS binding. The selector reads + writes the binding row
 *      via `/api/channel-bindings/:id/model` so future inbound
 *      messages route to the new LLM. Per-binding because two
 *      channel accounts (personal vs work wechat, say) want
 *      different models.
 */
function ChannelSessionFooter({ sessionId }: { sessionId: string }) {
  const t = useT();
  // Lazy-load binding row keyed on the session: we need its
  // current modelId for the dropdown highlight and its id to PATCH.
  const [binding, setBinding] = useState<{
    id: string;
    modelId: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(
          `/api/channel-sessions/${encodeURIComponent(sessionId)}/binding`,
          { credentials: "include" },
        );
        if (!r.ok) return;
        const body = (await r.json()) as {
          binding?: { id: string; modelId: string | null };
        };
        if (cancelled) return;
        setBinding(body.binding ?? null);
      } catch {
        /* best-effort; selector hides if we can't load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const onChange = async (modelId: string) => {
    if (!binding) return;
    setBinding({ ...binding, modelId });
    try {
      await fetch(`/api/channel-bindings/${encodeURIComponent(binding.id)}/model`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
    } catch {
      /* user feedback handled by next refresh; silent best-effort */
    }
  };

  // Two-row layout: model picker centered up top, short read-only
  // notice below. The previous flex-between layout looked sparse on
  // wide screens (text on the far left, picker on the far right);
  // stacking + centering both keeps them visually grouped.
  return (
    <div className="flex flex-col items-center gap-1 border-t border-border-subtle bg-bg-elevated px-4 py-2.5">
      {binding && (
        <div className="flex items-center gap-1.5 text-[11px] text-fg-faint">
          <span>{t("chat.model")}</span>
          <ModelSelector value={binding.modelId} onChange={onChange} />
        </div>
      )}
      <span className="text-[10.5px] text-fg-fainter">
        {t("chat.readOnlyChannel")}
      </span>
    </div>
  );
}

/**
 * Auto-retry banner. Shown while the client is retrying a failed /
 * interrupted run with exponential backoff. Counts down to the next
 * attempt and offers a Stop button. The countdown is derived from
 * `nextRetryAt` (epoch ms) and ticks locally once a second.
 */
function AutoRetryBanner({
  attempt,
  nextRetryAt,
  reason,
  onStop,
}: {
  attempt: number;
  nextRetryAt: number;
  reason: string | null;
  onStop: () => void;
}) {
  const tr = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(iv);
  }, []);
  const remainingMs = Math.max(0, nextRetryAt - now);
  const remaining = formatRemaining(remainingMs);
  return (
    <div className="flex items-center justify-between rounded-md border border-amber-700/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
      <span className="flex min-w-0 items-center gap-2">
        <RotateCw className="h-3.5 w-3.5 flex-none animate-spin text-amber-300" style={{ animationDuration: "2s" }} />
        <span className="truncate">
          {tr("chat.connectionInterrupted")}
          {reason ? ` (${reason})` : ""}
          {tr("chat.retryInShort", { remaining, a: attempt })}
        </span>
      </span>
      <button
        type="button"
        onClick={onStop}
        className="ml-3 flex-none rounded border border-amber-400/40 px-2 py-0.5 text-[11px] uppercase tracking-wider text-amber-100 hover:bg-amber-400/10 hover:text-white"
      >
        {tr("chat.stopLower")}
      </button>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}
