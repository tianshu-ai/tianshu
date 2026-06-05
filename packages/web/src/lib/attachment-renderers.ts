// Pure helpers for resolving which plugin renderer should display a
// given attachment. Lives in `lib` (not `components`) because the
// matching logic is portable and easy to test in isolation.

import type { PluginListEntry } from "./api";

export interface ContributesAttachmentRenderer {
  id: string;
  mimePattern: string;
  component: string;
  order?: number;
}

interface ContributesShape {
  attachmentRenderers?: ContributesAttachmentRenderer[];
}

export interface FlatRenderer extends ContributesAttachmentRenderer {
  pluginId: string;
  pluginVersion: string;
  pluginDisplayName: string;
  clientEntry: string | null;
}

/** Build the merged, ordered renderer list from active plugins.
 *  The host calls this once per render of the chat — it's cheap. */
export function collectRenderers(plugins: PluginListEntry[]): FlatRenderer[] {
  const out: FlatRenderer[] = [];
  for (const p of plugins) {
    if (p.state !== "active") continue;
    const c = (p.contributes as ContributesShape).attachmentRenderers ?? [];
    for (const r of c) {
      out.push({
        ...r,
        pluginId: p.id,
        pluginVersion: p.version,
        pluginDisplayName: p.displayName,
        clientEntry: p.clientEntry,
      });
    }
  }
  // Smaller order = checked first. Stable tie-break by plugin id +
  // contribution id so two plugins claiming `image/*` resolve
  // deterministically across reloads.
  out.sort((a, b) => {
    const ao = a.order ?? 100;
    const bo = b.order ?? 100;
    if (ao !== bo) return ao - bo;
    const ka = `${a.pluginId}.${a.id}`;
    const kb = `${b.pluginId}.${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return out;
}

/**
 * Match a mime type against a manifest pattern.
 *
 * Patterns:
 *   - `<type>/<subtype>` strict equality (case-insensitive type)
 *   - `<type>/*` matches any subtype of <type>
 *   - `*\/*` matches everything
 *
 * Mime types are matched on the `type/subtype` prefix only;
 * trailing parameters (`; charset=utf-8`) are ignored.
 */
export function mimeMatches(pattern: string, mimeType: string): boolean {
  const stripped = stripParams(mimeType).toLowerCase();
  const pat = pattern.toLowerCase();
  if (pat === "*/*") return true;
  const slash = pat.indexOf("/");
  if (slash <= 0) return false;
  const patType = pat.slice(0, slash);
  const patSub = pat.slice(slash + 1);
  const slash2 = stripped.indexOf("/");
  if (slash2 <= 0) return false;
  const mType = stripped.slice(0, slash2);
  const mSub = stripped.slice(slash2 + 1);
  if (patType !== mType) return false;
  return patSub === "*" || patSub === mSub;
}

function stripParams(m: string): string {
  const i = m.indexOf(";");
  return (i < 0 ? m : m.slice(0, i)).trim();
}

/** Pick the first renderer whose pattern matches the mime. Returns
 *  null when nothing matches \u2014 the host can fall back to a builtin
 *  chip. */
export function pickRenderer(
  renderers: FlatRenderer[],
  mimeType: string,
): FlatRenderer | null {
  for (const r of renderers) {
    if (mimeMatches(r.mimePattern, mimeType)) return r;
  }
  return null;
}
