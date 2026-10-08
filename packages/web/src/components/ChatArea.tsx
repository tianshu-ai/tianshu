import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BrainCircuit, Database, FileText, FolderOpen, Globe, Headphones,
  LayoutDashboard, MessageSquare, PanelLeftClose, PanelLeftOpen,
  Puzzle, RotateCw, Search, Settings, Stethoscope, Timer, Wrench, X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { useChatStore } from "../stores/chat-store";
import MessageBubble from "./MessageBubble";
import { InteractionButtons } from "./InteractionButtons";
import { mergeToolTurns } from "../lib/merge-tool-turns";
import ChatInput from "./ChatInput";
import ModelSelector from "./ModelSelector";
import PluginManager from "./PluginManager";
import PluginTopBarButtons from "./PluginTopBarButtons";
import { usePluginStore } from "../stores/plugin-store";
import VoiceSubtitleView from "./VoiceSubtitleView";
import { useT } from "../hooks/useT";
import { useVoiceMode } from "../hooks/useVoiceMode";
import { useAutoSpeakReplies } from "../hooks/useAutoSpeakReplies";

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
  // Voice mode: when on, assistant replies are also spoken via /api/tts.
  // The toggle lives in this component's header; the auto-speak side
  // effect subscribes to chat store and fires speak() per new assistant
  // reply. Both are per-device localStorage-backed, not tenant config.
  const { enabled: voiceEnabled, toggle: toggleVoice } = useVoiceMode();
  useAutoSpeakReplies();
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

  // ?prompt= auto-send: fire once when the page loads with a prompt query param
  // (used by the welcome screen's "go to maintenance" button).
  const promptSentRef = useRef(false);
  useEffect(() => {
    if (promptSentRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const prompt = params.get("prompt");
    if (!prompt) return;
    promptSentRef.current = true;
    // Clean URL without reload
    params.delete("prompt");
    const clean = params.toString();
    const next = window.location.pathname + (clean ? `?${clean}` : "");
    window.history.replaceState(null, "", next);
    // Wait for WS to be ready before sending
    const id = window.setTimeout(() => {
      useChatStore.getState().sendPrompt(prompt);
    }, 500);
    return () => window.clearTimeout(id);
  }, []);

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

  // Voice mode: swap ChatArea for the big-font subtitle view. Yu
  // 2026-09-20 01:02: "conversation 区域最好改成字幕模式". The
  // subtitle view has its own composer inside so we return early
  // without the normal top bar / message list.
  if (voiceEnabled) {
    return <VoiceSubtitleView />;
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <header className="flex h-12 items-center justify-between border-b border-border-subtle/30 px-4">
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
          <span className="ml-3 text-xs text-fg-faint">
            {me?.tenantId && me.tenantId !== "default" && (
              <>tenant <span className="text-fg-muted">{me.tenantId}</span> · </>
            )}
            user <span className="text-fg-muted">{me?.displayName ?? me?.userId ?? "…"}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          {me?.tenantId !== "maintenance" && <PluginTopBarButtons />}
          {/* Yu 2026-09-20 14:06: 右上角 button 显示"下一个模式"
              的 icon。键盘模式时 → Headphones（下一个=语音）。
              语音模式时本 ChatArea 根本不渲染（被
              VoiceSubtitleView 接管），那里的按钮显 Keyboard。 */}
          <button
            type="button"
            onClick={toggleVoice}
            className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
            title="切换到语音模式"
            aria-label="Switch to voice mode"
          >
            <Headphones size={16} />
          </button>
          {me?.tenantId !== "maintenance" && (
            <button
              type="button"
              onClick={() => setPluginManagerOpen(true)}
              className="rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-bg-raised hover:text-fg-default"
              title={t("chat.pluginManager")}
              aria-label={t("chat.openPluginManager")}
            >
              <Puzzle size={16} />
            </button>
          )}
        </div>
      </header>

      {/* Maintenance mode banner — shown when in maintenance tenant */}
      {me?.tenantId === "maintenance" && (
        <MaintenanceBanner userId={me?.userId} />
      )}

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {empty ? (
          <EmptyState
            brandName={brandName}
            brandEmoji={brandEmoji}
            tenantId={me?.tenantId ?? "default"}
          />
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
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
            {/* ask_user interaction buttons */}
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
                    className="ml-3 flex-none text-xs uppercase tracking-wider text-rose-300/80 hover:text-white"
                  >
                    {t("chat.dismiss")}
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
                  className="ml-3 text-xs uppercase tracking-wider text-sky-300/80 hover:text-white"
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
                  className="ml-3 text-xs uppercase tracking-wider text-amber-300/80 hover:text-white"
                >
                  {t("chat.dismiss")}
                </button>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* ask_user interaction buttons — pinned above the composer
         so they're always visible regardless of scroll position */}
      <InteractionButtons />
      {viewingSessionId === null ? (
        <ChatInput />
      ) : (
        <ChannelSessionFooter sessionId={viewingSessionId} />
      )}

      {me?.tenantId !== "maintenance" && (
        <PluginManager
          open={pluginManagerOpen}
          onClose={() => setPluginManagerOpen(false)}
        />
      )}
    </main>
  );
}

/**
 * Maintenance-mode banner with the "System Doctor" toggle and
 * an exit button. Renders the Stethoscope button inline so
 * PluginTopBarButtons (hidden in maintenance) isn't needed.
 */
function MaintenanceBanner({ userId }: { userId?: string }) {
  const t = useT();
  const openPanel = usePluginStore((s) => s.openPanel);
  const setOpenPanel = usePluginStore((s) => s.setOpenPanel);
  const isDoctorOpen = openPanel === "doctor.main";

  return (
    <div className="flex items-center justify-between border-b border-amber-500/30 bg-amber-500/10 px-4 py-2">
      <div className="flex items-center gap-2 text-sm text-amber-400">
        <Wrench size={14} className="flex-shrink-0" />
        <span className="font-medium">{t("chat.maintenanceMode")}</span>
        <span className="text-xs text-amber-400/70">{t("chat.maintenanceHint")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpenPanel(isDoctorOpen ? null : "doctor.main")}
          className={[
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
            isDoctorOpen
              ? "bg-amber-500/30 text-amber-200"
              : "text-amber-400 hover:bg-amber-500/20",
          ].join(" ")}
          title="System Doctor"
        >
          <Stethoscope size={12} />
          <span>Doctor</span>
        </button>
        <button
          type="button"
          onClick={async () => {
            try { await api.switchTenant("default"); } catch { /* ignore */ }
            window.location.assign(`/tenants/default/users/${userId ?? "admin"}`);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-amber-400 transition-colors hover:bg-amber-500/20"
        >
          <X size={12} />
          <span>{t("chat.exitMaintenance")}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Plugin → starter prompt mapping.
 * Order = display priority (first match wins when we pick top 4).
 */
const PLUGIN_STARTERS: {
  pluginId: string;
  icon: LucideIcon;
  zh: string;
  en: string;
}[] = [
  { pluginId: "web-search", icon: Globe, zh: "帮我搜索一下最新的新闻", en: "Search the latest news for me" },
  { pluginId: "workboard", icon: LayoutDashboard, zh: "给我分配一个研究任务", en: "Create a research task for me" },
  { pluginId: "datasource", icon: Database, zh: "查询数据库", en: "Query a database" },
  { pluginId: "files", icon: FolderOpen, zh: "查看工作区文件", en: "Browse workspace files" },
  { pluginId: "wiki", icon: FileText, zh: "帮我写一篇 Wiki 文档", en: "Help me write a Wiki page" },
  { pluginId: "cron", icon: Timer, zh: "设置一个定时任务", en: "Set up a scheduled task" },
  { pluginId: "reverse-mcp", icon: MessageSquare, zh: "通过本地桥接执行命令", en: "Run a command via local bridge" },
  { pluginId: "wechat", icon: MessageSquare, zh: "配置微信渠道", en: "Configure WeChat channel" },
  { pluginId: "board", icon: LayoutDashboard, zh: "打开看板", en: "Open the board" },
  { pluginId: "workforce-studio", icon: BrainCircuit, zh: "管理 Worker 配置", en: "Manage worker configuration" },
];

function EmptyState({
  brandName,
}: {
  brandName: string;
  brandEmoji: string;
  tenantId: string;
}) {
  const t = useT();
  const plugins = usePluginStore((s) => s.plugins);
  const me = useChatStore((s) => s.me);
  const isZh = t("chat.welcome", { name: "" }).includes("欢迎");

  const starters = useMemo(() => {
    const activeIds = new Set(
      (plugins ?? []).filter((p) => p.state === "active").map((p) => p.id),
    );
    return PLUGIN_STARTERS
      .filter((s) => activeIds.has(s.pluginId))
      .slice(0, 4)
      .map((s) => ({ icon: s.icon, label: isZh ? s.zh : s.en }));
  }, [plugins, isZh]);

  const showSetupNudge = starters.length === 0 && me?.superAdmin;

  const goToMaintenance = useCallback(async () => {
    try { await api.switchTenant("maintenance"); } catch { /* ignore */ }
    const prompt = isZh
      ? "帮我配置这个系统，我刚创建了一个新租户，还没有启用任何插件"
      : "Help me configure this system — I just created a new tenant with no plugins enabled";
    window.location.assign(
      `/tenants/maintenance/users/${me?.userId ?? "admin"}?prompt=${encodeURIComponent(prompt)}`,
    );
  }, [me?.userId, isZh]);

  const handleStarter = (text: string) => {
    useChatStore.getState().sendPrompt(text);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-4">
      <img
        src="/classical/tianshu-avatar.png"
        alt=""
        className="mb-5 h-16 w-16 rounded-2xl object-cover"
      />
      <h2 className="mb-2 text-2xl font-semibold text-fg-default">
        {t("chat.welcome", { name: brandName })}
      </h2>
      <p className="mb-8 max-w-md text-sm text-fg-faint">{t("chat.welcomeBody")}</p>

      {starters.length > 0 && (
        <div className={`grid w-full gap-3 ${
          starters.length <= 2 ? "max-w-sm grid-cols-1" : "max-w-lg grid-cols-2"
        }`}>
          {starters.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => handleStarter(s.label)}
              className="flex items-center gap-3 rounded-xl bg-bg-surface px-4 py-3.5 text-left text-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-default"
            >
              <s.icon size={16} className="shrink-0 text-fg-fainter" />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
      )}

      {showSetupNudge && (
        <button
          type="button"
          onClick={() => void goToMaintenance()}
          className="flex items-center gap-3 rounded-xl bg-bg-surface px-5 py-3.5 text-sm text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-default"
        >
          <Settings size={16} className="shrink-0 text-fg-fainter" />
          <span>
            {isZh
              ? "转到维护模式，让 Agent 帮你配置系统"
              : "Switch to maintenance mode to configure the system"}
          </span>
        </button>
      )}
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
        <div className="flex items-center gap-1.5 text-xs text-fg-faint">
          <span>{t("chat.model")}</span>
          <ModelSelector value={binding.modelId} onChange={onChange} />
        </div>
      )}
      <span className="text-xs text-fg-fainter">
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
        className="ml-3 flex-none rounded border border-amber-400/40 px-2 py-0.5 text-xs uppercase tracking-wider text-amber-100 hover:bg-amber-400/10 hover:text-white"
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
