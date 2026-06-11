// Path helper shared by every fs tool.
//
// Every agent-tool root is the **current user's home** under the
// tenant workspace, i.e. `<tenant>/workspace/users/<userId>/`. This
// matches the `files` plugin's UI scope (PR #40) and ADR-0001 §2:
//   - one user's tools cannot reach another user's files
//   - the shared `_tenant/` directory is intentionally invisible to
//     tools (host injects its contents into the system prompt instead)
//   - host filesystem outside the user home is rejected
//
// Path inputs are accepted in four shapes for ergonomics:
//   - "workspace:///foo/bar"  → user home + foo/bar  (canonical — the
//                                                     shape this
//                                                     module emits)
//   - "/foo/bar"              → user home + foo/bar
//   - "foo/bar"               → user home + foo/bar  (relative is the same)
//   - "/workspace/foo"        → user home + foo      (alias kept so existing
//                                                     LLM training data
//                                                     with `/workspace/...`
//                                                     still resolves)
// Anything containing a literal `..` segment is rejected up front so a
// trick like "/workspace/../etc/passwd" cannot squeeze past resolve().

import path from "node:path";

export class PathOutsideRootError extends Error {
  readonly code = "PATH_OUTSIDE_ROOT" as const;
  constructor(public readonly requested: string) {
    super(`path "${requested}" is outside the user workspace`);
    this.name = "PathOutsideRootError";
  }
}

/**
 * Resolve a tool-supplied path against the per-user root.
 * Throws `PathOutsideRootError` if the result would escape the root.
 */
export function resolveInUserHome(userHome: string, requested: string): string {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new PathOutsideRootError(requested);
  }
  let rel = requested.replace(/\\/g, "/");
  // Strip the canonical workspace:// scheme. Two authority shapes
  // are accepted: "workspace:///foo" (empty authority — what we
  // emit) and "workspace://foo" (non-empty authority — a tolerated
  // alias since LLMs sometimes drop the third slash).
  if (rel.startsWith("workspace:///")) {
    rel = rel.slice("workspace:///".length);
  } else if (rel.startsWith("workspace://")) {
    rel = rel.slice("workspace://".length);
  } else if (rel === "workspace:") {
    rel = "";
  }
  // Strip the optional /workspace/ prefix; agents trained on the old
  // tianshu schema use it.
  if (rel.startsWith("/workspace/")) rel = rel.slice("/workspace/".length);
  else if (rel === "/workspace") rel = "";
  // Strip a leading slash; "/" → root.
  if (rel.startsWith("/")) rel = rel.slice(1);

  const segments = rel.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === ".." || s === ".")) {
    // Refuse `.` too — it's harmless but gives a normalised "/" alias
    // and we don't want LLM-confused paths sneaking in.
    if (segments.some((s) => s === "..")) {
      throw new PathOutsideRootError(requested);
    }
  }
  const resolved = path.resolve(userHome, ...segments);
  const rootAbs = path.resolve(userHome);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new PathOutsideRootError(requested);
  }
  return resolved;
}

/** Convert an absolute path back to a `/foo/bar` style display path
 *  rooted at user home. Used for tool result text so the LLM doesn't
 *  see the host filesystem prefix. */
export function toDisplayPath(userHome: string, abs: string): string {
  const rel = path.relative(userHome, abs).replace(/\\/g, "/");
  if (rel === "" || rel === ".") return "/";
  return "/" + rel;
}

/**
 * Convert an absolute path back to a `workspace:///foo/bar` URI
 * rooted at the user home. This is the canonical, single-source-of-
 * truth shape every fs tool returns in its result text and entry
 * fields, so the chat UI can recognise file references with one
 * regex (no need to reverse-engineer the host filesystem prefix or
 * decide whether a relative `./x` should be rewritten).
 *
 * The empty authority (`workspace:///foo`, three slashes) is
 * intentional: by RFC 3986 a `file:` URL also uses an empty
 * authority before the path. Keeping the same shape means the LLM
 * can think of it as a file URL with a workspace scheme.
 *
 * Throws if `abs` is outside the user home; callers should
 * guarantee that by going through `resolveInUserHome` first.
 */
export function toWorkspaceUri(userHome: string, abs: string): string {
  const rel = path.relative(userHome, abs).replace(/\\/g, "/");
  if (rel.startsWith("..")) {
    throw new PathOutsideRootError(abs);
  }
  if (rel === "" || rel === ".") return "workspace:///";
  return "workspace:///" + rel;
}
