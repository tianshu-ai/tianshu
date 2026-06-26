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
        <span className="text-lg font-semibold text-white">{brandName}</span>
      </div>

      {/* Agents + Workers */}
      <div className="space-y-1 px-2 pt-2">
        {/* Main agent row — currently always selected */}
        <div className="flex cursor-pointer items-center gap-2 rounded-lg bg-bg-raised px-3 py-2 text-white">
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

      {/* Channels — webchat is always present; integrations land later. */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
        <div className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-fg-fainter">
          Channels
        </div>
        <div className="flex cursor-pointer items-center gap-2 rounded-lg bg-bg-raised px-3 py-1.5 text-white">
          <Hash size={12} className="flex-shrink-0" />
          <span className="flex-1 truncate text-xs">webchat</span>
          <span className="text-[9px] uppercase tracking-wider text-fg-faint">active</span>
        </div>
        <p className="px-2 pt-2 text-[10px] leading-relaxed text-fg-fainter">
          Sessions are managed by the agent, not the user (ADR-0001 §5).
          Additional messaging channels (Lark / Slack / …) land later.
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


