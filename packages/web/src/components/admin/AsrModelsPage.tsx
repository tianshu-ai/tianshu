import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Trash2, CheckCircle, Loader2, Mic, AlertCircle } from "lucide-react";

interface ModelInfo {
  id: string;
  name: string;
  lang: string;
  size: string;
  description: string;
  installed: boolean;
  downloading: boolean;
  downloadProgress: { progress: number; total: number; status: string; error?: string } | null;
}

export default function AsrModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsDir, setModelsDir] = useState("");
  const [loading, setLoading] = useState(true);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    pollRef.current = setInterval(refresh, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  const download = async (id: string) => {
    await fetch(`/api/admin/asr/models/${id}/download`, {
      method: "POST", credentials: "include",
    });
    refresh();
  };

  const remove = async (id: string) => {
    if (!confirm("确定删除此模型？")) return;
    await fetch(`/api/admin/asr/models/${id}`, {
      method: "DELETE", credentials: "include",
    });
    refresh();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-fg-faint text-sm">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg-default flex items-center gap-2">
          <Mic size={20} />
          语音识别模型
        </h2>
        <p className="mt-1 text-sm text-fg-muted">
          管理本地 ASR 模型。下载后即可使用麦克风语音输入，无需外部 API。
        </p>
        <p className="mt-1 text-xs text-fg-faint font-mono">{modelsDir}</p>
      </div>

      <div className="space-y-3">
        {models.map((m) => (
          <div
            key={m.id}
            className={`rounded-xl border p-4 transition-colors ${
              m.installed
                ? "border-green-500/30 bg-green-500/5"
                : m.downloading
                  ? "border-blue-500/30 bg-blue-500/5"
                  : "border-border-subtle bg-bg-surface"
            }`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm text-fg-default">{m.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-fg-faint">{m.size}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-raised text-fg-faint">{m.lang}</span>
                  {m.installed && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-500 flex items-center gap-0.5">
                      <CheckCircle size={10} /> 已安装
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-fg-muted">{m.description}</p>

                {/* Download progress */}
                {m.downloadProgress && (m.downloadProgress.status === "downloading" || m.downloadProgress.status === "extracting") && (
                  <div className="mt-2">
                    <div className="flex items-center gap-2 text-xs text-blue-400">
                      <Loader2 size={12} className="animate-spin" />
                      {m.downloadProgress.status === "extracting"
                        ? "解压中..."
                        : m.downloadProgress.total > 0
                          ? `下载中... ${Math.round(m.downloadProgress.progress / 1024 / 1024)}/${Math.round(m.downloadProgress.total / 1024 / 1024)} MB`
                          : "下载中..."
                      }
                    </div>
                    {m.downloadProgress.total > 0 && m.downloadProgress.status === "downloading" && (
                      <div className="mt-1 h-1.5 rounded-full bg-bg-raised overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all"
                          style={{ width: `${Math.round((m.downloadProgress.progress / m.downloadProgress.total) * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Error */}
                {m.downloadProgress?.status === "error" && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-red-400">
                    <AlertCircle size={12} />
                    下载失败: {m.downloadProgress.error?.slice(0, 80)}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {m.installed ? (
                  <button
                    onClick={() => remove(m.id)}
                    className="rounded-lg px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 border border-red-500/20 transition-colors"
                  >
                    <Trash2 size={13} className="inline mr-1" />
                    删除
                  </button>
                ) : m.downloading ? (
                  <button disabled className="rounded-lg px-3 py-1.5 text-xs text-blue-400 opacity-60 cursor-wait">
                    <Loader2 size={13} className="inline mr-1 animate-spin" />
                    下载中
                  </button>
                ) : (
                  <button
                    onClick={() => download(m.id)}
                    className="rounded-lg px-3 py-1.5 text-xs text-blue-400 hover:bg-blue-500/10 border border-blue-500/20 transition-colors"
                  >
                    <Download size={13} className="inline mr-1" />
                    下载
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border-subtle bg-bg-surface p-4 text-xs text-fg-muted space-y-1">
        <p><strong>工作原理：</strong>模型下载到服务器本地，浏览器录音后发到服务器识别，结果返回到输入框。</p>
        <p><strong>依赖：</strong>需要 ffmpeg（音频转码）。运行 <code className="bg-bg-raised px-1 rounded">ffmpeg -version</code> 确认已安装。</p>
        <p><strong>跨平台：</strong>sherpa-onnx-node 支持 macOS / Linux / Windows，无需 Python。</p>
      </div>
    </div>
  );
}
