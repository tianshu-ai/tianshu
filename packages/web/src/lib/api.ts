// Thin REST helpers. Keeps fetch boilerplate out of components.

export interface Me {
  tenantId: string;
  userId: string;
  config: { branding: { name?: string; emoji?: string } | null };
  defaultModel: { id: string; name: string; provider: string } | null;
  devTenant: boolean;
}

export interface ModelListEntry {
  id: string;
  name: string;
  provider: string;
  group: string | null;
  contextWindow: number;
  reasoning: boolean;
}

// Plugin Manager types — mirrored from server `PluginListEntry`
// (ADR-0003 §8). Keep these in sync if the server shape changes.
export type PluginState = "active" | "disabled" | "failed" | "client-bundle-missing";

export interface PluginListEntry {
  id: string;
  version: string;
  displayName: string;
  description: string | null;
  source: "builtin" | "tenant";
  state: PluginState;
  failedReason: string | null;
  contributes: Record<string, unknown>;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  const text = await r.text();
  if (!text) throw new Error(`${path} returned empty body`);
  return JSON.parse(text) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    let message = `${path} → ${r.status}`;
    try {
      const parsed = text ? JSON.parse(text) : null;
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        message = `${message} (${(parsed as { error: string }).error})`;
      }
    } catch {
      /* swallow JSON parse errors — keep the status-code message */
    }
    throw new Error(message);
  }
  return JSON.parse(text) as T;
}

export const api = {
  me: () => getJson<Me>("/api/me"),
  models: () => getJson<{ models: ModelListEntry[]; defaultModel: string | null }>("/api/models"),
  plugins: () => getJson<{ plugins: PluginListEntry[] }>("/api/plugins"),
  setPluginEnabled: (id: string, enabled: boolean) =>
    patchJson<{ plugins: PluginListEntry[] }>(`/api/plugins/${encodeURIComponent(id)}`, {
      enabled,
    }),
};
