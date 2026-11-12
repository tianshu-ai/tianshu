/**
 * Moss-Live realtime voice settings page.
 *
 * Lets users configure:
 *   - API Key (from platform.moss.cn)
 *   - Model (dropdown, default: moss-live-1.0)
 *   - Persona prompt (with auto-generate button)
 *   - Instructions (with auto-generate button)
 */

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader2, Save, Sparkles } from "lucide-react";

interface MossLiveConfig {
  apiKey?: string;
  model?: string;
  persona?: string;
  instructions?: string;
}

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
  const [config, setConfig] = useState<MossLiveConfig>({ model: "moss-live-1.0" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);

  // Load current config
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/moss-live/config", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setConfig({ model: "moss-live-1.0", ...data });
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
        body: JSON.stringify(config),
      });
      if (!res.ok) {
        setError(`保存失败: ${res.status}`);
      } else {
        setSaved(true);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }, [config]);

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
          配置 Moss-Live 实时语音对话。需要{" "}
          <a
            href="https://platform.moss.cn"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            platform.moss.cn
          </a>{" "}
          的 API Key。
        </p>
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-fg-default">API Key</label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={config.apiKey || ""}
            onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
            placeholder="sk-..."
            autoComplete="off"
            data-1p-ignore
            className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 pr-10 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-muted hover:text-fg-default"
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {/* Model */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-fg-default">模型</label>
        <select
          value={config.model || "moss-live-1.0"}
          onChange={(e) => setConfig({ ...config, model: e.target.value })}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Persona */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-fg-default">人设</label>
          {!config.persona && (
            <button
              type="button"
              onClick={() => setConfig({ ...config, persona: DEFAULT_PERSONA })}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
            >
              <Sparkles size={12} /> 生成默认人设
            </button>
          )}
        </div>
        <textarea
          value={config.persona || ""}
          onChange={(e) => setConfig({ ...config, persona: e.target.value })}
          placeholder="点击右上角「生成默认人设」快速填充..."
          rows={6}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
        <p className="text-xs text-fg-faint">最多 8000 字符 · 当前 {(config.persona || "").length} 字符</p>
      </div>

      {/* Instructions */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="block text-sm font-medium text-fg-default">会话指令</label>
          {!config.instructions && (
            <button
              type="button"
              onClick={() => setConfig({ ...config, instructions: DEFAULT_INSTRUCTIONS })}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent/80"
            >
              <Sparkles size={12} /> 生成默认指令
            </button>
          )}
        </div>
        <textarea
          value={config.instructions || ""}
          onChange={(e) => setConfig({ ...config, instructions: e.target.value })}
          placeholder="点击右上角「生成默认指令」快速填充..."
          rows={4}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
        <p className="text-xs text-fg-faint">当前 {(config.instructions || "").length} 字符</p>
      </div>

      {/* Actions */}
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
