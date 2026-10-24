/**
 * Renders pinned context chips above the composer.
 * Each chip shows what the user is referencing; click × to unpin.
 */
import { ListTodo, MessageSquare, FileText, X } from "lucide-react";
import { useComposerStore, type PinnedContext } from "../stores/composer-store";

const ICON_MAP: Record<PinnedContext["kind"], typeof ListTodo> = {
  task: ListTodo,
  message: MessageSquare,
  file: FileText,
};

export default function PinnedContextChips() {
  const pinnedContexts = useComposerStore((s) => s.pinnedContexts);
  const unpinContext = useComposerStore((s) => s.unpinContext);

  if (pinnedContexts.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap gap-1.5 px-1 pb-1">
      {pinnedContexts.map((ctx) => {
        const Icon = ICON_MAP[ctx.kind] ?? FileText;
        return (
          <div
            key={ctx.id}
            className="flex items-center gap-1.5 rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-1 text-xs text-fg-muted"
            title={ctx.summary}
          >
            <Icon size={12} className="flex-shrink-0 text-accent" />
            <span className="max-w-[200px] truncate">{ctx.label}</span>
            <button
              type="button"
              onClick={() => unpinContext(ctx.id)}
              className="ml-0.5 rounded p-0.5 text-fg-fainter transition-colors hover:bg-bg-hover hover:text-fg-default"
            >
              <X size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
