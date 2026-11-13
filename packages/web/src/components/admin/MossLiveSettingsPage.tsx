/**
 * Moss-Live realtime voice settings page.
 *
 * Two-level API Key:
 *   - Tenant level: admin sets for all users (stored in config.json)
 *   - User level: individual override (stored in user_preferences)
 */

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader2, Save, Sparkles, Shield, User } from "lucide-react";

interface MossLiveConfigResponse {
  apiKey?: string | null;     // masked tenant key
  userApiKey?: string | null; // masked user key
  available?: boolean;
  keySource?: "user" | "tenant" | null;
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
  const [config, setConfig] = useState<MossLiveConfigResponse>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Separate state for the two key levels
  const [tenantKey, setTenantKey] = useState("");
  const [userKey, setUserKey] = useState("");
  const [showTenantKey, setShowTenantKey] = useState(false);
  const [showUserKey, setShowUserKey] = useState(false);

  // Tenant-level settings
  const [model, setModel] = useState("moss-live-1.0");
  const [persona, setPersona] = useState("");
  const [instructions, setInstructions] = useState("");

  // Load current config
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/moss-live/config", { credentials: "include" });
        if (res.ok) {
          const data: MossLiveConfigResponse = await res.json();
          setConfig(data);
          setTenantKey(data.apiKey || "");
          setUserKey(data.userApiKey || "");
          setModel(data.model || "moss-live-1.0");
          setPersona(data.persona || "");
          setInstructions(data.instructions || "");
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const saveTenantConfig = useCallback(async () => {
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

  const saveUserKey = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/moss-live/user-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ apiKey: userKey }),
      });
      if (!res.ok) setError(`保存失败: ${res.status}`);
      else { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }, [userKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-5 w-5 animate-spin text-fg-muted" />
      </div>
    );
  }

  const keySource = config.keySource;

  return (
    <div className="mx-auto max-w-2xl space-y-8 p-6">
      <div>
        <h2 className="text-lg font-semibold text-fg-default">实时语音 (Moss-Live)</h2>
        <p className="mt-1 text-sm text-fg-muted">
          配置 Moss-Live 实时语音对话。需要{" "}
          <a href="https://platform.moss.cn" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            platform.moss.cn
          </a>{" "}
          的 API Key。
        </p>
        {config.available && (
          <p className="mt-2 text-xs text-green-500">
            ✅ 语音模式已就绪 — 当前使用{keySource === "user" ? "个人" : "租户"}级 Key
          </p>
        )}
      </div>

      {/* ── User-level API Key ── */}
      <div className="rounded-lg border border-border-default p-4 space-y-3">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-blue-400" />
          <h3 className="text-sm font-medium text-fg-default">个人 API Key</h3>
          {keySource === "user" && (
            <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-400">当前使用</span>
          )}
        </div>
        <p className="text-xs text-fg-muted">你自己的 Moss API Key，优先于租户级配置。留空则使用租户级 Key。</p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showUserKey ? "text" : "password"}
              value={userKey}
              onChange={(e) => setUserKey(e.target.value)}
              placeholder="sk-... (留空使用租户级)"
              autoComplete="off"
              data-1p-ignore
              className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 pr-10 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => setShowUserKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-muted hover:text-fg-default"
            >
              {showUserKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            onClick={saveUserKey}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存
          </button>
        </div>
      </div>

      {/* ── Tenant-level settings ── */}
      <div className="rounded-lg border border-border-default p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-medium text-fg-default">租户级配置</h3>
          {keySource === "tenant" && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-400">当前使用</span>
          )}
        </div>
        <p className="text-xs text-fg-muted">管理员配置，所有用户共享。用户可以用个人 Key 覆盖。</p>

        {/* Tenant API Key */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-fg-muted">租户 API Key</label>
          <div className="relative">
            <input
              type={showTenantKey ? "text" : "password"}
              value={tenantKey}
              onChange={(e) => setTenantKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              data-1p-ignore
              className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 pr-10 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => setShowTenantKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-muted hover:text-fg-default"
            >
              {showTenantKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* Model */}
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-fg-muted">模型</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
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
            <label className="block text-xs font-medium text-fg-muted">人设</label>
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
            <label className="block text-xs font-medium text-fg-muted">会话指令</label>
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

        {/* Save tenant config */}
        <div className="flex items-center gap-3">
          <button
            onClick={saveTenantConfig}
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存租户配置
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
    </div>
  );
}
