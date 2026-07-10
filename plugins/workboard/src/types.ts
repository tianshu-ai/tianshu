// Worker-agent types post-PR-C2.
//
// Pre-C2 these lived in `db/agents.ts` because the DB row was
// the authoritative shape. Since the table is gone, the type is
// just the in-memory record the pool/factory consume — populated
// from `_tenant/config/workers/<slug>/agent.json` + SOUL.md by
// `fs-worker-agents.ts`.
//
// The fields are a strict superset of what `agent.json` carries:
// the loader fills `id` (= slug), `tenantId`, sources timestamps
// from file mtimes, etc. Fields no longer meaningful in the fs
// world (`builtinKey`, `overridesAt`) are kept as nullable for
// API compatibility with the read-only admin UI / GET /agents
// payload; new code shouldn't read them.

export interface WorkerAgent {
  /** Slug = directory name under `_tenant/config/workers/<slug>/`. */
  id: string;
  tenantId: string;
  kind: string;
  name: string;
  description: string | null;
  modelId: string | null;
  /** opencode workers: enable LSP + formatters (opens npm/GitHub
   *  egress so opencode can install language servers). Default
   *  false. Ignored by non-opencode kinds. */
  enableLsp?: boolean;
  systemPrompt: string | null;
  toolsAllow: string[] | null;
  /** Field name kept as `skills` (not `skillsAllow`) for parity
   *  with the GET /agents payload the admin page consumes. */
  skills: string[] | null;
  source: "builtin" | "user";
  /** Pre-C2 this was `builtin_key` from the table. Now it just
   *  echoes `id` for builtin rows, `null` for user rows. UI uses
   *  it to display "slug" without leaking that the two are equal. */
  builtinKey: string | null;
  ownerUserId: string | null;
  enabled: boolean;
  /** Always null in the fs world — kept on the type for legacy
   *  callers. */
  overridesAt: number | null;
  createdAt: number;
  updatedAt: number;
}
