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

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  const text = await r.text();
  if (!text) throw new Error(`${path} returned empty body`);
  return JSON.parse(text) as T;
}

export const api = {
  me: () => getJson<Me>("/api/me"),
  models: () => getJson<{ models: ModelListEntry[]; defaultModel: string | null }>("/api/models"),
};
