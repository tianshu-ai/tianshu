import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Trash2, CheckCircle, Loader2, Mic, AlertCircle, CircleDot, RefreshCw } from "lucide-react";
import { useT } from "../../hooks/useT";

interface ModelInfo {
  id: string;
  name: string;
  lang: string;
  size: string;
  description: string;
  installed: boolean;
  active: boolean;
  downloading: boolean;
  downloadProgress: { progress: number; total: number; status: string; error?: string } | null;
}

export default function AsrModelsPage() {
  const t = useT();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsDir, setModelsDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [shortcut, setShortcut] = useState("ctrl+shift+m");
  const [recordingKey, setRecordingKey] = useState(false);
  const [runtimeInstalled, setRuntimeInstalled] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load shortcut preference + runtime status
  useEffect(() => {
    fetch("/api/transcribe/status", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setRuntimeInstalled(d.runtimeInstalled !== false))
      .catch(() => {});
    fetch("/api/preferences/asr.shortcut", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (d.value) setShortcut(d.value); })
      .catch(() => {});
  }, []);

  const saveShortcut = async (value: string) => {
    setShortcut(value);
    await fetch("/api/preferences/asr.shortcut", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  };

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/asr/models", { credentials: "include" });
      const data = await res.json();
      setModels(data.models ?? []);
      setModelsDir(data.modelsDir ?? "");
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    refresh();
    // Poll while any download is active
    pollRef.current = setInterval(refresh, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  const activate = async (id: string) => {
    await fetch(`/api/admin/asr/models/${id}/activate`, { method: "POST", credentials: "include" });
    refresh();
  };

  const download = async (id: string) => {
    await fetch(`/api/admin/asr/models/${id}/download`, { method: "POST", credentials: "include" });
    refresh();
  };

  const remove = async (id: string) => {
    if (!confirm(t("asr.deleteConfirm"))) return;
    await fetch(`/api/admin/asr/models/${id}`, { method: "DELETE", credentials: "include" });
    refresh();
  };

  const installedCount = models.filter((m) => m.installed).length;

  return (
    <div className="mx-auto max-w-5xl p-6">
      {/* Header — matches ModelsPage / AuthPage pattern */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <Mic size={18} className="text-link" />
            {t("asr.title")}
          </h1>
          <p className="mt-1 max-w-3xl text-[12px] text-fg-faint">
            {t("asr.subtitle")}{" "}
            <span className="text-fg-muted">
              {installedCount}/{models.length} {t("asr.installed").toLowerCase()}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-fg-fainter font-mono">{modelsDir}</p>
        </div>
        <button
          type="button"
          onClick={() => { setLoading(true); refresh(); }}
          disabled={loading}
          className="flex items-center gap-1.5 rounded-md border border-border-default px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg-default disabled:opacity-50"
        >
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          {t("common.reload")}
        </button>
      </div>

      {/* Runtime install hint */}
      {!runtimeInstalled && (
        <div className="flex items-start gap-2 rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <AlertCircle size={15} className="mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">{t("asr.runtimeMissing")}</p>
            <p className="mt-0.5 text-xs text-amber-300/80">{t("asr.runtimeInstallHint")}</p>
            <code className="mt-1 block rounded bg-black/30 px-2 py-1 text-xs font-mono text-amber-100">npm install sherpa-onnx-node</code>
          </div>
        </div>
      )}

      {/* Model list */}
      <div className="space-y-2">
        {models.map((m) => {
          const nameKey = `asr.model.${m.id}.name`;
          const descKey = `asr.model.${m.id}.desc`;
          const translatedName = t(nameKey) !== nameKey ? t(nameKey) : m.name;
          const translatedDesc = t(descKey) !== descKey ? t(descKey) : m.description;
          const dp = m.downloadProgress;
          const isActive = m.installed && m.active;

          return (
            <div
              key={m.id}
              className={`flex items-center gap-4 rounded-md border px-4 py-3 ${
                isActive
                  ? "border-link/30 bg-link/5"
                  : m.installed
                    ? "border-emerald-700/30 bg-emerald-950/10"
                    : m.downloading
                      ? "border-blue-700/30 bg-blue-950/10"
                      : "border-border-subtle bg-bg-surface"
              }`}
            >
              {/* Left: info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-fg-default">{translatedName}</span>
                  <span className="text-[10px] rounded border border-border-subtle px-1.5 py-0.5 text-fg-faint">{m.size}</span>
                  <span className="text-[10px] rounded border border-border-subtle px-1.5 py-0.5 text-fg-faint">{m.lang}</span>
                  {isActive && (
                    <span className="text-[10px] rounded bg-link/20 px-1.5 py-0.5 text-link flex items-center gap-0.5">
                      <CircleDot size={9} /> {t("asr.active")}
                    </span>
                  )}
                  {m.installed && !isActive && (
                    <span className="text-[10px] rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-400 flex items-center gap-0.5">
                      <CheckCircle size={9} /> {t("asr.installed")}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-fg-faint">{translatedDesc}</p>

                {/* Progress bar */}
                {dp && (dp.status === "downloading" || dp.status === "extracting") && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <Loader2 size={11} className="animate-spin text-link" />
                    <span className="text-[11px] text-link">
                      {dp.status === "extracting"
                        ? t("asr.extracting")
                        : dp.total > 0
                          ? t("asr.downloadingProgress")
                              .replace("{current}", String(Math.round(dp.progress / 1048576)))
                              .replace("{total}", String(Math.round(dp.total / 1048576)))
                          : `${t("asr.downloading")}...`}
                    </span>
                    {dp.total > 0 && dp.status === "downloading" && (
                      <div className="flex-1 h-1 rounded-full bg-bg-raised overflow-hidden">
                        <div className="h-full bg-link rounded-full transition-all" style={{ width: `${Math.round((dp.progress / dp.total) * 100)}%` }} />
                      </div>
                    )}
                  </div>
                )}
                {dp?.status === "error" && (
                  <div className="mt-1 flex items-center gap-1 text-[11px] text-danger">
                    <AlertCircle size={11} /> {t("asr.downloadFailed")}: {dp.error?.slice(0, 60)}
                  </div>
                )}
              </div>

              {/* Right: actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {m.installed ? (
                  <>
                    {!isActive && (
                      <button
                        onClick={() => activate(m.id)}
                        className="rounded-md px-3 py-1.5 text-xs text-link hover:bg-link/10 border border-link/20 transition-colors"
                      >
                        {t("asr.activate")}
                      </button>
                    )}
                    <button
                      onClick={() => remove(m.id)}
                      className="rounded-md p-1.5 text-fg-faint hover:text-danger hover:bg-danger/10 transition-colors"
                      title={t("asr.delete")}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : m.downloading ? (
                  <button disabled className="rounded-md px-3 py-1.5 text-xs text-link opacity-50 cursor-wait border border-link/20">
                    <Loader2 size={12} className="inline mr-1 animate-spin" />
                    {t("asr.downloading")}
                  </button>
                ) : (
                  <button
                    onClick={() => download(m.id)}
                    className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg-default border border-border-default transition-colors"
                  >
                    <Download size={13} />
                    {t("asr.download")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Shortcut config */}
      <div className="mt-6 rounded-md border border-border-subtle bg-bg-surface px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-fg-default">{t("asr.shortcutLabel")}</p>
            <p className="text-[11px] text-fg-faint mt-0.5">{t("asr.shortcutHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={recordingKey ? t("asr.pressKeys") : shortcut}
              onFocus={() => setRecordingKey(true)}
              onBlur={() => setRecordingKey(false)}
              onKeyDown={(e) => {
                if (!recordingKey) return;
                e.preventDefault();
                const parts: string[] = [];
                if (e.ctrlKey) parts.push("ctrl");
                if (e.metaKey) parts.push("meta");
                if (e.altKey) parts.push("alt");
                if (e.shiftKey) parts.push("shift");
                const key = e.key.toLowerCase();
                if (!["control", "shift", "alt", "meta"].includes(key)) {
                  parts.push(key);
                  const combo = parts.join("+");
                  saveShortcut(combo);
                  setRecordingKey(false);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="w-48 rounded-md border border-border-default bg-bg-base px-3 py-1.5 text-xs text-fg-default text-center font-mono focus:border-link focus:outline-none cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Footer note */}
      <div className="mt-6 rounded-md border border-border-subtle bg-bg-surface px-4 py-3 text-[11px] text-fg-faint space-y-0.5">
        <p><strong>{t("asr.howItWorks")}:</strong> {t("asr.howItWorksDesc")}</p>
        <p><strong>{t("asr.dependency")}:</strong> {t("asr.dependencyDesc")}</p>
        <p><strong>{t("asr.crossPlatform")}:</strong> {t("asr.crossPlatformDesc")}</p>
      </div>
    </div>
  );
}
