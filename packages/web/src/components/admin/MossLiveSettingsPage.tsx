/**
 * Moss-Live Settings page — tenant-level configuration only.
 *
 * User-level API Key is configured in the voice popover (MossLiveVoice.tsx).
 * This page is for admins to set tenant-wide defaults.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader2, Save, Sparkles } from "lucide-react";

const MODELS = [
  { id: "moss-live-1.0", label: "moss-live-1.0 (推荐)" },
  { id: "moss-live-1.0-250430", label: "moss-live-1.0-250430 (快照)" },
];

const DEFAULT_PERSONA = `你是天枢，一个智能AI助手。你通过语音与用户实时对话。

性格特点：
- 友好、专业、有耐心
- 回答简洁明了，避免冗长
- 遇到不确定的事情会坦诚说明
- 可以处理中英文对话

能力：
- 回答各类知识问题
- 帮助分析和解决问题
- 当用户提出复杂任务时，你会委派给后台的天枢Agent执行，并在执行过程中持续与用户交流`;

const DEFAULT_INSTRUCTIONS = `- 用中文回答，除非用户用英文提问
- 语音回答要简洁，每次回复控制在2-3句话以内
- 不要使用 Markdown 格式（语音场景无法渲染）
- 不要念出链接、代码块等不适合语音的内容
- 数字和日期用口语化表达（比如"一千两百"而不是"1200"）
- 遇到需要较长回答的问题，先给简要答案，再问用户是否需要详细解释`;

export default function MossLiveSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tenantKey, setTenantKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState("moss-live-1.0");
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");
  const [keySource, setKeySource] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/moss-live/config", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setTenantKey(data.apiKey || "");
          setModel(data.model || "moss-live-1.0");
          setPersona(data.persona || "");
          setInstructions(data.instructions || "");
          setKeySource(data.keySource ?? null);
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/moss-live/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ apiKey: tenantKey, model, persona, instructions }),
      });
      if (!res.ok) setError(`保存失败: ${res.status}`);
      else { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }, [tenantKey, model, persona, instructions]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold text-fg-default">实时语音 (Moss-Live)</h2>
        <p className="mt-1 text-sm text-fg-muted">
          租户级语音配置，所有用户共享。用户也可以在语音面板中配置自己的 API Key 覆盖此处设置。
        </p>
        {keySource && (
          <p className="mt-1 text-xs text-fg-faint">
            当前生效：{keySource === "user" ? "用户个人 Key" : "租户 Key"}
          </p>
        )}
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-fg-default">租户 API Key</label>
        <p className="text-xs text-fg-faint">
          从{" "}
          <a href="https://platform.moss.cn" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            platform.moss.cn
          </a>{" "}
          获取，所有用户共享此 Key。
        </p>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={tenantKey}
            onChange={(e) => setTenantKey(e.target.value)}
            placeholder="sk-..."
            autoComplete="off"
            data-1p-ignore
            className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 pr-10 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={() => setShowKey(v => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-muted hover:text-fg-default"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-fg-default">模型</label>
        <div className="relative">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full appearance-none rounded-lg border border-border-default bg-bg-base px-3 py-2 pr-8 text-sm text-fg-default focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
        </div>
      </div>

      {/* Persona */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-fg-default">人设</label>
          {!persona && (
            <button
              type="button"
              onClick={() => setPersona(DEFAULT_PERSONA)}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
            >
              <Sparkles size={12} /> 生成默认人设
            </button>
          )}
        </div>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          placeholder="点击右上角「生成默认人设」快速填充..."
          rows={5}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
        <p className="text-xs text-fg-faint">最多 8000 字符 · 当前 {persona.length} 字符</p>
      </div>

      {/* Instructions */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-fg-default">会话指令</label>
          {!instructions && (
            <button
              type="button"
              onClick={() => setInstructions(DEFAULT_INSTRUCTIONS)}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
            >
              <Sparkles size={12} /> 生成默认指令
            </button>
          )}
        </div>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="点击右上角「生成默认指令」快速填充..."
          rows={4}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
        <p className="text-xs text-fg-faint">当前 {instructions.length} 字符</p>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          保存
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-green-500">
            <CheckCircle size={14} /> 已保存
          </span>
        )}
        {error && (
          <span className="flex items-center gap-1 text-sm text-red-400">
            <AlertCircle size={14} /> {error}
          </span>
        )}
      </div>
    </div>
  );
}
