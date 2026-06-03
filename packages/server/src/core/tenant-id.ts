// Tenant id validation, per ADR-0001 §8.
//
//   ^[a-z0-9][a-z0-9_-]{1,30}$
//   - 2..32 chars total
//   - lowercase letters, digits, "-", "_"
//   - cannot start with "_" (system-reserved prefix)
//   - cannot be a reserved name like "tenants" / "."
//
// This is the ONLY entry point for accepting a tenantId from anywhere
// outside the server (CLI, JWT, request body). If it doesn't pass here,
// it doesn't go to the filesystem.

const TENANT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

const RESERVED_TENANT_IDS = new Set([
  "",
  ".",
  "..",
  "tenants",
  "config",
  "global",
  "system",
  "admin",
]);

export class InvalidTenantIdError extends Error {
  readonly code = "INVALID_TENANT_ID" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidTenantIdError";
  }
}

/** Validate a candidate tenantId. Returns the canonical id (== input) or throws. */
export function validateTenantId(candidate: unknown): string {
  if (typeof candidate !== "string") {
    throw new InvalidTenantIdError("tenantId must be a string");
  }
  const id = candidate;
  if (!TENANT_ID_RE.test(id)) {
    throw new InvalidTenantIdError(
      `tenantId "${id}" must match ${TENANT_ID_RE} (2-32 chars, lowercase letters/digits/-_, no leading _)`,
    );
  }
  if (RESERVED_TENANT_IDS.has(id)) {
    throw new InvalidTenantIdError(`tenantId "${id}" is reserved`);
  }
  return id;
}

export function isValidTenantId(candidate: unknown): candidate is string {
  try {
    validateTenantId(candidate);
    return true;
  } catch {
    return false;
  }
}
