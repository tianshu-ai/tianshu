import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  Hash,
  ShieldCheck,
} from "lucide-react";
import PluginSidebarSections from "./PluginSidebarSections";
import { ThemeToggle } from "./ui/ThemeToggle";
import { Link } from "react-router-dom";
import { useChatStore } from "../stores/chat-store";
import {
  getSupportedLocales,
  LOCALE_LABELS,
  setLocale,
  type Locale,
} from "../lib/i18n";
import { useLocale, useT } from "../hooks/useT";

/**
 * Sidebar — visual layout mirrors the closed-source predecessor:
 *   ┌──────────────────────────────────────┐
 *   │  brand name                          │  h-12 header
 *   ├──────────────────────────────────────┤
 *   │  Agents                              │
 *   │   🤖  Tianshu          (active)      │  main agent row
 *   │                                      │
 *   │   ⚡ Workers       0/4 busy          │  workers section header
 *   │     👁️ 千里眼        idle  desc      │
 *   │     🛠️ 鲁班          idle  desc      │
 *   │     📚 羲和          idle  desc      │
 *   │     🎨 女娲          idle  desc      │
 *   │  ──────────────────                  │
 *   │  Channels                            │
 *   │   #️⃣ webchat          (active)       │
 *   ├──────────────────────────────────────┤
 *   │  ⚪ user · member · v0.2.0    ▾      │  footer
 *   └──────────────────────────────────────┘
 *
 * The user does not manage sessions — agents control compact / new
 * conversation themselves (ADR-0001 §5). The list under "Channels"
 * shows messaging channels (webchat / Lark / Slack / …). Backend
 * doesn't yet expose channel bindings or worker liveness, so we
 * render static placeholder rows for now.
 */
export default function Sidebar() {
  const me = useChatStore((s) => s.me);
  const brandName = me?.config.branding?.name ?? "Tianshu";

  return (
    <aside className="flex h-full w-64 flex-shrink-0 flex-col border-r border-border-subtle bg-bg-elevated">
      {/* Header */}
      <div className="flex h-12 items-center border-b border-border-subtle px-4">
        <span className="text-lg font-semibold text-fg-default">{brandName}</span>
      </div>

      {/* Agents + Workers */}
      <div className="space-y-1 px-2 pt-2">
        {/* Main agent row — currently always selected */}
        <div className="flex cursor-pointer items-center gap-2 rounded-lg bg-bg-raised px-3 py-2 text-fg-default">
          <Bot size={14} className="flex-shrink-0 text-link" />
          <span className="text-sm font-medium">{brandName}</span>
        </div>

        {/* Workers — contributed by the workboard plugin (or any other
         *  plugin claiming `sidebarSections.after = "workers"`). When
         *  no plugin contributes the section we render nothing; the
         *  sidebar collapses cleanly. */}
        <div data-testid="sidebar-workers-anchor">
          <PluginSidebarSections anchor="workers" />
        </div>
      </div>

      <div className="mx-3 my-2 border-b border-border-subtle/50" />

      {/* Channels — webchat is the default thread; channel
          sessions appear here as inbound platform messages arrive. */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
        <div className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-fg-fainter">
          Channels
        </div>
        <ChannelsList />
        <p className="px-2 pt-2 text-[10px] leading-relaxed text-fg-fainter">
          Sessions are managed by the agent, not the user (ADR-0001 §5).
        </p>
      </nav>

      {/* Footer (user pill).
       *  Admin entry + language switcher live inside the popover
       *  menu now — mirrors the closed-source predecessor's
       *  GitHub/Linear-style profile dropdown so the sidebar isn't
       *  cluttered with "Admin", "Settings", "Logout" links. */}
      <SidebarFooter />
    </aside>
  );
}

function SidebarFooter() {
  const me = useChatStore((s) => s.me);
  const t = useT();
  const locale = useLocale();
  const locales = getSupportedLocales();
  const userId = me?.userId ?? "…";
  const initial = userId.slice(0, 1).toUpperCase();
  const roleKey = me?.devTenant ? "user.role.dev" : "user.role.member";
  const subline = `${t(roleKey)} · ${me?.tenantId ?? ""}`;

  const [menuOpen, setMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click / Esc — standard popover dismissal.
  // We only attach the listeners while the menu is open so
  // un-mounting / collapsing the sidebar doesn't leak globals.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setLangOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setLangOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="relative border-t border-border-subtle" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={userId}
        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-bg-raised/60 transition-colors"
      >
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-[10px] font-semibold text-white">
          {initial}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[11px] text-fg-muted">{userId}</div>
          <div className="truncate text-[10px] text-fg-fainter">{subline}</div>
        </div>
        <ChevronDown
          size={12}
          className={`text-fg-faint transition-transform ${menuOpen ? "rotate-180" : ""}`}
        />
      </button>

      {menuOpen && (
        <div
          role="menu"
          className="absolute bottom-full left-2 right-2 z-50 mb-1 rounded-md border border-border-default bg-bg-elevated py-1 text-[12px] shadow-xl"
        >
          {/* Identity header inside menu, mirrors Linear/Discord style. */}
          <div className="border-b border-border-subtle px-3 py-2">
            <div className="truncate text-fg-default">{userId}</div>
            <div className="truncate text-[10px] text-fg-fainter">{subline}</div>
          </div>

          {/* Admin entry. v0 shows it for everyone (no JWT yet);
           *  when auth lands we'll gate on me.role === 'admin'. */}
          <Link
            // Relative to the current identity-scoped route.
            // The sidebar lives inside ChatLayout which renders
            // under `/tenants/:t/users/:u`, so "admin" resolves
            // to `/tenants/:t/users/:u/admin` without us having
            // to know who's signed in.
            to="admin"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            className="flex items-center gap-2 px-3 py-1.5 text-fg-default hover:bg-bg-raised"
          >
            <ShieldCheck size={14} className="text-fg-faint" />
            <span>{t("admin.title")}</span>
          </Link>

          {/* Language sub-menu — inline expansion keeps the popover
           *  scoped instead of fanning out a second floating panel.
           *  Pattern lifted from the closed-source predecessor's
           *  GitHub-style profile dropdown. */}
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={langOpen}
            onClick={() => setLangOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-fg-default hover:bg-bg-raised"
          >
            <Globe size={14} className="text-fg-faint" />
            <span className="flex-1 text-left">{t("lang.label")}</span>
            <span className="text-[10px] text-fg-faint">{LOCALE_LABELS[locale]}</span>
            <ChevronRight
              size={12}
              className={`text-fg-faint transition-transform ${langOpen ? "rotate-90" : ""}`}
            />
          </button>
          {langOpen && (
            <ul role="menu" className="border-y border-border-subtle bg-bg-base/60">
              {locales.map((l: Locale) => {
                const active = l === locale;
                return (
                  <li
                    key={l}
                    role="menuitemradio"
                    aria-checked={active}
                    tabIndex={0}
                    onClick={() => {
                      setLocale(l);
                      setLangOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setLocale(l);
                        setLangOpen(false);
                      }
                    }}
                    className={`flex cursor-pointer items-center gap-2 py-1.5 pl-9 pr-3 outline-none ${
                      active ? "text-link" : "text-fg-muted hover:bg-bg-raised"
                    }`}
                  >
                    <span className="flex-1">{LOCALE_LABELS[l]}</span>
                    {active && <Check size={13} className="text-link" />}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Theme picker. Lives at the menu's bottom — frequently
           *  toggled the first time someone sets up the app, then
           *  ignored. Keeps it out of the way of more common
           *  actions like Admin / Language. */}
          <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-3 py-2 text-[12px] text-fg-muted">
            <span>{t("user.theme")}</span>
            <ThemeToggle compact />
          </div>

          {/* Sign-out is intentionally absent until JWT auth ports
           *  over — there's nothing to sign out of yet. The menu's
           *  shape leaves the slot ready. */}
        </div>
      )}
    </div>
  );
}



/**
 * Lists chat threads under the Channels heading: the always-on
 * webchat thread + every channel session the server knows about
 * (loaded into chat-store.channelSessions on init). Clicking a
 * row flips `viewingSessionId`, which re-pulls history and the
 * ChatArea re-renders.
 *
 * Channel sessions are read-only in v0: messages flow from the
 * platform (wechat / telegram / ...) into the agent, the agent
 * replies back through the channel adapter. The composer in
 * ChatArea hides itself when viewingSessionId !== null so the
 * user can't accidentally post via the wrong surface.
 */
function ChannelsList() {
  const channelSessions = useChatStore((s) => s.channelSessions);
  const viewingSessionId = useChatStore((s) => s.viewingSessionId);
  const selectSession = useChatStore((s) => s.selectSession);
  const refresh = useChatStore((s) => s.refreshChannelSessions);

  // Light auto-refresh: re-pull every 30s while the sidebar's
  // mounted so newly-arrived sessions appear without a full reload.
  // 30s is conservative; tighten once we have a push-based update.
  useEffect(() => {
    const t = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Decode the server's title scheme `<channelId>:dm|group:<peer>`
  // into something nicer. Falls back to the raw title for older
  // rows that don't follow it.
  function formatLabel(title: string | null): string {
    if (!title) return "(untitled)";
    const m = title.match(/^([^:]+):(dm|group):(.+)$/);
    if (!m) return title;
    const [, , kind, peer] = m;
    const trimmedPeer = peer.length > 18 ? `${peer.slice(0, 16)}…` : peer;
    return `${kind === "dm" ? "DM" : "群"} · ${trimmedPeer}`;
  }

  function channelPillClass(channelId: string): string {
    // Tiny accent so two channels are visually distinguishable in
    // the sidebar even before display names resolve. Tones picked
    // to be readable in both light + dark themes.
    switch (channelId) {
      case "wechat":
        return "bg-success/15 text-success";
      case "feishu":
        return "bg-success/15 text-success";
      case "telegram":
        return "bg-link/15 text-link";
      case "discord":
        return "bg-link/15 text-link";
      case "slack":
        return "bg-danger/15 text-danger";
      default:
        return "bg-bg-hover text-fg-muted";
    }
  }

  return (
    <>
      {/* Always-on webchat row. Clicking it returns to the user's
          own webchat thread (server side: viewingSessionId=null). */}
      <button
        type="button"
        onClick={() => selectSession(null)}
        className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors ${
          viewingSessionId === null
            ? "bg-bg-raised text-fg-default"
            : "text-fg-muted hover:bg-bg-hover hover:text-fg-default"
        }`}
      >
        <Hash size={12} className="flex-shrink-0" />
        <span className="flex-1 truncate text-xs">webchat</span>
        {viewingSessionId === null && (
          <span className="text-[9px] uppercase tracking-wider text-fg-faint">
            active
          </span>
        )}
      </button>

      {/* Channel sessions (wechat / telegram / ...). Sorted server-
          side by created_at DESC so freshest threads sit on top. */}
      {channelSessions.map((s) => {
        const active = s.id === viewingSessionId;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => selectSession(s.id)}
            className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors ${
              active
                ? "bg-bg-raised text-fg-default"
                : "text-fg-muted hover:bg-bg-hover hover:text-fg-default"
            }`}
            title={s.title ?? s.channelChatId}
          >
            <span
              className={`flex-shrink-0 rounded px-1 py-px text-[9px] uppercase tracking-wider ${channelPillClass(s.channelId)}`}
            >
              {s.channelId}
            </span>
            <span className="flex-1 truncate text-xs">
              {formatLabel(s.title)}
            </span>
            {active && (
              <span className="text-[9px] uppercase tracking-wider text-fg-faint">
                active
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}
