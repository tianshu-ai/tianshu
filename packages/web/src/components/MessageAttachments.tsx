// Render the `attachments` field on a user message.
//
// Image attachments → inline thumbnail (max-h limited) served by the
// files plugin's /raw endpoint. Click → open in a new tab for the
// full-size view; we deliberately don't ship a lightbox in v0.
//
// Other types → file-card chip with a name + size. The agent learns
// about them via a text note in the message body and can `read_file`.

import { File as FileIcon } from "lucide-react";
import type { WireAttachment } from "../types/chat";

const KB = 1024;
const MB = KB * 1024;

function formatSize(bytes: number | undefined): string {
  if (bytes == null) return "";
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

function rawUrl(p: string): string {
  // The files plugin streams arbitrary workspace files through
  // /api/p/files/raw; reuse that for thumbnails so we don't need a
  // dedicated /api/uploads endpoint.
  return `/api/p/files/raw?path=${encodeURIComponent(p)}`;
}

export default function MessageAttachments({
  attachments,
  align,
}: {
  attachments: WireAttachment[];
  align: "start" | "end";
}) {
  if (!attachments || attachments.length === 0) return null;

  const items = attachments.slice(0, 8); // sanity cap on render
  const justify = align === "end" ? "justify-end" : "justify-start";

  return (
    <div className={`mt-1.5 flex max-w-full flex-wrap gap-1.5 ${justify}`}>
      {items.map((a) => {
        const isImage = a.mimeType.startsWith("image/");
        const url = rawUrl(a.path);
        if (isImage) {
          return (
            <a
              key={a.path}
              href={url}
              target="_blank"
              rel="noreferrer"
              title={a.name ?? a.path}
              className="overflow-hidden rounded-md border border-gray-800 bg-gray-900/60"
            >
              <img
                src={url}
                alt={a.name ?? a.path}
                className="block max-h-48 max-w-[16rem] object-contain"
                loading="lazy"
              />
            </a>
          );
        }
        return (
          <div
            key={a.path}
            className="flex items-center gap-1.5 rounded-md border border-gray-800 bg-gray-900/60 px-2 py-1 text-xs text-gray-200"
            title={a.path}
          >
            <FileIcon size={12} className="text-gray-400" />
            <span className="max-w-[12rem] truncate">{a.name ?? a.path}</span>
            <span className="text-[10px] text-gray-500">{formatSize(a.size)}</span>
          </div>
        );
      })}
    </div>
  );
}
