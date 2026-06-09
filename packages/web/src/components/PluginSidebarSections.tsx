// Renders sidebar sections contributed by active plugins.
//
// One section per `manifest.contributes.sidebarSections[*]`, in
// declaration order, ordered by `order` within the same `after`
// anchor. The host renders this component at one specific anchor
// at a time (e.g. <PluginSidebarSections anchor="workers" />); the
// component flat-filters contributions whose `after` matches.
//
// `after: "workers"` => render right after the host's built-in
// "Workers" stub, which is the slot the workboard plugin claims.
// Future plugins can claim other anchors as we add them.

import type { ComponentType } from "react";
import type { SidebarSectionProps } from "@tianshu/plugin-sdk/client";
import { resolveComponent } from "../lib/plugin-registry";
import { usePluginStore } from "../stores/plugin-store";

interface ContributesSidebarSection {
  id: string;
  displayName: string;
  component: string;
  after?: string;
  order?: number;
}

interface ContributesShape {
  sidebarSections?: ContributesSidebarSection[];
}

interface PluginManifestShape {
  /** Server flattens manifest.client.entry to this top-level key in
   *  the `/api/plugins` response. The PluginListEntry type uses the
   *  same shape. */
  clientEntry?: string;
}

export default function PluginSidebarSections({
  anchor,
  fallback,
}: {
  /** Logical slot id, matches `sidebarSections[*].after`. */
  anchor: string;
  /** Rendered when no active plugin contributes a section for this
   *  anchor. Lets the host show its own placeholder in dev/empty
   *  tenants without interleaving conditionals at the call site. */
  fallback?: React.ReactNode;
}) {
  const plugins = usePluginStore((s) => s.plugins);
  if (!plugins) return null;

  type Resolved = {
    pluginId: string;
    contribId: string;
    Component: ComponentType<SidebarSectionProps>;
    order: number;
  };
  const items: Resolved[] = [];
  for (const p of plugins) {
    if (p.state !== "active") continue;
    const c = (p.contributes as ContributesShape).sidebarSections ?? [];
    for (const s of c) {
      if ((s.after ?? "") !== anchor) continue;
      const entry = (p as PluginManifestShape).clientEntry;
      const Component = resolveComponent(entry, s.component) as
        | ComponentType<SidebarSectionProps>
        | null;
      if (!Component) continue;
      items.push({
        pluginId: p.id,
        contribId: s.id,
        Component,
        order: s.order ?? 100,
      });
    }
  }
  items.sort((a, b) => a.order - b.order);

  if (items.length === 0) return <>{fallback ?? null}</>;

  // We don't have a real per-tenant runtime info source on the web
  // side yet; supply minimal stubs that match the SidebarSectionProps
  // contract. Plugin sections on the chat shell don't usually need
  // these, but the type forces us to provide them.
  const baseProps = {
    tenantId: "",
    userId: "",
    plugin: { id: "", version: "", displayName: "" },
    isCollapsed: false,
    onToggleCollapse: () => {},
  };

  return (
    <>
      {items.map(({ pluginId, contribId, Component }) => (
        <Component
          key={`${pluginId}.${contribId}`}
          {...baseProps}
          plugin={{ id: pluginId, version: "", displayName: pluginId }}
        />
      ))}
    </>
  );
}
