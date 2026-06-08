// Admin shell: the chat shell's `/admin` surface.
//
// Layout:
//   <aside>     ← sidebar with grouped nav links (one per
//                 contributes.adminPages[] across active plugins)
//   <main>      ← currently-selected page renders full-width
//
// Pages are pure plugin contributions in v0 — there's no built-in
// "Users" / "OAuth" page yet (those land when JWT auth ships). If
// no plugin contributes anything we render an empty-state.
//
// Routing:
//   /admin                          → first available page (or empty state)
//   /admin/:pluginId/:pageId        → that plugin's named page
//
// We use a single nested route + URL-driven active state so adding
// pages doesn't touch the router; the sidebar is computed from the
// shared plugin-store.

import { useEffect, useMemo } from "react";
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import * as Icons from "lucide-react";
import { ArrowLeft, ShieldCheck, Settings as SettingsIcon } from "lucide-react";
import { useChatStore } from "../../stores/chat-store";
import { usePluginStore } from "../../stores/plugin-store";
import { resolveComponent } from "../../lib/plugin-registry";
import type { AdminPageProps } from "@tianshu/plugin-sdk/client";
import type { PluginListEntry } from "../../lib/api";
import { useT } from "../../hooks/useT";
import McpServersPage from "./McpServersPage";

interface ContributesAdminPage {
  id: string;
  displayName: string;
  icon?: string;
  component: string;
  order?: number;
  group?: string;
}

interface FlatAdminPage {
  pluginId: string;
  pluginDisplayName: string;
  pageId: string;
  displayName: string;
  icon?: string;
  /** Component resolution: when `kind === "plugin"`, look up
   *  `component` in the plugin's client bundle (clientEntry).
   *  When `kind === "core"`, render `coreComponent` directly —
   *  no plugin loading needed. */
  kind: "plugin" | "core";
  component: string;
  coreComponent?: React.ComponentType<AdminPageProps>;
  group?: string;
  order: number;
  clientEntry: string | null;
}

/**
 * Pages shipped by the host itself (not by a plugin). These show up
 * under a synthetic plugin id of `core` so we can route them through
 * the same `:pluginId/:pageId` URL structure as plugin pages.
 */
const CORE_PAGES: FlatAdminPage[] = [
  {
    pluginId: "core",
    pluginDisplayName: "Tianshu",
    pageId: "mcp",
    displayName: "MCP Servers",
    icon: "Server",
    kind: "core",
    component: "McpServersPage",
    coreComponent: McpServersPage as unknown as React.ComponentType<AdminPageProps>,
    group: "Agent",
    order: 10,
    clientEntry: null,
  },
];

function flattenAdminPages(plugins: PluginListEntry[] | null): FlatAdminPage[] {
  const out: FlatAdminPage[] = [...CORE_PAGES];
  if (plugins) {
    for (const p of plugins) {
      if (p.state !== "active") continue;
      const pages =
        (p.contributes as { adminPages?: ContributesAdminPage[] }).adminPages ?? [];
      for (const page of pages) {
        out.push({
          pluginId: p.id,
          pluginDisplayName: p.displayName,
          pageId: page.id,
          displayName: page.displayName,
          icon: page.icon,
          kind: "plugin",
          component: page.component,
          group: page.group,
          order: page.order ?? 100,
          clientEntry: p.clientEntry,
        });
      }
    }
  }
  // Sort by group label first, then explicit order, then display
  // name. Pages with no group bubble to the top.
  out.sort((a, b) => {
    const ga = a.group ?? "";
    const gb = b.group ?? "";
    if (ga !== gb) {
      if (ga === "") return -1;
      if (gb === "") return 1;
      return ga.localeCompare(gb);
    }
    if (a.order !== b.order) return a.order - b.order;
    return a.displayName.localeCompare(b.displayName);
  });
  return out;
}

export default function AdminShell() {
  const me = useChatStore((s) => s.me);
  const init = useChatStore((s) => s.init);
  const plugins = usePluginStore((s) => s.plugins);
  const loadPlugins = usePluginStore((s) => s.load);

  useEffect(() => {
    init();
    void loadPlugins();
  }, [init, loadPlugins]);

  const pages = useMemo(() => flattenAdminPages(plugins), [plugins]);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950 text-gray-200">
      <AdminSidebar pages={pages} userLabel={me?.userId ?? null} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route
            index
            element={
              pages.length > 0 ? (
                <Navigate
                  to={`/admin/${pages[0]!.pluginId}/${pages[0]!.pageId}`}
                  replace
                />
              ) : (
                <EmptyState />
              )
            }
          />
          <Route
            path=":pluginId/:pageId"
            element={<AdminPageHost pages={pages} />}
          />
          <Route path="*" element={<Navigate to="" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function AdminSidebar({
  pages,
  userLabel,
}: {
  pages: FlatAdminPage[];
  userLabel: string | null;
}) {
  const t = useT();
  const shellTitle = t("admin.title");
  // Group consecutive pages sharing a group string. We keep insertion
  // order from the sort above so a plugin can bunch its pages even
  // when other plugins also contribute to "Plugins".
  const grouped: { group: string | null; pages: FlatAdminPage[] }[] = [];
  for (const p of pages) {
    const last = grouped[grouped.length - 1];
    const g = p.group ?? null;
    if (last && last.group === g) last.pages.push(p);
    else grouped.push({ group: g, pages: [p] });
  }

  return (
    <aside className="flex w-56 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-900">
      <div className="flex h-14 items-center gap-2 border-b border-gray-800 px-4">
        <ShieldCheck size={16} className="text-blue-400" />
        <span className="text-sm font-semibold text-gray-100">{shellTitle}</span>
      </div>

      <nav className="flex-1 space-y-3 overflow-y-auto p-2">
        {grouped.length === 0 && (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-gray-500">
            No admin pages contributed yet. Enable a plugin that
            ships <code>contributes.adminPages</code> to see entries
            here.
          </p>
        )}
        {grouped.map((bucket, i) => (
          <div key={i}>
            {bucket.group && (
              <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                {bucket.group}
              </div>
            )}
            <div className="space-y-0.5">
              {bucket.pages.map((p) => (
                <AdminNavLink key={`${p.pluginId}.${p.pageId}`} page={p} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-gray-800 p-2">
        <NavLink
          to="/"
          className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-gray-500 hover:bg-gray-800/50 hover:text-gray-300"
        >
          <ArrowLeft size={12} />
          Back to chat
        </NavLink>
      </div>
      {userLabel && (
        <div className="flex items-center gap-2 border-t border-gray-800 px-3 py-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-[10px] font-semibold text-white">
            {userLabel.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-gray-300">{userLabel}</div>
            <div className="text-[10px] text-gray-600">admin</div>
          </div>
        </div>
      )}
    </aside>
  );
}

function AdminNavLink({ page }: { page: FlatAdminPage }) {
  const Icon = resolveLucideIcon(page.icon);
  return (
    <NavLink
      to={`/admin/${page.pluginId}/${page.pageId}`}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive
            ? "bg-gray-800 text-white"
            : "text-gray-400 hover:bg-gray-800/50 hover:text-gray-200"
        }`
      }
    >
      {Icon && <Icon size={14} className="flex-shrink-0" />}
      <span className="truncate">{page.displayName}</span>
    </NavLink>
  );
}

function AdminPageHost({ pages }: { pages: FlatAdminPage[] }) {
  const params = useParams();
  const navigate = useNavigate();
  const me = useChatStore((s) => s.me);

  const page = pages.find(
    (p) => p.pluginId === params.pluginId && p.pageId === params.pageId,
  );

  useEffect(() => {
    // If the plugin or page disappears (plugin disabled / refreshed),
    // bounce back to the shell index. We can't redirect during render
    // so do it in an effect.
    if (!page && pages.length > 0) {
      navigate("/admin", { replace: true });
    }
  }, [page, pages, navigate]);

  if (!page) return <EmptyState />;

  const Component =
    page.kind === "core"
      ? page.coreComponent ?? null
      : (resolveComponent(page.clientEntry, page.component) as
          | React.ComponentType<AdminPageProps>
          | null);

  if (!Component) {
    return (
      <PageError
        title={`Component "${page.component}" not found`}
        message={`Plugin ${page.pluginId}'s client bundle does not export ${page.component}. Did you forget to add it to PluginClientExports.components?`}
      />
    );
  }

  const props: AdminPageProps = {
    tenantId: me?.tenantId ?? "",
    userId: me?.userId ?? "",
    pageId: page.pageId,
    plugin: {
      id: page.pluginId,
      version: "",
      displayName: page.pluginDisplayName,
    },
  };

  return <Component {...props} />;
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center px-6 py-24 text-center text-gray-400">
      <SettingsIcon size={32} className="mb-3 text-gray-600" />
      <h2 className="mb-2 text-base font-semibold text-gray-200">
        Nothing to manage yet
      </h2>
      <p className="text-sm leading-relaxed text-gray-500">
        The admin shell is empty until a plugin contributes an admin
        page. Open the Plugin Manager from the chat shell to enable
        a plugin that ships one (e.g. MicroSandbox).
      </p>
    </div>
  );
}

function PageError({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="rounded-md border border-rose-700/50 bg-rose-950/40 p-4 text-sm text-rose-200">
        <strong className="mb-1 block">{title}</strong>
        <p className="leading-relaxed text-rose-300">{message}</p>
      </div>
    </div>
  );
}

function resolveLucideIcon(name: string | undefined) {
  if (!name) return null;
  const all = Icons as unknown as Record<string, React.ComponentType<{ size?: number; className?: string }>>;
  return all[name] ?? null;
}
