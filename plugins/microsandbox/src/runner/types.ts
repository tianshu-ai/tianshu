// Internal types shared across the microsandbox runner implementations.
//
// The plugin's public surface is the SandboxRunner exported via
// `exports.sandboxes.MicroSandboxRunner`. Internally we keep state in
// a per-tenant object that has a few extras the SandboxRunner type
// alone doesn't capture (the tenant id, last-error timestamps, an
// `execLock` mutex, etc.). Keeping them here means the public runner
// stays slim.

export interface MicroSandboxConfig {
  /** Path or PATH lookup for the microsandbox binary. */
  binary: string;
  /** Where the user's Sandboxfile lives, relative to the tenant
   *  workspace. v0 just records this value; the real microsandbox
   *  runner doesn't read Sandboxfile until the actual binary
   *  integration lands in a follow-up PR. */
  projectDir: string;
  /** Which named sandbox in the Sandboxfile to drive. */
  sandboxName: string;
  /** Idle timeout in ms; 0 disables. */
  idleShutdownMs: number;
  /** Default per-exec timeout in ms. */
  execTimeoutMs: number;
}

export const DEFAULT_CONFIG: MicroSandboxConfig = {
  binary: "microsandbox",
  projectDir: "_tenant/config/microsandbox",
  sandboxName: "default",
  idleShutdownMs: 14_400_000, // 4h
  execTimeoutMs: 300_000, // 5min
};

/** Apply tenant config defaults. Unknown / wrong-typed fields are
 *  ignored and the default kicks in. */
export function resolveConfig(raw: Record<string, unknown>): MicroSandboxConfig {
  const out: MicroSandboxConfig = { ...DEFAULT_CONFIG };
  if (typeof raw.binary === "string" && raw.binary.length > 0) out.binary = raw.binary;
  if (typeof raw.projectDir === "string" && raw.projectDir.length > 0) out.projectDir = raw.projectDir;
  if (typeof raw.sandboxName === "string" && raw.sandboxName.length > 0) out.sandboxName = raw.sandboxName;
  if (typeof raw.idleShutdownMs === "number" && Number.isFinite(raw.idleShutdownMs) && raw.idleShutdownMs >= 0) {
    out.idleShutdownMs = raw.idleShutdownMs;
  }
  if (typeof raw.execTimeoutMs === "number" && Number.isFinite(raw.execTimeoutMs) && raw.execTimeoutMs > 0) {
    out.execTimeoutMs = raw.execTimeoutMs;
  }
  return out;
}
