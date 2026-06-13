// Path / scope helper for the `tenant_config_*` agent tools.
//
// These tools operate on the tenant-shared config tree at
// `<tenant>/workspace/_tenant/config/`. That tree houses skills and
// (in future) other agent-facing config that the user can edit but
// is not part of any single user's home dir.
//
// URI shape: `tenant-config:///<rel>` mirrors the user-workspace
// `workspace:///<rel>` URIs the rest of the files plugin emits.
// Path-traversal protection is identical: literal `..` segments in
// the requested path are rejected up front, and the resolved path
// is checked against the canonical tenant-config root.

import path from "node:path";

export class TenantConfigPathError extends Error {
  readonly code = "TENANT_CONFIG_PATH_ERROR" as const;
  constructor(public readonly requested: string, reason: string) {
    super(`tenant-config path "${requested}" rejected: ${reason}`);
    this.name = "TenantConfigPathError";
  }
}

/** Absolute on-disk root for the tenant config tree. */
export function getTenantConfigRoot(tenantHomeDir: string): string {
  // tenantHomeDir is `<...>/tenants/<id>` per
  // `getTenantRoot()` in @tianshu/server. Tools see it via
  // AgentToolContext.tenantHomeDir.
  return path.resolve(tenantHomeDir, "workspace", "_tenant", "config");
}

/**
 * Resolve a tool-supplied `tenant-config:///<rel>` URI (or a bare
 * relative path) into an absolute on-disk path under the tenant
 * config root. Throws if the path escapes the root, contains `..`,
 * or is empty.
 */
export function resolveInTenantConfig(
  tenantHomeDir: string,
  requested: string,
): string {
  if (typeof requested !== "string") {
    throw new TenantConfigPathError(String(requested), "not a string");
  }
  let rel = requested.replace(/\\/g, "/");
  if (rel.startsWith("tenant-config:///")) {
    rel = rel.slice("tenant-config:///".length);
  } else if (rel.startsWith("tenant-config://")) {
    rel = rel.slice("tenant-config://".length);
  } else if (rel === "tenant-config:") {
    rel = "";
  }
  if (rel.startsWith("/")) rel = rel.slice(1);
  const segments = rel.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) {
    throw new TenantConfigPathError(requested, "contains '..' segment");
  }
  const root = getTenantConfigRoot(tenantHomeDir);
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new TenantConfigPathError(requested, "escapes tenant-config root");
  }
  return resolved;
}

/** Convert an absolute path back into a `tenant-config:///<rel>`
 *  URI for use in tool result text. Throws if `abs` is outside the
 *  tenant-config root. */
export function toTenantConfigUri(
  tenantHomeDir: string,
  abs: string,
): string {
  const root = getTenantConfigRoot(tenantHomeDir);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..")) {
    throw new TenantConfigPathError(abs, "escapes tenant-config root");
  }
  if (rel === "" || rel === ".") return "tenant-config:///";
  return "tenant-config:///" + rel;
}

/**
 * Decide whether the given absolute path is writable from the
 * provided agent scope. Reads are not gated; only `tenant_config_write`
 * / `tenant_config_edit` / `tenant_config_delete` consult this.
 *
 * Allowed shapes (rooted at the tenant config tree):
 *
 *   main agent     → `skills/...`,           `main/skills/...`
 *   worker:<kind>  → `workers/<kind>/skills/...`
 *
 * The boundary is **only** the per-scope `skills/` subtree for now
 * (i.e. shared `skills/`, `main/skills/`, `workers/<kind>/skills/`).
 * Future surfaces (SOUL.md, MEMORY.md) would each need their own
 * opt-in here \u2014 keeping the allow-list narrow makes accidental
 * writes to agent personality files impossible by construction.
 */
export type AgentScope =
  | { kind: "main" }
  | { kind: "worker"; workerKind: string; slug?: string };

export interface WriteCheck {
  ok: boolean;
  /** Human-readable reason when `ok=false`. */
  reason?: string;
  /** Canonical scope label ("shared", "main", `worker:<kind>`) when
   *  `ok=true`, for tool result text. */
  scopeLabel?: string;
}

export function checkWritable(
  tenantHomeDir: string,
  abs: string,
  scope: AgentScope,
): WriteCheck {
  const root = getTenantConfigRoot(tenantHomeDir);
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  if (rel === "" || rel === "." || rel.startsWith("..")) {
    return { ok: false, reason: "outside tenant-config root" };
  }
  const segments = rel.split("/");

  // Main agent. Allowed prefixes:
  //   skills/...                        → shared skill bundle
  //   main/skills/...                   → main-only skill bundle
  //   workers/<slug>/...                → author / edit any worker
  //                                      bundle (agent.json,
  //                                      SOUL.md, skills/, etc).
  // Anything else (root files, future top-level surfaces) is
  // rejected so the agent can't accidentally write SOUL/MEMORY
  // for the tenant itself.
  if (scope.kind === "main") {
    if (segments[0] === "skills") {
      return { ok: true, scopeLabel: "shared" };
    }
    if (segments[0] === "main" && segments[1] === "skills") {
      return { ok: true, scopeLabel: "main" };
    }
    if (
      segments[0] === "workers" &&
      segments[1] &&
      segments[1].length > 0
    ) {
      return { ok: true, scopeLabel: `workers/${segments[1]}` };
    }
    return {
      ok: false,
      reason:
        "main agent may only write under skills/, main/skills/, or workers/<slug>/ in tenant-config",
    };
  }

  // Worker. Strict: only the worker's own skills/ directory.
  // Workers should not edit their own agent.json / SOUL.md (loop
  // would self-reload mid-run). The slug is preferred because the
  // filesystem keys off slug, not kind. If a slug isn't supplied
  // we fall back to kind for legacy callers — mostly the
  // existing pre-PR-A path.
  const workerSegment = scope.slug || scope.workerKind;
  if (
    segments[0] === "workers" &&
    segments[1] === workerSegment &&
    segments[2] === "skills"
  ) {
    return { ok: true, scopeLabel: `worker:${workerSegment}` };
  }
  return {
    ok: false,
    reason: `worker (slug=${scope.slug ?? "—"}, kind=${scope.workerKind}) may only write under workers/${workerSegment}/skills/`,
  };
}
