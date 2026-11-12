/**
 * Moss-Live realtime voice settings page.
 *
 * Lets users configure:
 *   - API Key (from platform.moss.cn)
 *   - Model (default: moss-live-1.0)
 *   - Persona prompt
 *   - Instructions
 */

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader2, Save } from "lucide-react";

interface MossLiveConfig {
  apiKey?: string;
  model?: string;
  persona?: string;
  instructions?: string;
}

export default function MossLiveSettingsPage() {
  const [config, setConfig] = useState<MossLiveConfig>({});
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
          setConfig(await res.json());
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
        setError(`Save failed: ${res.status}`);
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
        <input
          type="text"
          value={config.model || ""}
          onChange={(e) => setConfig({ ...config, model: e.target.value })}
          placeholder="moss-live-1.0 (��认)"
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Persona */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-fg-default">人设</label>
        <textarea
          value={config.persona || ""}
          onChange={(e) => setConfig({ ...config, persona: e.target.value })}
          placeholder="你是天枢AI助手..."
          rows={3}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
        <p className="text-xs text-fg-faint">最多 8000 字符</p>
      </div>

      {/* Instructions */}
      <div className="space-y-1.5">
        <label className="block text-sm font-medium text-fg-default">会话指令</label>
        <textarea
          value={config.instructions || ""}
          onChange={(e) => setConfig({ ...config, instructions: e.target.value })}
          placeholder="回答简洁，中文为主..."
          rows={2}
          className="w-full rounded-lg border border-border-default bg-bg-base px-3 py-2 text-sm text-fg-default placeholder:text-fg-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
      </div>

      {/* Save button */}
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
