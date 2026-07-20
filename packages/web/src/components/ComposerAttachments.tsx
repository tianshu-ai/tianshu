// Chip strip rendered above the textarea showing every staged
// attachment plus a remove "x". A small spinner (icon swap) covers
// the upload-in-progress state; errors render in red with the message
// surfaced as a tooltip.

import { File as FileIcon, Loader2, X, AlertTriangle } from "lucide-react";
import { useComposerStore } from "../stores/composer-store";
import { useT } from "../hooks/useT";

const KB = 1024;
const MB = KB * 1024;

function formatSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

export default function ComposerAttachments() {
  const t = useT();
  const attachments = useComposerStore((s) => s.attachments);
  const remove = useComposerStore((s) => s.removeAttachment);

  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 pb-1">
      {attachments.map((a) => {
        const isUploading = a.status === "uploading";
        const isError = a.status === "error";
        return (
          <div
            key={a.id}
            className={
              "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs " +
              (isError
                ? "border-rose-700/60 bg-rose-950/40 text-danger"
                : "border-border-default bg-bg-raised text-fg-default")
            }
            title={isError ? (a.error ?? "upload failed") : a.path ?? a.name}
            aria-label={`attachment ${a.name}`}
          >
            {isUploading ? (
              <Loader2 size={12} className="animate-spin text-brand-400" />
            ) : isError ? (
              <AlertTriangle size={12} className="text-danger" />
            ) : (
              <FileIcon size={12} className="text-fg-muted" />
            )}
            <span className="max-w-[12rem] truncate">{a.name}</span>
            <span className="text-[10px] text-fg-faint">
              {formatSize(a.size)}
            </span>
            <button
              type="button"
              onClick={() => remove(a.id)}
              className="ml-0.5 rounded p-0.5 text-fg-faint hover:bg-bg-hover hover:text-fg-default"
              aria-label={t("attachment.remove")}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
