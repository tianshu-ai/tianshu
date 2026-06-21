// Renders composer-action buttons contributed by active plugins.
//
// Each plugin's component is given the live `ComposerApi` via the
// host-installed `useComposer()` and a small props bag with tenant /
// user / plugin identity. Plugins decide what their button does
// (open file picker, paste, etc.) — we only do the layout.

import type { ComposerActionProps } from "@tianshu-ai/plugin-sdk/client";
import { useChatStore } from "../stores/chat-store";
import { usePluginStore } from "../stores/plugin-store";
import { getComposerApi } from "../stores/composer-store";
import { resolveComponent } from "../lib/plugin-registry";

interface ContributesComposerAction {
  id: string;
  icon?: string;
  tooltip?: string;
  component: string;
  order?: number;
}

interface ContributesShape {
  composerActions?: ContributesComposerAction[];
}

export default function PluginComposerActions() {
  const me = useChatStore((s) => s.me);
  const plugins = usePluginStore((s) => s.plugins);

  if (!me || !plugins) return null;

  type FlatAction = ContributesComposerAction & {
    pluginId: string;
    pluginVersion: string;
    pluginDisplayName: string;
    clientEntry: string | null;
  };

  const actions: FlatAction[] = [];
  for (const p of plugins) {
    if (p.state !== "active") continue;
    const c = (p.contributes as ContributesShape).composerActions ?? [];
    for (const a of c) {
      actions.push({
        ...a,
        pluginId: p.id,
        pluginVersion: p.version,
        pluginDisplayName: p.displayName,
        clientEntry: p.clientEntry,
      });
    }
  }
  actions.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  if (actions.length === 0) return null;

  const composer = getComposerApi();

  return (
    <>
      {actions.map((a) => {
        const Comp = resolveComponent(a.clientEntry, a.component);
        if (!Comp) return null;
        const props: ComposerActionProps = {
          tenantId: me.tenantId,
          userId: me.userId,
          plugin: {
            id: a.pluginId,
            version: a.pluginVersion,
            displayName: a.pluginDisplayName,
          },
          composer,
        };
        return <Comp key={`${a.pluginId}.${a.id}`} {...props} />;
      })}
    </>
  );
}
