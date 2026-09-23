// Custom config form for the image-gen plugin.
// Renders a dynamic model dropdown (populated from
// /api/p/image-gen/status) instead of forcing the user to type
// a full model ID.

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { api, type PluginListEntry } from "../lib/api";
import { usePluginStore } from "../stores/plugin-store";

interface ImageGenModel {
  id: string;
  providerId: string;
  modelId: string;
  api: string;
}

interface StatusResponse {
  available: boolean;
  selectedModelId: string | null;
  models: ImageGenModel[];
  defaultAspectRatio: string;
}

const INPUT =
  "w-full rounded-md border border-border-default bg-bg-elevated px-3 py-1.5 text-[12px] text-fg-default outline-none focus:border-brand-500";

const ASPECT_OPTIONS = [
  { value: "1:1", label: "1:1 (Square)" },
  { value: "16:9", label: "16:9 (Landscape)" },
  { value: "9:16", label: "9:16 (Portrait)" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
];

export function ImageGenConfigForm({ plugin }: { plugin: PluginListEntry }) {
  const setPlugins = usePluginStore((s) => s.setPlugins);
  const [models, setModels] = useState<ImageGenModel[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelId, setModelId] = useState<string>(
    typeof plugin.config?.modelId === "string" ? plugin.config.modelId : "",
  );
  const [aspectRatio, setAspectRatio] = useState<string>(
    typeof plugin.config?.defaultAspectRatio === "string"
      ? plugin.config.defaultAspectRatio
      : "1:1",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Load available image-gen models from the plugin's status route.
  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    fetch("/api/p/image-gen/status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: StatusResponse | null) => {
        if (cancelled || !d) return;
        setModels(d.models ?? []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plugin.version]);

  // Sync from store when config changes elsewhere.
  useEffect(() => {
    setModelId(
      typeof plugin.config?.modelId === "string" ? plugin.config.modelId : "",
    );
    setAspectRatio(
      typeof plugin.config?.defaultAspectRatio === "string"
        ? plugin.config.defaultAspectRatio
        : "1:1",
    );
    setSavedAt(null);
  }, [plugin.id, plugin.config]);

  const currentModelId =
    typeof plugin.config?.modelId === "string" ? plugin.config.modelId : "";
  const currentAspect =
    typeof plugin.config?.defaultAspectRatio === "string"
      ? plugin.config.defaultAspectRatio
      : "1:1";
  const dirty = modelId !== currentModelId || aspectRatio !== currentAspect;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const r = await api.setPluginConfig(plugin.id, {
        modelId: modelId || undefined,
        defaultAspectRatio: aspectRatio,
      });
      setPlugins(r.plugins);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const hasModels = models.length > 0;
  const selectedIsMissing =
    !!modelId && !models.some((m) => m.id === modelId);

  return (
    <div className="space-y-5">
      {/* Model selector */}
      <div>
        <label className="mb-1 block text-[12px] font-medium text-fg-default">
          Model
        </label>
        {loadingModels ? (
          <div className="flex items-center gap-2 text-[12px] text-fg-faint">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading available models…
          </div>
        ) : !hasModels ? (
          <div className="flex items-start gap-2 rounded-md border border-warn-500/40 bg-warn-500/10 px-3 py-2 text-[12px] text-fg-default">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warn-500" />
            <div>
              No image-gen models found. Go to{" "}
              <a href="/admin/core/models" className="underline">
                Settings → Models
              </a>{" "}
              and add a model with mode <code>image-gen</code>.
            </div>
          </div>
        ) : (
          <>
            <select
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className={INPUT}
            >
              <option value="">— Use first available —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
              {selectedIsMissing && (
                <option value={modelId}>{modelId} (not in models)</option>
              )}
            </select>
            <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
              Which image-gen model to use for the <code>generate_image</code>{" "}
              tool. Leave blank to use the first available.
            </p>
            {selectedIsMissing && (
              <p className="mt-1 text-[11px] text-warn-500">
                The currently selected model is not in the models list. It may
                have been removed from Settings → Models.
              </p>
            )}
          </>
        )}
      </div>

      {/* Aspect ratio */}
      <div>
        <label className="mb-1 block text-[12px] font-medium text-fg-default">
          Default Aspect Ratio
        </label>
        <select
          value={aspectRatio}
          onChange={(e) => setAspectRatio(e.target.value)}
          className={INPUT}
        >
          {ASPECT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
          Default aspect ratio when not specified in the prompt.
        </p>
      </div>

      {/* Save / status */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && !dirty && (
          <span className="flex items-center gap-1 text-[12px] text-ok-500">
            <CheckCircle2 className="h-3 w-3" />
            Saved
          </span>
        )}
        {error && <span className="text-[12px] text-danger-500">{error}</span>}
      </div>
    </div>
  );
}
