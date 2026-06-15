// Internal types shared across the microsandbox runner.

export interface MicroSandboxConfig {
  /** Sandbox name (becomes the microsandbox identifier). Default
   *  is `tianshu-<tenantId>` filled in by the facade. */
  sandboxName: string;
  /** OCI image to fork from. v0 default is `python:3.12-slim`;
   *  custom images come in N+5 (Sandboxfile editor UI). */
  image: string;
  /** vCPUs allocated to the microVM. */
  cpus: number;
  /** Memory in MiB. */
  memoryMib: number;
  /** Idle timeout in ms; 0 disables. v0 doesn't act on this yet
   *  (we keep VMs around until plugin disable / tenant eviction)
   *  but the value is recorded so future PRs can wire it in. */
  idleShutdownMs: number;
  /** Default per-exec timeout in ms. v0.4.x SDK doesn't expose a
   *  per-call timeout, so this is advisory until the SDK does. */
  execTimeoutMs: number;
}

export const DEFAULT_CONFIG: MicroSandboxConfig = {
  sandboxName: "default", // overridden per-tenant by the facade
  image: "python:3.12-slim",
  cpus: 2,
  // 4 GiB is the smallest value where pip-installing the standard
  // Python data science stack + a chromium build doesn't OOM.
  // Browser-heavy (Playwright + multi-tab) workloads still want
  // to bump to 8192+ via the plugin config UI, but at 4 GiB the
  // out-of-the-box experience doesn't hit "the kernel killed our
  // pip install" on first run.
  memoryMib: 4096,
  idleShutdownMs: 14_400_000, // 4h
  execTimeoutMs: 300_000, // 5min
};

/** Apply tenant config defaults. Unknown / wrong-typed fields are
 *  ignored and the default kicks in. */
export function resolveConfig(raw: Record<string, unknown>): MicroSandboxConfig {
  const out: MicroSandboxConfig = { ...DEFAULT_CONFIG };
  if (typeof raw.sandboxName === "string" && raw.sandboxName.length > 0) out.sandboxName = raw.sandboxName;
  if (typeof raw.image === "string" && raw.image.length > 0) out.image = raw.image;
  if (typeof raw.cpus === "number" && Number.isFinite(raw.cpus) && raw.cpus > 0) out.cpus = Math.floor(raw.cpus);
  if (typeof raw.memoryMib === "number" && Number.isFinite(raw.memoryMib) && raw.memoryMib > 0) {
    out.memoryMib = Math.floor(raw.memoryMib);
  }
  if (typeof raw.idleShutdownMs === "number" && Number.isFinite(raw.idleShutdownMs) && raw.idleShutdownMs >= 0) {
    out.idleShutdownMs = raw.idleShutdownMs;
  }
  if (typeof raw.execTimeoutMs === "number" && Number.isFinite(raw.execTimeoutMs) && raw.execTimeoutMs > 0) {
    out.execTimeoutMs = raw.execTimeoutMs;
  }
  return out;
}
