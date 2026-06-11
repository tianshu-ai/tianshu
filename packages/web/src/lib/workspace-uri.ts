// Rewrite the canonical `workspace://` URI scheme that every fs
// tool emits (see plugins/files/src/tools/path-helper.ts:
// toWorkspaceUri) into the host's `/api/p/files/raw` route so the
// chat UI's <ReactMarkdown> can render `![](workspace:///x.png)`
// inline.
//
// Behaviour:
//   - `workspace:///foo`   →  /api/p/files/raw?path=%2Ffoo (canonical)
//   - `workspace://foo`    →  same  (two-slash alias \u2014 LLMs sometimes
//                                    drop the third slash)
//   - `data:` / `http(s):` →  unchanged
//   - anything else        →  unchanged. We deliberately do NOT
//                             try to repair malformed paths
//                             (e.g. bare `./foo`, absolute host
//                             paths) so a broken image surfaces
//                             a real bug instead of silently
//                             pointing somewhere wrong.

export function rewriteWorkspaceUri(url: string): string {
  if (!url) return url;
  if (url.startsWith("data:")) return url;
  if (/^https?:\/\//i.test(url)) return url;
  let m = url.match(/^workspace:\/\/\/(.*)$/);
  if (!m) m = url.match(/^workspace:\/\/(.*)$/);
  if (!m) return url;
  const rest = m[1] ?? "";
  // /api/p/files/raw expects an absolute (leading slash) path.
  const abs = rest.startsWith("/") ? rest : "/" + rest;
  return `/api/p/files/raw?path=${encodeURIComponent(abs)}`;
}
