import { useChatStore } from "../stores/chat-store";
import { Bot, MessageSquare, ExternalLink } from "lucide-react";

/**
 * Sidebar — visually mirrors the closed-source predecessor: brand chip
 * at the top, a sessions list, a workers section, footer.
 *
 * The v0 backend doesn't expose multiple sessions yet (one active
 * per-user, see ADR-0001 §5), so the list is a single static row labelled
 * "Main". Workers are placeholders that match ADR-0002 — they don't run
 * yet and clicking them does nothing more than mark the row visually.
 */
export default function Sidebar() {
  const me = useChatStore((s) => s.me);
  const branding = me?.config.branding;
  const brandName = branding?.name ?? "Tianshu";
  const brandEmoji = branding?.emoji ?? "⭐";

  return (
    <aside className="flex h-full w-64 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-950">
      {/* Brand */}
      <div className="flex h-12 items-center border-b border-gray-800 px-4">
        <span className="text-lg leading-none">{brandEmoji}</span>
        <span className="ml-2 text-sm font-semibold tracking-tight text-gray-200">
          天枢 · {brandName}
        </span>
      </div>

      {/* Sessions */}
      <div className="flex-1 overflow-y-auto px-2 py-3">
        <SectionLabel>Sessions</SectionLabel>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md bg-gray-900/60 px-3 py-2 text-left text-sm text-gray-200 ring-1 ring-gray-800"
        >
          <MessageSquare size={14} className="text-brand-400" />
          <span className="truncate">Main</span>
          <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-500">active</span>
        </button>
        <p className="mt-2 px-2 text-[11px] leading-relaxed text-gray-500">
          v0 keeps a single endless conversation per user. New-session
          control + sessions list arrive in a later PR (ADR-0001 §5).
        </p>

        <SectionLabel className="mt-6">Workers</SectionLabel>
        <ul className="space-y-1">
          {WORKERS.map((w) => (
            <li
              key={w.role}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-gray-400 hover:bg-gray-900/60 hover:text-gray-200"
              title={`${w.displayName} (${w.role})`}
            >
              <span className="text-base leading-none">{w.emoji}</span>
              <span className="truncate">{w.displayName}</span>
              <span className="ml-auto text-[10px] uppercase tracking-wider text-gray-600">
                soon
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 px-2 text-[11px] leading-relaxed text-gray-500">
          Workers ship in PR #23+. See ADR-0002.
        </p>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-800 px-3 py-3">
        <div className="flex items-center justify-between text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1.5">
            <Bot size={12} />
            tenant <span className="text-gray-300">{me?.tenantId ?? "…"}</span>
          </span>
          <a
            className="inline-flex items-center gap-1 text-gray-400 hover:text-gray-200"
            href="https://github.com/tianshu-ai/tianshu"
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={12} />
            GitHub
          </a>
        </div>
      </div>
    </aside>
  );
}

function SectionLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mb-2 px-2 text-[10px] font-medium uppercase tracking-wider text-gray-500 ${className}`}
    >
      {children}
    </div>
  );
}

interface WorkerStub {
  role: string;
  displayName: string;
  emoji: string;
}

const WORKERS: WorkerStub[] = [
  { role: "qianliyan", displayName: "千里眼", emoji: "👁️" },
  { role: "luban", displayName: "鲁班", emoji: "🛠️" },
  { role: "xihe", displayName: "羲和", emoji: "📚" },
  { role: "nvwa", displayName: "女娲", emoji: "🎨" },
];
