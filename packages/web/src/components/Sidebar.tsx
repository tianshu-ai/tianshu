import { Bot, Zap, ChevronDown, Hash } from "lucide-react";
import { useChatStore } from "../stores/chat-store";

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
    <aside className="flex h-full w-64 flex-shrink-0 flex-col border-r border-gray-800 bg-gray-900">
      {/* Header */}
      <div className="flex h-12 items-center border-b border-gray-800 px-4">
        <span className="text-lg font-semibold text-white">{brandName}</span>
      </div>

      {/* Agents + Workers */}
      <div className="space-y-1 px-2 pt-2">
        {/* Main agent row — currently always selected */}
        <div className="flex cursor-pointer items-center gap-2 rounded-lg bg-gray-800 px-3 py-2 text-white">
          <Bot size={14} className="flex-shrink-0 text-blue-400" />
          <span className="text-sm font-medium">{brandName}</span>
        </div>

        {/* Workers */}
        <div className="px-3 py-2">
          <div className="mb-2 flex items-center gap-2">
            <Zap size={14} className="flex-shrink-0 text-gray-600" />
            <span className="flex-1 text-sm font-medium text-gray-300">Workers</span>
            <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[9px] text-gray-600">
              0/4 busy
            </span>
          </div>
          <div className="space-y-1.5">
            {WORKERS.map((w) => (
              <div
                key={w.role}
                className="flex cursor-pointer items-center gap-2 rounded py-0.5 pl-1 hover:bg-gray-700/30"
                title={`${w.displayName} (${w.role}) — ${w.description}`}
              >
                <span className="w-5 flex-shrink-0 text-center text-base">{w.emoji}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-gray-200">
                      {w.displayName}
                    </span>
                    <span className="rounded bg-gray-800/60 px-1 py-px text-[9px] text-gray-600">
                      idle
                    </span>
                  </div>
                  <div className="truncate text-[9px] text-gray-600">
                    {w.description}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-3 my-2 border-b border-gray-800/50" />

      {/* Channels — webchat is always present; integrations land later. */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2">
        <div className="px-1 pb-1 pt-2 text-[10px] uppercase tracking-wider text-gray-600">
          Channels
        </div>
        <div className="flex cursor-pointer items-center gap-2 rounded-lg bg-gray-800 px-3 py-1.5 text-white">
          <Hash size={12} className="flex-shrink-0" />
          <span className="flex-1 truncate text-xs">webchat</span>
          <span className="text-[9px] uppercase tracking-wider text-gray-500">active</span>
        </div>
        <p className="px-2 pt-2 text-[10px] leading-relaxed text-gray-600">
          Sessions are managed by the agent, not the user (ADR-0001 §5).
          Additional messaging channels (Lark / Slack / …) land later.
        </p>
      </nav>

      {/* Footer */}
      <SidebarFooter />
    </aside>
  );
}

function SidebarFooter() {
  const me = useChatStore((s) => s.me);
  const userId = me?.userId ?? "…";
  const initial = userId.slice(0, 1).toUpperCase();
  const role = me?.devTenant ? "dev" : "member";
  const subline = `${role} · ${me?.tenantId ?? ""}`;

  return (
    <div className="relative border-t border-gray-800">
      <div className="flex w-full items-center gap-2 px-3 py-2 hover:bg-gray-800/60 transition-colors cursor-default">
        <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-purple-600 text-[10px] font-semibold text-white">
          {initial}
        </div>
        <div className="min-w-0 flex-1 text-left">
          <div className="truncate text-[11px] text-gray-300">{userId}</div>
          <div className="truncate text-[10px] text-gray-600">{subline}</div>
        </div>
        <ChevronDown size={12} className="text-gray-500" />
      </div>
    </div>
  );
}

interface WorkerStub {
  role: string;
  displayName: string;
  emoji: string;
  description: string;
}

const WORKERS: WorkerStub[] = [
  { role: "qianliyan", displayName: "千里眼", emoji: "👁️", description: "Workspace search" },
  { role: "luban",     displayName: "鲁班",   emoji: "🛠️", description: "Code & docs maker" },
  { role: "xihe",      displayName: "羲和",   emoji: "📚", description: "External research" },
  { role: "nvwa",      displayName: "女娲",   emoji: "🎨", description: "Image generation" },
];
