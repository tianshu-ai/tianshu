// Harness² Components View — organizes the workforce snapshot
// into Google Research's 8 editable harness components.
//
// Pure client-side: derives everything from the existing Snapshot
// structure, no new server routes needed.

import type { ReactElement } from "react";
import { useState } from "react";
import {
  Brain,
  FileCode,
  Lightbulb,
  MessageSquare,
  Puzzle,
  Shield,
  Users,
  Wrench,
  ChevronRight,
} from "lucide-react";

// ── types (duck-typed from client.tsx Snapshot) ─────────────────

interface PromptBlock {
  kind: string;
  title: string;
  source: string;
  origin: string;
  editable: boolean;
  text: string;
  note?: string;
}
interface ToolEntry { name: string; description: string; pluginId: string }
interface SkillEntry { name: string; description: string; pluginId: string; scope?: string; body: string }
interface PluginInfo { id: string; displayName: string; state: string; toolCount: number; skillCount: number }
interface WorkerAgent {
  slug: string; name: string; description: string | null; kind: string;
  enabled: boolean; modelId: string | null; blocks: PromptBlock[];
  tools: ToolEntry[]; skills: SkillEntry[];
}
interface MainAgent {
  brandName: string; defaultModelId: string | null;
  blocks: PromptBlock[]; systemPrompt: string;
  tools: ToolEntry[]; skills: SkillEntry[];
}
interface Snapshot {
  plugins: PluginInfo[];
  main: MainAgent;
  workers: WorkerAgent[];
}

// ── component config ────────────────────────────────────────────

interface HarnessItem {
  name: string;
  detail?: string;
  preview?: string;
  tags?: string[];
}

interface ComponentDef {
  id: string;
  label: string;
  desc: string;
  icon: ReactElement;
  color: string;   // tailwind text color
  bg: string;       // tailwind bg color
  extract: (snap: Snapshot) => HarnessItem[];
}

const COMPONENTS: ComponentDef[] = [
  {
    id: "skills", label: "Skills",
    desc: "Reusable task-specific instructions",
    icon: <Lightbulb size={16} />, color: "text-amber-400", bg: "bg-amber-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const sk of s.main.skills) {
        items.push({ name: sk.name, detail: sk.scope || "main", preview: sk.description?.slice(0, 120) });
      }
      const seen = new Set(items.map(i => i.name));
      for (const w of s.workers) {
        for (const sk of w.skills) {
          if (!seen.has(sk.name)) {
            seen.add(sk.name);
            items.push({ name: sk.name, detail: `worker:${w.slug}`, preview: sk.description?.slice(0, 120) });
          }
        }
      }
      return items;
    },
  },
  {
    id: "memory", label: "Memory",
    desc: "Durable user preferences (USER.md)",
    icon: <Brain size={16} />, color: "text-pink-400", bg: "bg-pink-500/10",
    extract: (s) => {
      // Memory comes from user-onboarding block
      const block = s.main.blocks.find(b => b.kind === "user-onboarding");
      if (!block?.text) return [];
      const sections = block.text.split("\n").filter(l => /^##\s/.test(l)).map(l => l.replace(/^##\s+/, "").trim());
      if (sections.length) return sections.map(name => ({ name }));
      return [{ name: "USER.md", detail: `${Math.round(block.text.length / 1024)}KB` }];
    },
  },
  {
    id: "subagents", label: "Subagents",
    desc: "Worker agent configurations",
    icon: <Users size={16} />, color: "text-blue-400", bg: "bg-blue-500/10",
    extract: (s) => s.workers.map(w => {
      const tags: string[] = [];
      if (w.modelId) tags.push(w.modelId);
      tags.push(`${w.tools.length} tools`);
      if (w.skills.length) tags.push(`${w.skills.length} skills`);
      return { name: w.slug, detail: w.description || w.name, tags };
    }),
  },
  {
    id: "system_prompt", label: "System Prompt",
    desc: "Core agent identity & behavior",
    icon: <MessageSquare size={16} />, color: "text-purple-400", bg: "bg-purple-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const b of s.main.blocks) {
        if (b.kind === "brand" || b.kind === "tenant-prompt" || b.kind === "worker-soul" || b.kind === "custom-fragment") {
          items.push({
            name: b.title || b.kind,
            detail: `${b.origin}${b.editable ? " · editable" : ""}`,
            preview: b.text.split("\n").slice(0, 2).join(" ").slice(0, 120),
          });
        }
      }
      return items;
    },
  },
  {
    id: "guardrails", label: "Guardrails",
    desc: "Safety constraints & deny rules",
    icon: <Shield size={16} />, color: "text-red-400", bg: "bg-red-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      // Execution-bias / reply-style blocks act as guardrails
      for (const b of s.main.blocks) {
        if (b.kind === "execution-bias" || b.kind === "reply-style") {
          items.push({ name: b.title || b.kind, detail: b.origin, preview: b.text.split("\n")[0]?.slice(0, 120) });
        }
      }
      return items;
    },
  },
  {
    id: "tool_guidance", label: "Tool Guidance",
    desc: "How tools should be used",
    icon: <Wrench size={16} />, color: "text-cyan-400", bg: "bg-cyan-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      // Plugin fragments that mention tools
      for (const b of s.main.blocks) {
        if (b.kind === "plugin-fragment") {
          items.push({ name: b.title || b.source, detail: b.origin, preview: b.text.split("\n")[0]?.slice(0, 120) });
        }
      }
      // Skills that are tool-focused
      for (const sk of s.main.skills) {
        if (/tool|_file|_dir|exec|write_file|read_file/i.test(sk.body || "")) {
          items.push({ name: sk.name, detail: "skill", preview: sk.description?.slice(0, 120) });
        }
      }
      return items;
    },
  },
  {
    id: "scripts", label: "Scripts",
    desc: "Structured step-by-step workflows",
    icon: <FileCode size={16} />, color: "text-orange-400", bg: "bg-orange-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const sk of s.main.skills) {
        if (/step\s*[1-9]|## Step/i.test(sk.body || "")) {
          const steps = (sk.body?.match(/## Step/gi) || []).length || 0;
          items.push({ name: sk.name, detail: steps ? `${steps} steps` : "structured" });
        }
      }
      return items;
    },
  },
  {
    id: "plugins", label: "Plugins",
    desc: "Active plugin integrations",
    icon: <Puzzle size={16} />, color: "text-green-400", bg: "bg-green-500/10",
    extract: (s) => s.plugins
      .filter(p => p.state === "active")
      .map(p => ({
        name: p.displayName || p.id,
        detail: p.state,
        tags: [
          p.toolCount ? `${p.toolCount} tools` : "",
          p.skillCount ? `${p.skillCount} skills` : "",
        ].filter(Boolean),
      })),
  },
];

// ── main component ──────────────────────────────────────────────

export function HarnessView({ snapshot }: { snapshot: Snapshot }): ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="px-1">
        <h3 className="text-sm font-semibold text-fg-default">Harness² Components</h3>
        <p className="text-[11px] text-fg-faint mt-0.5">
          8 editable dimensions of your agent harness — click to inspect
        </p>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-4 gap-2">
        {COMPONENTS.map(comp => {
          const items = comp.extract(snapshot);
          const isOpen = expanded === comp.id;
          return (
            <button
              key={comp.id}
              onClick={() => setExpanded(isOpen ? null : comp.id)}
              className={`rounded-lg ${comp.bg} px-3 py-3 text-left transition-all hover:brightness-110 ${isOpen ? "ring-1 ring-current" : ""}`}
            >
              <div className="flex items-center gap-1.5 mb-1">
                <span className={comp.color}>{comp.icon}</span>
                <span className={`text-lg font-bold ${comp.color}`}>{items.length}</span>
              </div>
              <div className="text-[11px] font-medium text-fg-muted">{comp.label}</div>
              <div className="text-[9px] text-fg-faint leading-tight mt-0.5">{comp.desc}</div>
            </button>
          );
        })}
      </div>

      {/* Detail panel */}
      {expanded && (() => {
        const comp = COMPONENTS.find(c => c.id === expanded)!;
        const items = comp.extract(snapshot);
        if (!items.length) {
          return (
            <div className={`rounded-lg ${comp.bg} p-4 text-center`}>
              <span className={`${comp.color} text-sm`}>{comp.icon}</span>
              <div className="text-xs text-fg-faint mt-2">No {comp.label.toLowerCase()} configured</div>
            </div>
          );
        }
        return (
          <div className={`rounded-lg border border-border-subtle overflow-hidden`}>
            <div className={`${comp.bg} px-3 py-2 flex items-center gap-2`}>
              <span className={comp.color}>{comp.icon}</span>
              <span className={`text-sm font-semibold ${comp.color}`}>{comp.label}</span>
              <span className="text-[11px] text-fg-faint">({items.length})</span>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-border-subtle">
              {items.map((item, i) => (
                <div key={i} className="px-3 py-2 hover:bg-bg-raised/50 transition-colors">
                  <div className="flex items-center gap-2">
                    <ChevronRight size={12} className="text-fg-faint flex-shrink-0" />
                    <span className="text-xs font-medium text-fg-default">{item.name}</span>
                    {item.detail && (
                      <span className="text-[10px] text-fg-faint ml-auto flex-shrink-0">{item.detail}</span>
                    )}
                  </div>
                  {item.preview && (
                    <div className="text-[10px] text-fg-faint mt-0.5 ml-5 line-clamp-2">{item.preview}</div>
                  )}
                  {item.tags && item.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1 ml-5">
                      {item.tags.map((tag, j) => (
                        <span key={j} className="rounded px-1.5 py-0.5 text-[9px] bg-bg-elevated text-fg-muted">{tag}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
