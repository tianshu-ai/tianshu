// Internal types shared across the microsandbox runner.
//
// The runner has two roles — the long-lived Browser sandbox and
// the per-task pool — and each role gets its own resource budget.
// Top-level fields (cpus, memoryMib, idleShutdownMs, execTimeoutMs)
// describe the Browser role. The matching task* fields describe
// per-task sandboxes. When a task* field isn't supplied, it falls
// back to the Browser-role value, so existing single-config
// installs see no behaviour change.

export interface MicroSandboxConfig {
  /** Sandbox name (becomes the microsandbox identifier). Default
   *  is `tianshu-<tenantId>` filled in by the facade. */
  sandboxName: string;
  /** OCI image to fork from when no snapshot pointer is set. */
  image: string;

  // ----- Browser role (long-lived sandbox) -----
  /** vCPUs allocated to the Browser microVM. */
  cpus: number;
  /** Browser microVM memory in MiB. */
  memoryMib: number;
  /** Idle timeout in ms for the Browser sandbox; 0 disables. v0
   *  records but doesn't act on this. */
  idleShutdownMs: number;
  /** Default per-exec timeout in ms for the Browser sandbox. */
  execTimeoutMs: number;

  // ----- Task role (per-task sandboxes; will be wired up by the
  //       follow-up PR that introduces SandboxPool) -----
  /** vCPUs allocated to each per-task sandbox. Defaults to `cpus`. */
  taskCpus: number;
  /** Memory (MiB) for each per-task sandbox. Defaults to `memoryMib`. */
  taskMemoryMib: number;
  /** How long a per-task sandbox stays alive after its last task
   *  releases it before being stopped. 0 = stop immediately. */
  taskIdleShutdownMs: number;
  /** Per-exec timeout in ms for task-pool exec calls. Defaults to
   *  `execTimeoutMs`. */
  taskExecTimeoutMs: number;
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
  // Task-role defaults mirror the Browser role until the operator
  // overrides them via plugin config.
  taskCpus: 2,
  taskMemoryMib: 4096,
  taskIdleShutdownMs: 600_000, // 10min after last release
  taskExecTimeoutMs: 300_000,
};

/** Apply tenant config defaults. Unknown / wrong-typed fields are
 *  ignored and the default kicks in. Task-role fields fall back to
 *  the Browser-role value when not explicitly supplied, so legacy
 *  single-config installs preserve their pre-split behaviour. */
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

  // Task-role overrides. Each falls back to the matching
  // Browser-role value when missing/invalid, so unconfigured
  // installs see one shared budget across both roles.
  out.taskCpus = out.cpus;
  out.taskMemoryMib = out.memoryMib;
  out.taskExecTimeoutMs = out.execTimeoutMs;
  if (
    typeof raw.taskCpus === "number" &&
    Number.isFinite(raw.taskCpus) &&
    raw.taskCpus > 0
  ) {
    out.taskCpus = Math.floor(raw.taskCpus);
  }
  if (
    typeof raw.taskMemoryMib === "number" &&
    Number.isFinite(raw.taskMemoryMib) &&
    raw.taskMemoryMib > 0
  ) {
    out.taskMemoryMib = Math.floor(raw.taskMemoryMib);
  }
  if (
    typeof raw.taskExecTimeoutMs === "number" &&
    Number.isFinite(raw.taskExecTimeoutMs) &&
    raw.taskExecTimeoutMs > 0
  ) {
    out.taskExecTimeoutMs = raw.taskExecTimeoutMs;
  }
  if (
    typeof raw.taskIdleShutdownMs === "number" &&
    Number.isFinite(raw.taskIdleShutdownMs) &&
    raw.taskIdleShutdownMs >= 0
  ) {
    out.taskIdleShutdownMs = raw.taskIdleShutdownMs;
  }
  return out;
}
