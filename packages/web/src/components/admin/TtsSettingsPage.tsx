// TTS settings page.
//
// Yu, 2026-09-19: added when Yu asked to make TTS provider switchable
// and treat CosyVoice as an external service.
//
// Provider choices:
//   - edge (default): Microsoft Edge online TTS via @andresaya/edge-tts.
//     Cloud-based, no local model needed, ~15 Chinese voices, good
//     quality but personal-use only per Microsoft EULA.
//   - cosyvoice: Local CosyVoice 2 FastAPI server, controlled entirely
//     outside tianshu — the user starts it on their machine at the URL
//     configured server-side via env TTS_URL (default localhost:50000).
//     tianshu just forwards HTTP requests to it.
//
// Config split:
//   - provider + voice: stored in user_preferences (per-user, per-tenant,
//     cross-device). Reason: these are usage preferences.
//   - TTS_URL for CosyVoice: server env only. Reason: infra config,
//     changes when Yu moves the CosyVoice service, per-server not
//     per-user.
//
// This page exposes provider + voice; the CosyVoice URL is shown
// read-only (fetched from a status endpoint) so the user can verify
// what the server is pointed at without letting them accidentally
// break routing for other users on the same tenant.

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  RefreshCw,
  Speaker,
} from "lucide-react";

/** Provider slugs the server understands (see routes-tts.ts). */
type TtsProvider = "edge" | "cosyvoice";

/**
 * Voice options grouped by provider. Kept in the client rather than
 * fetched from the server because these lists are effectively static
 * per provider — edge voices come from Microsoft's Speech catalogue,
 * CosyVoice SFT ids are model-baked. If we ever add a "load voices
 * from server" endpoint we can swap this out.
 */
const VOICES: Record<TtsProvider, Array<{ id: string; label: string }>> = {
  edge: [
    { id: "zh-CN-XiaoxiaoNeural", label: "晓晓 (中文女, 默认)" },
    { id: "zh-CN-YunxiNeural", label: "云希 (中文男)" },
    { id: "zh-CN-YunyangNeural", label: "云扬 (中文男, 新闻)" },
    { id: "zh-CN-XiaoyiNeural", label: "晓伊 (中文女, 少女)" },
    { id: "zh-CN-YunjianNeural", label: "云健 (中文男, 沉稳)" },
    { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北 (东北女)" },
    { id: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮 (陕西女)" },
    { id: "zh-HK-HiuMaanNeural", label: "曉曼 (粤语女)" },
    { id: "zh-TW-HsiaoChenNeural", label: "曉臻 (台湾女)" },
    { id: "en-US-AriaNeural", label: "Aria (English female)" },
    { id: "en-US-GuyNeural", label: "Guy (English male)" },
    { id: "en-GB-SoniaNeural", label: "Sonia (British female)" },
    { id: "ja-JP-NanamiNeural", label: "Nanami (Japanese female)" },
  ],
  cosyvoice: [
    { id: "中文女", label: "中文女 (默认)" },
    { id: "中文男", label: "中文男" },
    { id: "粤语女", label: "粤语女" },
    { id: "英文女", label: "英文女" },
    { id: "英文男", label: "英文男" },
    { id: "日语男", label: "日语男" },
    { id: "韩语女", label: "韩语女" },
  ],
};

interface TtsStatus {
  /** Server's TTS_PROVIDER env default. */
  providerDefault: TtsProvider;
  /** Server's TTS_URL env — where cosyvoice is expected to be. */
  cosyvoiceUrl: string;
  /** Ping result — did tianshu reach the cosyvoice server just now? */
  cosyvoiceReachable: boolean | null;
}

export default function TtsSettingsPage() {
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [provider, setProvider] = useState<TtsProvider>("edge");
  const [voice, setVoice] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  // Load server status + user preferences.
  const refresh = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const [statusRes, providerPref, voicePref] = await Promise.all([
        fetch("/api/tts/status", { credentials: "include" }).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
        ),
        fetch("/api/preferences/tts.provider", { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
        fetch("/api/preferences/tts.voice", { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      setStatus(statusRes as TtsStatus);
      const chosenProvider =
        (providerPref?.value as TtsProvider) ||
        (statusRes as TtsStatus).providerDefault ||
        "edge";
      setProvider(chosenProvider);
      const chosenVoice =
        (voicePref?.value as string) ||
        VOICES[chosenProvider][0]?.id ||
        "";
      setVoice(chosenVoice);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // When provider changes, default voice to the first entry for that
  // provider (unless the current voice is still valid for the new
  // provider, which is rare across the edge/cosyvoice split).
  const changeProvider = useCallback(
    async (next: TtsProvider) => {
      setProvider(next);
      const validVoice = VOICES[next].some((v) => v.id === voice);
      const nextVoice = validVoice ? voice : VOICES[next][0]?.id || "";
      setVoice(nextVoice);
      setSaving(true);
      try {
        await Promise.all([
          fetch("/api/preferences/tts.provider", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: next }),
          }),
          fetch("/api/preferences/tts.voice", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ value: nextVoice }),
          }),
        ]);
      } finally {
        setSaving(false);
      }
    },
    [voice],
  );

  const changeVoice = useCallback(async (next: string) => {
    setVoice(next);
    setSaving(true);
    try {
      await fetch("/api/preferences/tts.voice", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: next }),
      });
    } finally {
      setSaving(false);
    }
  }, []);

  // Preview: hit /api/tts with a short canned string and play the
  // resulting audio. Lets the user hear the voice before committing
  // to using it in chat.
  const testVoice = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "你好，我是天枢。这是一段声音测试。",
          voice,
          provider,
        }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch {
          // ignore non-json errors
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url));
      await audio.play();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [provider, voice]);

  const cosyvoiceOffline =
    status?.cosyvoiceReachable === false && provider === "cosyvoice";

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <Speaker size={22} />
            语音合成 (TTS)
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            配置助手回复时使用哪个 TTS 引擎与发音人。开启语音模式后，助手回复会自动朗读。
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-fg-muted hover:text-fg-default"
          disabled={statusLoading}
          title="刷新服务器状态"
        >
          <RefreshCw
            size={14}
            className={statusLoading ? "animate-spin" : ""}
          />
        </button>
      </div>

      {statusError && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-danger/50 bg-danger/10 px-3 py-2 text-sm text-danger">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <div className="flex-1">
            无法读取 TTS 状态: {statusError}
          </div>
        </div>
      )}

      {status && (
        <div className="space-y-6">
          {/* Provider selection */}
          <section className="rounded-lg border border-border bg-bg-raised/40 p-4">
            <h2 className="mb-3 text-sm font-medium text-fg-default">
              引擎
            </h2>
            <div className="space-y-2">
              <label className="flex items-start gap-3 rounded-md border border-border p-3 hover:bg-bg-raised/60 cursor-pointer">
                <input
                  type="radio"
                  name="provider"
                  value="edge"
                  checked={provider === "edge"}
                  onChange={() => changeProvider("edge")}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-fg-default">
                    Edge TTS (微软云)
                  </div>
                  <div className="text-xs text-fg-muted mt-0.5">
                    无需本地部署，云端合成。中英日粤多语言，音质接近生产级。
                    个人 / 开发使用免费；商用需符合微软 EULA。
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-md border border-border p-3 hover:bg-bg-raised/60 cursor-pointer">
                <input
                  type="radio"
                  name="provider"
                  value="cosyvoice"
                  checked={provider === "cosyvoice"}
                  onChange={() => changeProvider("cosyvoice")}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-fg-default">
                    CosyVoice 2 (本地)
                  </div>
                  <div className="text-xs text-fg-muted mt-0.5">
                    阿里达摩院开源 (Apache 2.0)，本地部署，无需联网。
                    首包 ~150ms，支持中英日韩粤等多语言与方言。
                  </div>
                  <div className="text-xs text-fg-faint mt-1.5">
                    服务地址 (env <code>TTS_URL</code>):{" "}
                    <code className="text-fg-muted">{status.cosyvoiceUrl}</code>
                    {status.cosyvoiceReachable === true && (
                      <span className="ml-2 inline-flex items-center gap-1 text-ok">
                        <CheckCircle size={12} /> 可达
                      </span>
                    )}
                    {status.cosyvoiceReachable === false && (
                      <span className="ml-2 inline-flex items-center gap-1 text-warn">
                        <AlertCircle size={12} /> 未响应
                      </span>
                    )}
                  </div>
                </div>
              </label>
            </div>

            {cosyvoiceOffline && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  CosyVoice 服务未启动，选择此引擎后语音合成会失败。
                  参考{" "}
                  <code className="text-amber-100">
                    scripts/COSYVOICE_SETUP.md
                  </code>{" "}
                  启动本地服务。
                </div>
              </div>
            )}
          </section>

          {/* Voice selection */}
          <section className="rounded-lg border border-border bg-bg-raised/40 p-4">
            <h2 className="mb-3 text-sm font-medium text-fg-default">
              发音人
            </h2>
            <select
              value={voice}
              onChange={(e) => changeVoice(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-bg-elevated px-3 py-2 text-sm text-fg-default"
            >
              {VOICES[provider].map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={testVoice}
                disabled={testing || saving}
                className="rounded-md bg-accent-fill px-3 py-1.5 text-xs font-medium text-accent-fg hover:opacity-90 disabled:opacity-50"
              >
                {testing ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" />
                    合成中…
                  </span>
                ) : (
                  "试听"
                )}
              </button>
              {saving && (
                <span className="text-xs text-fg-faint">保存中…</span>
              )}
              {testError && (
                <span className="text-xs text-danger">试听失败: {testError}</span>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
