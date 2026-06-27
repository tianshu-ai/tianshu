// Guard: resolve the tenant home dir the agent runtime should use,
// preferring the caller's explicit `homeDir` but falling back to the
// tenant context's `workspaceDir` when omitted. Throws only if both
// are unset/empty — that signals a host wiring bug and we'd rather
// crash loudly at the first prompt than silently mis-resolve paths
// into a process-wide shared dir.
//
// Why this exists: the `tenantHomeDir: homeDir ?? ""` fallback that
// used to live in handler.ts + agent-loop.ts was the root cause of
// the 0.3.48 channel-router incident (channels/router.ts dispatched
// runPrompt without homeDir, the fallback silently shipped an empty
// string, getTenantConfigRoot resolved to a CWD-relative phantom
// `workspace/_tenant/config/` path, and channel agents saw zero
// workers/skills). TypeScript was happy because the field is
// optional; nothing crashed at runtime.
//
// Why ctx.workspaceDir is a safe fallback: every legitimate caller
// (handler.ts attachChatHandler, channels/router.ts, idle-runner,
// host.agentLoop, all unit tests) constructs a TenantContext via
// globalOps.open(tenantId), which sets workspaceDir to the per-tenant
// root. The `homeDir` parameter on runPrompt/runAgentLoop is
// redundant info — it's the same value the ctx already carries. Tests
// that pass a fake ctx with workspaceDir="/tmp/fake" still resolve to
// a stable per-test path; production paths still flow from
// ctx.workspaceDir. ADR-0001 §2.

export interface HomeDirSource {
  /** Tenant context's workspace dir. Authoritative source; always set
   *  for legitimate callers because globalOps.open() populates it. */
  workspaceDir: string;
}

export function requireHomeDir(
  homeDir: string | undefined,
  ctx: HomeDirSource,
  callerLabel: string,
): string {
  const explicit =
    typeof homeDir === "string" && homeDir.trim().length > 0
      ? homeDir
      : null;
  const fromCtx =
    typeof ctx.workspaceDir === "string" &&
    ctx.workspaceDir.trim().length > 0
      ? ctx.workspaceDir
      : null;
  const resolved = explicit ?? fromCtx;
  if (!resolved) {
    throw new Error(
      `${callerLabel}: missing tenantHomeDir. The caller must thread per-tenant workspaceDir through to the agent runtime (ctx.workspaceDir at the host boundary). Falling back to a default would silently leak across tenants — see ADR-0001 §2.`,
    );
  }
  return resolved;
}
