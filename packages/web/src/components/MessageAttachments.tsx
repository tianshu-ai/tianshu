// Renders attachment chips/thumbnails on a user message.
//
// Renders nothing itself \u2014 it dispatches each attachment to the
// first plugin-contributed `attachmentRenderers` entry that matches
// the mime type. This keeps the web shell decoupled from any
// specific file plugin's URL scheme.
//
// Fallback: if no plugin claims the mime (e.g. all renderer plugins
// disabled), we render a minimal builtin chip so the user at least
// sees that they attached something.

import type {
  AttachmentRendererProps,
  AttachmentDescriptor,
} from "@tianshu-ai/plugin-sdk/client";
import { File as FileIcon } from "lucide-react";
import { useChatStore } from "../stores/chat-store";
import { usePluginStore } from "../stores/plugin-store";
import {
  collectRenderers,
  pickRenderer,
} from "../lib/attachment-renderers";
import { resolveComponent } from "../lib/plugin-registry";
import type { WireAttachment } from "../types/chat";

const KB = 1024;
const MB = KB * 1024;
function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Host-side raw URL resolver. Today the only plugin offering
 * arbitrary workspace-file streaming is `files`, so we route
 * through it. If files is disabled or replaced, this URL will 404
 * \u2014 which is exactly the right failure mode (\"plugin not\n * installed = not visible\", per ADR-0003).
 *
 * Centralising the URL here means:
 *  1. Renderer plugins (which receive `rawUrl` via props) don't\n *     hard-code `/api/p/files/raw`.\n *  2. We can swap to a CDN cache or signed URL later in one place.
 */
function hostRawUrl(p: string): string {
  return `/api/p/files/raw?path=${encodeURIComponent(p)}`;
}

function asDescriptor(a: WireAttachment): AttachmentDescriptor {
  return { path: a.path, mimeType: a.mimeType, name: a.name, size: a.size };
}

export default function MessageAttachments({
  attachments,
  align,
}: {
  attachments: WireAttachment[];
  align: "start" | "end";
}) {
  const me = useChatStore((s) => s.me);
  const plugins = usePluginStore((s) => s.plugins);
  if (!attachments || attachments.length === 0) return null;

  const renderers = plugins ? collectRenderers(plugins) : [];
  const items = attachments.slice(0, 8); // sanity cap on render
  const justify = align === "end" ? "justify-end" : "justify-start";

  return (
    <div className={`mt-1.5 flex max-w-full flex-wrap gap-1.5 ${justify}`}>
      {items.map((a) => {
        const match = pickRenderer(renderers, a.mimeType);
        if (match && me) {
          const Comp = resolveComponent(match.clientEntry, match.component);
          if (Comp) {
            const props: AttachmentRendererProps = {
              tenantId: me.tenantId,
              userId: me.userId,
              plugin: {
                id: match.pluginId,
                version: match.pluginVersion,
                displayName: match.pluginDisplayName,
              },
              attachment: asDescriptor(a),
              align,
              rawUrl: hostRawUrl,
            };
            return <Comp key={a.path} {...props} />;
          }
        }
        // Builtin fallback chip \u2014 plugins all disabled or none
        // matches the mime. Better than rendering nothing.
        return (
          <div
            key={a.path}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-gray-900/60 px-2 py-1 text-xs text-fg-default"
            title={a.path}
          >
            <FileIcon size={12} className="text-fg-muted" />
            <span className="max-w-[12rem] truncate">{a.name ?? a.path}</span>
            <span className="text-[10px] text-fg-faint">{formatSize(a.size)}</span>
          </div>
        );
      })}
    </div>
  );
}
