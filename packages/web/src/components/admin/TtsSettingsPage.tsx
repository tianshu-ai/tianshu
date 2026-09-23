// TTS settings page.
//
// Yu, 2026-09-19: added when Yu asked to make TTS provider switchable.
// Yu, 2026-09-20: switched from CosyVoice/Kokoro to Qwen3-TTS MLX.
//   CosyVoice (RTF 6x, too slow) and Kokoro (82M, sounds like edge-tts)
//   are removed. Only Edge TTS (cloud) and Qwen3-TTS (local MLX) remain.
//
// Provider choices:
//   - edge (default): Microsoft Edge online TTS via @andresaya/edge-tts.
//     Cloud-based, no local model needed, ~15 Chinese voices, good
//     quality but personal-use only per Microsoft EULA.
//   - qwentts: Local Qwen3-TTS 0.6B MLX server on Apple Silicon.
//     RTF ~0.3x, 9 preset voices, 10 languages. Fully offline.
//     See scripts/QWEN3_TTS_SETUP.md for setup instructions.
//
// Config split:
//   - provider + voice: stored in user_preferences (per-user, per-tenant,
//     cross-device). Reason: these are usage preferences.
//   - TTS_URL: server env only. Reason: infra config, per-server not
//     per-user.

import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  RefreshCw,
  Speaker,
} from "lucide-react";
import { useVoiceStore } from "../../stores/voice-store";
import { useT } from "../../hooks/useT";

/** Provider slugs the server understands (see routes-tts.ts). */
type TtsProvider = "edge" | "qwentts";

/** Human-friendly labels for known custom voices (from voices/ ref audio). */
const VOICE_LABELS: Record<string, string> = {
  yujie: "御姐 (中文女, 默认)",
  nansheng: "温柔男声 (中文男)",
  huopo: "活泼女声 (中文女)",
  boyin: "播音腔 (中文男)",
  jenny: "Jenny (English female)",
  guy: "Guy (English male)",
};

const EDGE_VOICES: Array<{ id: string; label: string }> = [
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
];

interface TtsStatus {
  providerDefault: TtsProvider;
  ttsUrl: string;
  ttsReachable: boolean | null;
  /** Dynamic voice list from the local TTS server's /health endpoint. */
  qwenttsVoices: Array<{ id: string; label: string }>;
}

export default function TtsSettingsPage() {
  const t = useT();
  const [status, setStatus] = useState<TtsStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [provider, setProvider] = useState<TtsProvider>("edge");
  const [voice, setVoice] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  /** Build voice list for a provider. */
  const voicesFor = useCallback(
    (p: TtsProvider): Array<{ id: string; label: string }> => {
      if (p === "edge") return EDGE_VOICES;
      return status?.qwenttsVoices ?? [];
    },
    [status],
  );

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
      // Normalize legacy field names from status endpoint
      const s = statusRes as any;

      // Build qwentts voice list from the server's /health response
      // which is proxied through /api/tts/status
      const customVoices: string[] = s.customVoices ?? s.custom_voices ?? [];
      const presetVoices: string[] = s.presetVoices ?? s.preset_voices ?? [];
      const defaultVoice: string = s.defaultVoice ?? s.default_voice ?? "";
      const qwenttsVoices: Array<{ id: string; label: string }> = [];
      // Put default voice first
      const allNames = [
        ...new Set([
          ...(defaultVoice ? [defaultVoice] : []),
          ...customVoices,
          ...presetVoices,
        ]),
      ];
      for (const name of allNames) {
        const label = VOICE_LABELS[name] ?? name;
        qwenttsVoices.push({ id: name, label });
      }

      const normalized: TtsStatus = {
        providerDefault: s.providerDefault || "edge",
        ttsUrl: s.ttsUrl || s.cosyvoiceUrl || "",
        ttsReachable: s.ttsReachable ?? s.cosyvoiceReachable ?? null,
        qwenttsVoices,
      };
      setStatus(normalized);
      const chosenProvider =
        (providerPref?.value as TtsProvider) ||
        normalized.providerDefault ||
        "edge";
      setProvider(chosenProvider);
      const voices = chosenProvider === "edge" ? EDGE_VOICES : qwenttsVoices;
      const chosenVoice =
        (voicePref?.value as string) ||
        voices[0]?.id ||
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

  const changeProvider = useCallback(
    async (next: TtsProvider) => {
      setProvider(next);
      const voices = voicesFor(next);
      const validVoice = voices.some((v) => v.id === voice);
      const nextVoice = validVoice ? voice : voices[0]?.id || "";
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
    [voice, voicesFor],
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

  const playVoice = useVoiceStore((s) => s.play);
  const testVoice = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    try {
      await playVoice({
        id: "tts-settings-preview",
        text: "你好，我是天枢。这是一段声音测试。",
        voice,
        provider,
      });
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [provider, voice, playVoice]);

  const localTtsOffline =
    status?.ttsReachable === false && provider === "qwentts";

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-fg-default">
            <Speaker size={22} />
            {t("tts.title")}
          </h1>
          <p className="mt-2 text-sm text-fg-muted">
            {t("tts.subtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-fg-muted hover:text-fg-default"
          disabled={statusLoading}
          title={t("tts.refreshTooltip")}
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
            {t("tts.statusError", { error: statusError ?? "" })}
          </div>
        </div>
      )}

      {status && (
        <div className="space-y-6">
          {/* Provider selection */}
          <section className="rounded-lg border border-border bg-bg-raised/40 p-4">
            <h2 className="mb-3 text-sm font-medium text-fg-default">
              {t("tts.engine")}
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
                    {t("tts.edge.name")}
                  </div>
                  <div className="text-xs text-fg-muted mt-0.5">
                    {t("tts.edge.desc")}
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-3 rounded-md border border-border p-3 hover:bg-bg-raised/60 cursor-pointer">
                <input
                  type="radio"
                  name="provider"
                  value="qwentts"
                  checked={provider === "qwentts"}
                  onChange={() => changeProvider("qwentts")}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-fg-default">
                    {t("tts.qwentts.name")}
                  </div>
                  <div className="text-xs text-fg-muted mt-0.5">
                    {t("tts.qwentts.desc")}
                  </div>
                  <div className="text-xs text-fg-faint mt-1.5">
                    {t("tts.serverUrl")}{" "}
                    <code className="text-fg-muted">{status.ttsUrl}</code>
                    {status.ttsReachable === true && (
                      <span className="ml-2 inline-flex items-center gap-1 text-ok">
                        <CheckCircle size={12} /> {t("tts.reachable")}
                      </span>
                    )}
                    {status.ttsReachable === false && (
                      <span className="ml-2 inline-flex items-center gap-1 text-warn">
                        <AlertCircle size={12} /> {t("tts.unreachable")}
                      </span>
                    )}
                  </div>
                </div>
              </label>
            </div>

            {localTtsOffline && (
              <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <div>
                  {t("tts.offlineHint")}
                </div>
              </div>
            )}
          </section>

          {/* Voice selection */}
          <section className="rounded-lg border border-border bg-bg-raised/40 p-4">
            <h2 className="mb-3 text-sm font-medium text-fg-default">
              {t("tts.voice")}
            </h2>
            <select
              value={voice}
              onChange={(e) => changeVoice(e.target.value)}
              className="w-full rounded-md border border-border-strong bg-bg-elevated px-3 py-2 text-sm text-fg-default"
            >
              {voicesFor(provider).map((v) => (
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
                    {t("tts.previewing")}
                  </span>
                ) : (
                  t("tts.preview")
                )}
              </button>
              {saving && (
                <span className="text-xs text-fg-faint">{t("tts.saving")}</span>
              )}
              {testError && (
                <span className="text-xs text-danger">{t("tts.previewFailed", { error: testError ?? "" })}</span>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
