// Harness² Components View — organizes the workforce snapshot
// into Google Research's 8 editable harness components.
//
// Pure client-side: derives everything from the existing Snapshot
// structure, no new server routes needed.

import type { ReactElement } from "react";
import { useMemo, useState } from "react";
import { usePluginT } from "@tianshu-ai/plugin-sdk/client";
import { OrganiseCard, AnalyseCard, EventInsightBrowser } from "./harness-operations.js";

type Translator = (key: string, params?: Record<string, string | number>) => string;
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
interface PluginInfo { id: string; displayName: string; version: string; description: string; origin: string; state: string; toolCount: number; skillCount: number }
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
  body?: string;
}

interface ComponentDef {
  id: string;
  labelKey: string;
  descKey: string;
  icon: ReactElement;
  color: string;
  bg: string;
  extract: (snap: Snapshot) => HarnessItem[];
}

const COMPONENTS: ComponentDef[] = [
  {
    id: "skills", labelKey: "harness.comp.skills",
    descKey: "harness.comp.skills.desc",
    icon: <Lightbulb size={16} />, color: "text-amber-400", bg: "bg-amber-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const sk of s.main.skills) {
        items.push({ name: sk.name, detail: sk.scope || "main", preview: sk.description?.slice(0, 120), body: sk.body });
      }
      const seen = new Set(items.map(i => i.name));
      for (const w of s.workers) {
        for (const sk of w.skills) {
          if (!seen.has(sk.name)) {
            seen.add(sk.name);
            items.push({ name: sk.name, detail: `worker:${w.slug}`, preview: sk.description?.slice(0, 120), body: sk.body });
          }
        }
      }
      return items;
    },
  },
  {
    id: "memory", labelKey: "harness.comp.memory",
    descKey: "harness.comp.memory.desc",
    icon: <Brain size={16} />, color: "text-pink-400", bg: "bg-pink-500/10",
    extract: (s) => {
      const block = s.main.blocks.find(b => b.kind === "user-onboarding");
      if (!block?.text) return [];
      // Split into sections by ## headings, each with its body
      const lines = block.text.split("\n");
      const items: HarnessItem[] = [];
      let currentName = "";
      let currentBody: string[] = [];
      for (const line of lines) {
        if (/^##\s/.test(line)) {
          if (currentName) items.push({ name: currentName, body: currentBody.join("\n").trim() });
          currentName = line.replace(/^##\s+/, "").trim();
          currentBody = [];
        } else if (currentName) {
          currentBody.push(line);
        }
      }
      if (currentName) items.push({ name: currentName, body: currentBody.join("\n").trim() });
      if (!items.length) return [{ name: "USER.md", body: block.text }];
      return items;
    },
  },
  {
    id: "subagents", labelKey: "harness.comp.subagents",
    descKey: "harness.comp.subagents.desc",
    icon: <Users size={16} />, color: "text-blue-400", bg: "bg-blue-500/10",
    extract: (s) => s.workers.map(w => {
      const tags: string[] = [];
      if (w.modelId) tags.push(w.modelId);
      tags.push(`${w.tools.length} tools`);
      if (w.skills.length) tags.push(`${w.skills.length} skills`);
      // Build body from blocks (SOUL.md) + tool list
      const parts: string[] = [];
      const soulBlock = w.blocks.find(b => b.kind === "worker-soul");
      if (soulBlock?.text) parts.push(`## SOUL.md\n${soulBlock.text}`);
      if (w.tools.length) parts.push(`## Tools (${w.tools.length})\n${w.tools.map(t => `- ${t.name}: ${t.description}`).join("\n")}`);
      if (w.skills.length) parts.push(`## Skills (${w.skills.length})\n${w.skills.map(sk => `- ${sk.name}: ${sk.description}`).join("\n")}`);
      return { name: w.slug, detail: w.description || w.name, tags, body: parts.join("\n\n") || undefined };
    }),
  },
  {
    id: "system_prompt", labelKey: "harness.comp.system_prompt",
    descKey: "harness.comp.system_prompt.desc",
    icon: <MessageSquare size={16} />, color: "text-purple-400", bg: "bg-purple-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const b of s.main.blocks) {
        if (b.kind === "brand" || b.kind === "tenant-prompt" || b.kind === "worker-soul" || b.kind === "custom-fragment") {
          items.push({
            name: b.title || b.kind,
            detail: `${b.origin}${b.editable ? " · editable" : ""}`,
            preview: b.text.split("\n").slice(0, 2).join(" ").slice(0, 120),
            body: b.text,
          });
        }
      }
      return items;
    },
  },
  {
    id: "guardrails", labelKey: "harness.comp.guardrails",
    descKey: "harness.comp.guardrails.desc",
    icon: <Shield size={16} />, color: "text-red-400", bg: "bg-red-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const b of s.main.blocks) {
        if (b.kind === "execution-bias" || b.kind === "reply-style") {
          items.push({ name: b.title || b.kind, detail: b.origin, preview: b.text.split("\n")[0]?.slice(0, 120), body: b.text });
        }
      }
      return items;
    },
  },
  {
    id: "tool_guidance", labelKey: "harness.comp.tool_guidance",
    descKey: "harness.comp.tool_guidance.desc",
    icon: <Wrench size={16} />, color: "text-cyan-400", bg: "bg-cyan-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const b of s.main.blocks) {
        if (b.kind === "plugin-fragment") {
          items.push({ name: b.title || b.source, detail: b.origin, preview: b.text.split("\n")[0]?.slice(0, 120), body: b.text });
        }
      }
      for (const sk of s.main.skills) {
        if (/tool|_file|_dir|exec|write_file|read_file/i.test(sk.body || "")) {
          items.push({ name: sk.name, detail: "skill", preview: sk.description?.slice(0, 120), body: sk.body });
        }
      }
      return items;
    },
  },
  {
    id: "scripts", labelKey: "harness.comp.scripts",
    descKey: "harness.comp.scripts.desc",
    icon: <FileCode size={16} />, color: "text-orange-400", bg: "bg-orange-500/10",
    extract: (s) => {
      const items: HarnessItem[] = [];
      for (const sk of s.main.skills) {
        if (/step\s*[1-9]|## Step/i.test(sk.body || "")) {
          const steps = (sk.body?.match(/## Step/gi) || []).length || 0;
          items.push({ name: sk.name, detail: steps ? `${steps} steps` : "structured", body: sk.body });
        }
      }
      return items;
    },
  },
  {
    id: "plugins", labelKey: "harness.comp.plugins",
    descKey: "harness.comp.plugins.desc",
    icon: <Puzzle size={16} />, color: "text-green-400", bg: "bg-green-500/10",
    extract: (s) => s.plugins
      .filter(p => p.state === "active")
      .map(p => {
        const parts: string[] = [];
        parts.push(`ID: ${p.id}`);
        parts.push(`Version: ${p.version}`);
        if (p.description) parts.push(`Description: ${p.description}`);
        parts.push(`Origin: ${p.origin}`);
        if (p.toolCount) parts.push(`Tools: ${p.toolCount}`);
        if (p.skillCount) parts.push(`Skills: ${p.skillCount}`);
        return {
          name: p.displayName || p.id,
          detail: p.state,
          tags: [
            p.toolCount ? `${p.toolCount} tools` : "",
            p.skillCount ? `${p.skillCount} skills` : "",
          ].filter(Boolean),
          body: parts.join("\n"),
        };
      }),
  },
];

// ── main component ──────────────────────────────────────────────

export function HarnessView({ snapshot }: { snapshot: Snapshot }): ReactElement {
  const t = usePluginT("workforce-studio");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Pre-compute items for all components
  const computed = useMemo(() =>
    COMPONENTS.map(comp => ({ ...comp, items: comp.extract(snapshot) })),
    [snapshot],
  );

  const expandedComp = expanded ? computed.find(c => c.id === expanded) : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="px-1">
        <h3 className="text-sm font-semibold text-fg-default">{t("harness.title")}</h3>
        <p className="text-[11px] text-fg-faint mt-0.5">
          {t("harness.subtitle")}
        </p>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-4 gap-2">
        {computed.map(comp => (
          <button
            key={comp.id}
            onClick={() => setExpanded(prev => prev === comp.id ? null : comp.id)}
            className={`rounded-lg ${comp.bg} px-3 py-3 text-left transition-all hover:brightness-110 ${expanded === comp.id ? "ring-1 ring-current" : ""}`}
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className={comp.color}>{comp.icon}</span>
              <span className={`text-lg font-bold ${comp.color}`}>{comp.items.length}</span>
            </div>
            <div className="text-[11px] font-medium text-fg-muted">{t(comp.labelKey)}</div>
            <div className="text-[9px] text-fg-faint leading-tight mt-0.5">{t(comp.descKey)}</div>
          </button>
        ))}
      </div>

      {/* Detail panel */}
      {expandedComp && (
        <ComponentDetail comp={expandedComp} t={t} />
      )}

      {/* Operations */}
      <div className="border-t border-border-subtle pt-4 space-y-3">
        <div className="px-1">
          <h3 className="text-sm font-semibold text-fg-default">{t("harness.refinement")}</h3>
          <p className="text-[11px] text-fg-faint mt-0.5">
            {t("harness.refinement.desc")}
          </p>
        </div>
        <OrganiseCard />
        <AnalyseCard />
        <EventInsightBrowser />
      </div>
    </div>
  );
}

function ComponentDetail({ comp, t }: { comp: { id: string; labelKey: string; color: string; bg: string; icon: ReactElement; items: HarnessItem[] }; t: Translator }): ReactElement {
  const label = t(comp.labelKey);
  const [openItem, setOpenItem] = useState<number | null>(null);

  if (!comp.items.length) {
    return (
      <div className={`rounded-lg ${comp.bg} p-4 text-center`}>
        <span className={`${comp.color} text-sm`}>{comp.icon}</span>
        <div className="text-xs text-fg-faint mt-2">{t("harness.noItems", { label })}</div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border-subtle overflow-hidden">
      <div className={`${comp.bg} px-3 py-2 flex items-center gap-2`}>
        <span className={comp.color}>{comp.icon}</span>
        <span className={`text-sm font-semibold ${comp.color}`}>{label}</span>
        <span className="text-[11px] text-fg-faint">({comp.items.length})</span>
      </div>
      <div className="max-h-[500px] overflow-y-auto divide-y divide-border-subtle">
        {comp.items.map((item, i) => {
          const isOpen = openItem === i;
          const hasBody = !!item.body;
          return (
            <div key={i}>
              <button
                onClick={() => hasBody && setOpenItem(isOpen ? null : i)}
                className={`w-full text-left px-3 py-2 transition-colors ${hasBody ? "hover:bg-bg-raised/50 cursor-pointer" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <ChevronRight
                    size={12}
                    className={`text-fg-faint flex-shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
                  />
                  <span className="text-xs font-medium text-fg-default">{item.name}</span>
                  {item.detail && (
                    <span className="text-[10px] text-fg-faint ml-auto flex-shrink-0">{item.detail}</span>
                  )}
                </div>
                {!isOpen && item.preview && (
                  <div className="text-[10px] text-fg-faint mt-0.5 ml-5 line-clamp-2">{item.preview}</div>
                )}
                {item.tags && item.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1 ml-5">
                    {item.tags.map((tag, j) => (
                      <span key={j} className="rounded px-1.5 py-0.5 text-[9px] bg-bg-elevated text-fg-muted">{tag}</span>
                    ))}
                  </div>
                )}
              </button>
              {isOpen && item.body && (
                <div className="px-3 pb-3">
                  <pre className="rounded-md bg-bg-default/80 p-3 text-[11px] text-fg-muted overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap font-mono leading-relaxed">
                    {item.body}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
