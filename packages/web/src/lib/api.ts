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

export type PluginConfigField =
  | { kind: "boolean"; key: string; label: string; description?: string; default?: boolean }
  | {
      kind: "number";
      key: string;
      label: string;
      description?: string;
      default?: number;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
    }
  | {
      kind: "string";
      key: string;
      label: string;
      description?: string;
      default?: string;
      placeholder?: string;
      multiline?: boolean;
    };

export interface PluginConfigSchema {
  fields: PluginConfigField[];
}

export interface PluginListEntry {
  id: string;
  version: string;
  displayName: string;
  description: string | null;
  source: "builtin" | "tenant";
  state: PluginState;
  failedReason: string | null;
  contributes: Record<string, unknown>;
  /** manifest.client.entry — null when the plugin has no client side. */
  clientEntry: string | null;
  /** Declarative form schema; null when the plugin doesn't accept
   *  user-editable config. */
  configSchema: PluginConfigSchema | null;
  /** Persisted user-supplied config object. Empty when defaults. */
  config: Record<string, unknown>;
  /** ADR-0004 §3. Capabilities the plugin provides / requires, plus
   *  any required ones that no provider satisfied (only non-empty for
   *  failed plugins). */
  capabilities: {
    provided: string[];
    requires: string[];
    missing: string[];
  };
}

export interface CatalogEntry {
  id: string;
  displayName: string;
  description: string;
  author: string;
  verified: boolean;
  repository: string;
  homepage?: string;
  license?: string;
  tags: string[];
  latestVersion: string;
  tarballUrl: string;
  tarballSha256: string;
  tarballSize?: number;
  tianshuRange: string;
}

export interface CatalogSnapshot {
  source: string;
  fetchedAt: string;
  catalogUpdatedAt: string | null;
  entries: CatalogEntry[];
  entriesDropped: number;
}

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  const text = await r.text();
  if (!text) throw new Error(`${path} returned empty body`);
  return JSON.parse(text) as T;
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  return mutateJson<T>(path, "PATCH", body);
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  return mutateJson<T>(path, "POST", body);
}

async function mutateJson<T>(
  path: string,
  method: "PATCH" | "POST",
  body?: unknown,
): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  setPluginConfig: (id: string, config: Record<string, unknown>) =>
    patchJson<{ plugins: PluginListEntry[] }>(`/api/plugins/${encodeURIComponent(id)}`, {
      config,
    }),
  /** ADR-0004 §16: explicit re-discovery of on-disk plugins. */
  refreshPlugins: () => postJson<{ plugins: PluginListEntry[] }>("/api/plugins/refresh"),
  pluginCatalog: () => getJson<CatalogSnapshot>("/api/plugins/catalog"),
  refreshPluginCatalog: () => postJson<CatalogSnapshot>("/api/plugins/catalog/refresh"),
};
