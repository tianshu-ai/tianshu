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
import { ArrowLeft, ShieldCheck, Settings as SettingsIcon, LogOut } from "lucide-react";
import { useChatStore } from "../../stores/chat-store";
import { usePluginStore } from "../../stores/plugin-store";
import { resolveComponent } from "../../lib/plugin-registry";
import type { AdminPageProps } from "@tianshu-ai/plugin-sdk/client";
import { api, type PluginListEntry } from "../../lib/api";
import { useT } from "../../hooks/useT";
import { buildIdentityPath, clearIdentityCookie } from "../../dev-identity";
import McpServersPage from "./McpServersPage";
import ModelsPage from "./ModelsPage";
import {
  AuthSettingsPage,
  AuthProvidersPage,
  AuthUsersPage,
  AuthTenantsPage,
} from "./AuthPage";
import { PluginConfigForm } from "../PluginConfigForm";

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
    pageId: "auth",
    displayName: "Auth",
    icon: "ShieldCheck",
    kind: "core",
    component: "AuthSettingsPage",
    coreComponent: AuthSettingsPage as unknown as React.ComponentType<AdminPageProps>,
    group: "System",
    order: 1,
    clientEntry: null,
  },
  {
    pluginId: "core",
    pluginDisplayName: "Tianshu",
    pageId: "auth-providers",
    displayName: "Providers",
    icon: "KeyRound",
    kind: "core",
    component: "AuthProvidersPage",
    coreComponent: AuthProvidersPage as unknown as React.ComponentType<AdminPageProps>,
    group: "System",
    order: 2,
    clientEntry: null,
  },
  {
    pluginId: "core",
    pluginDisplayName: "Tianshu",
    pageId: "auth-users",
    displayName: "Users",
    icon: "UserCog",
    kind: "core",
    component: "AuthUsersPage",
    coreComponent: AuthUsersPage as unknown as React.ComponentType<AdminPageProps>,
    group: "System",
    order: 3,
    clientEntry: null,
  },
  {
    pluginId: "core",
    pluginDisplayName: "Tianshu",
    pageId: "auth-tenants",
    displayName: "Tenants",
    icon: "Building2",
    kind: "core",
    component: "AuthTenantsPage",
    coreComponent: AuthTenantsPage as unknown as React.ComponentType<AdminPageProps>,
    group: "System",
    order: 4,
    clientEntry: null,
  },
  {
    pluginId: "core",
    pluginDisplayName: "Tianshu",
    pageId: "models",
    displayName: "Models",
    icon: "Boxes",
    kind: "core",
    component: "ModelsPage",
    coreComponent: ModelsPage as unknown as React.ComponentType<AdminPageProps>,
    group: "System",
    order: 5,
    clientEntry: null,
  },
  {
    pluginId: "core",
    pluginDisplayName: "Tianshu",
    pageId: "mcp",
    displayName: "MCP Servers",
    icon: "Server",
    kind: "core",
    component: "McpServersPage",
    coreComponent: McpServersPage as unknown as React.ComponentType<AdminPageProps>,
    group: "System",
    order: 6,
    clientEntry: null,
  },
];

/** Sidebar group every plugin-contributed admin page is filed
 *  under. We deliberately ignore `manifest.adminPages[].group` for
 *  plugin pages so a plugin can't escape the Plugins section by
 *  inventing its own top-level label. (Core / host-shipped pages
 *  keep their own groups: Agent for MCP, etc.) */
const PLUGIN_GROUP = "Plugins";

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
          group: PLUGIN_GROUP,
          order: page.order ?? 100,
          clientEntry: p.clientEntry,
        });
      }

      // Auto-inject a per-plugin "Settings" page when:
      //   1) the manifest declares a configSchema, AND
      //   2) the plugin has NO admin page of its own.
      //
      // If the plugin has any admin page, we skip the inject —
      // the form is folded into THAT page's header by
      // `renderConfigFormBanner` below, so the user doesn't see
      // two sidebar entries (one "plugin admin" + one
      // "Settings") for the same plugin. This matches what users
      // actually expect: "the place I configure microsandbox is
      // the microsandbox admin page".
      const hasConfig =
        !!p.configSchema && (p.configSchema?.fields?.length ?? 0) > 0;
      const hasOwnAdminPage = pages.length > 0;
      const declaredSettings = pages.some((page) => page.id === "settings");
      if (hasConfig && !hasOwnAdminPage && !declaredSettings) {
        out.push({
          pluginId: p.id,
          pluginDisplayName: p.displayName,
          pageId: "settings",
          // Sidebar entry uses the plugin's own display name so the
          // user sees "Workboard" / "Files" / etc. rather than every
          // line reading "Settings".
          displayName: p.displayName,
          icon: "Settings",
          kind: "core",
          component: "PluginConfigSettingsPage",
          coreComponent: ((props: AdminPageProps) => (
            <PluginConfigSettingsPage
              {...props}
              pluginId={p.id}
            />
          )) as React.ComponentType<AdminPageProps>,
          group: PLUGIN_GROUP,
          order: 90,
          clientEntry: null,
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
    <div className="flex h-screen overflow-hidden bg-bg-base text-fg-default">
      <AdminSidebar
        pages={pages}
        userLabel={me?.displayName ?? me?.userId ?? null}
        userRole={me?.role ?? null}
        showLogout={!!me?.provider}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route
            index
            element={
              pages.length > 0 ? (
                // Absolute so the redirect lands at
                // `/tenants/:t/users/:u/admin/<plugin>/<page>`
                // regardless of how we got here (cookie /
                // direct link / sidebar click).
                <Navigate
                  to={buildIdentityPath(
                    `/admin/${pages[0]!.pluginId}/${pages[0]!.pageId}`,
                  )}
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

// Localize the DISPLAYED label of a nav bucket group. We map the
// well-known host-owned group strings ("System", "Plugins") through
// t(); anything else (a plugin inventing its own group, though the
// flatten() step normalizes plugin groups to "Plugins") falls
// through as-is.
function localizeGroup(
  t: ReturnType<typeof useT>,
  group: string,
): string {
  switch (group) {
    case "System":
      return t("admin.group.system");
    case "Plugins":
      return t("admin.group.plugins");
    default:
      return group;
  }
}

// Localize the DISPLAYED label of a core page. Plugin-contributed
// page displayNames come from manifests and stay as-is. The switch
// is keyed on the CORE_PAGES pageId (stable identifier) rather
// than displayName (english string) so a future rename doesn't
// silently break translation.
function localizeCorePageLabel(
  t: ReturnType<typeof useT>,
  page: FlatAdminPage,
): string {
  if (page.pluginId !== "core") return page.displayName;
  switch (page.pageId) {
    case "auth":
      return t("admin.nav.auth");
    case "auth-providers":
      return t("admin.nav.authProviders");
    case "auth-users":
      return t("admin.nav.authUsers");
    case "auth-tenants":
      return t("admin.nav.authTenants");
    case "models":
      return t("admin.nav.models");
    case "mcp":
      return t("admin.nav.mcp");
    default:
      return page.displayName;
  }
}

function AdminSidebar({
  pages,
  userLabel,
  userRole,
  showLogout,
}: {
  pages: FlatAdminPage[];
  userLabel: string | null;
  userRole?: "admin" | "member" | null;
  /** Show a logout button (auth mode / session login only). */
  showLogout?: boolean;
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

  const localizedRole =
    userRole === "admin"
      ? t("user.role.admin")
      : userRole === "member"
        ? t("user.role.member")
        : null;

  return (
    <aside className="flex w-56 flex-shrink-0 flex-col border-r border-border-subtle bg-bg-elevated">
      <div className="flex h-14 items-center gap-2 border-b border-border-subtle px-4">
        <ShieldCheck size={16} className="text-link" />
        <span className="text-sm font-semibold text-fg-default">{shellTitle}</span>
      </div>

      <nav className="flex-1 space-y-3 overflow-y-auto p-2">
        {grouped.length === 0 && (
          <p className="px-3 py-2 text-[11px] leading-relaxed text-fg-faint">
            {t("admin.emptyNav")}
          </p>
        )}
        {grouped.map((bucket, i) => (
          <div key={i}>
            {bucket.group && (
              <div className="px-3 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
                {localizeGroup(t, bucket.group)}
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

      <div className="border-t border-border-subtle p-2">
        <NavLink
          // Up two levels: out of `/admin/<plugin>/<page>` (or
          // `/admin/`) back to the identity root which renders
          // the chat shell. Using `..` keeps us under the
          // current identity prefix without having to import
          // buildIdentityPath here.
          to=".."
          className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-fg-faint hover:bg-bg-raised/50 hover:text-fg-muted"
          end
        >
          <ArrowLeft size={12} />
          {t("admin.backToChat")}
        </NavLink>
      </div>
      {userLabel && (
        <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-[10px] font-semibold text-white">
            {userLabel.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] text-fg-muted">{userLabel}</div>
            {localizedRole && (
              <div className="text-[10px] text-fg-fainter">{localizedRole}</div>
            )}
          </div>
          {showLogout && (
            <button
              type="button"
              title={t("common.logOut")}
              onClick={async () => {
                try {
                  await api.logout();
                } finally {
                  clearIdentityCookie();
                  window.location.assign("/login");
                }
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-fainter hover:bg-bg-hover hover:text-danger"
            >
              <LogOut size={13} />
            </button>
          )}
        </div>
      )}
    </aside>
  );
}

function AdminNavLink({ page }: { page: FlatAdminPage }) {
  const t = useT();
  const Icon = resolveLucideIcon(page.icon);
  // Build an absolute path so the link doesn't resolve relative
  // to the current URL. With nested admin pages (`/admin/foo/bar`)
  // a relative `to="foo/bar"` would append to whatever's already
  // there — producing `/admin/foo/bar/foo/bar` on click of the
  // active row's link. Absolute via buildIdentityPath stays
  // consistent regardless of where you click from.
  const href = buildIdentityPath(
    `/admin/${page.pluginId}/${page.pageId}`,
  );
  const label = localizeCorePageLabel(t, page);
  return (
    <NavLink
      to={href}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
          isActive
            ? "bg-bg-hover text-fg-default border border-border-default"
            : "text-fg-muted hover:bg-bg-hover hover:text-fg-default border border-transparent"
        }`
      }
    >
      {Icon && <Icon size={14} className="flex-shrink-0" />}
      <span className="truncate">{label}</span>
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
      // Absolute path to the admin index of the current identity.
      // The index route then redirects to the first plugin page.
      navigate(buildIdentityPath("/admin"), { replace: true });
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
        titleKey="admin.error.componentNotFound"
        messageKey="admin.error.componentNotFoundBody"
        params={{ component: page.component, pluginId: page.pluginId }}
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
  const t = useT();
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center px-6 py-24 text-center text-fg-muted">
      <SettingsIcon size={32} className="mb-3 text-fg-fainter" />
      <h2 className="mb-2 text-base font-semibold text-fg-default">
        {t("admin.empty.title")}
      </h2>
      <p className="text-sm leading-relaxed text-fg-faint">
        {t("admin.empty.body")}
      </p>
    </div>
  );
}

function PageError({
  titleKey,
  messageKey,
  params,
}: {
  titleKey: string;
  messageKey: string;
  params?: Record<string, string | number>;
}) {
  const t = useT();
  return (
    <div className="mx-auto max-w-2xl px-6 py-12">
      <div className="rounded-md border border-rose-700/50 bg-rose-950/40 p-4 text-sm text-danger">
        <strong className="mb-1 block">{t(titleKey as never, params)}</strong>
        <p className="leading-relaxed text-danger">{t(messageKey as never, params)}</p>
      </div>
    </div>
  );
}

function resolveLucideIcon(name: string | undefined) {
  if (!name) return null;
  const all = Icons as unknown as Record<string, React.ComponentType<{ size?: number; className?: string }>>;
  return all[name] ?? null;
}

/**
 * Auto-generated settings page for any active plugin with a
 * `configSchema`. Lays the form out using the same chrome as the
 * other host admin pages (max-w-5xl, padded section card, gray-950
 * background). The plugin id is captured at flatten time so the
 * form re-derives its value from the latest plugin list whenever
 * the store mutates (toggle, save, etc.).
 */
function PluginConfigSettingsPage({
  pluginId,
}: AdminPageProps & { pluginId: string }) {
  const t = useT();
  const plugins = usePluginStore((s) => s.plugins);
  const plugin = plugins?.find((p) => p.id === pluginId);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
          <SettingsIcon size={18} className="text-brand-400" />
          {plugin ? plugin.displayName : pluginId}
        </h1>
        {plugin?.description && (
          <p className="mt-1 max-w-3xl text-[12px] text-fg-faint">
            {plugin.description}
          </p>
        )}
      </div>
      {!plugin ? (
        <div className="rounded-md border border-dashed border-border-subtle px-4 py-6 text-center text-[12px] text-fg-faint">
          {t("admin.pluginConfig.inactiveBefore")}
          <code>{pluginId}</code>
          {t("admin.pluginConfig.inactiveAfter")}
        </div>
      ) : (
        <section>
          <div className="mb-2">
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">
              {t("admin.pluginConfig.sectionTitle")}
            </h2>
            <p className="text-[11px] text-fg-faint">
              {t("admin.pluginConfig.sectionHint")}
            </p>
          </div>
          <div className="rounded-md border border-border-subtle bg-bg-elevated/30 p-4">
            <PluginConfigForm plugin={plugin} />
          </div>
        </section>
      )}
    </div>
  );
}
