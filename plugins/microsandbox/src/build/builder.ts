// Snapshot builder.
//
// Takes a SandboxSpec, runs an apt/pip/npm/exec sequence inside a
// short-lived "builder" sandbox, captures a snapshot, and tears the
// builder down. The pattern mirrors the closed-source repo's
// buildWarmSnapshot() but parametrised by the spec instead of
// hard-coded.
//
// On the host we keep:
// - a Snapshot in microsandbox's DB (~/.microsandbox/snapshots/<name>)
// - a metadata json in the user's home dir for the agent to list
//
// We do NOT export tar.zst by default; that's an opt-in for backups
// and out of scope for v0.

import { promises as fs } from "node:fs";
import type { SandboxSpec } from "./sandboxfile.js";

// Lazy-load the SDK so this module is cheap to import in tests
// that don't actually invoke build().
type MsbModule = typeof import("microsandbox");
let msbModuleP: Promise<MsbModule> | null = null;
function loadMsb(): Promise<MsbModule> {
  if (!msbModuleP) msbModuleP = import("microsandbox");
  return msbModuleP;
}

export interface BuildOpts {
  /** Spec parsed from the user's Sandboxfile. */
  spec: SandboxSpec;
  /**
   * Stable sandbox name for this tenant. Builder uses
   * `<sandboxName>-build-<buildId>` so concurrent builds don't
   * collide.
   */
  sandboxName: string;
  /**
   * Build id (also the snapshot name suffix). Caller picks; we
   * suggest `YYYYMMDD-HHmmss` or short uuid.
   */
  buildId: string;
  /** Tenant id. Used in the snapshot name to namespace per tenant. */
  tenantId: string;
  /**
   * Host workspace dir bind-mounted into the builder. The agent's
   * Sandboxfile may reference context files under this dir via
   * `/workspace/users/<userId>/sandbox/...` paths.
   */
  workspaceDir: string;
  /** Default cpus when spec doesn't override. */
  defaultCpus?: number;
  /** Default memory_mib when spec doesn't override. */
  defaultMemoryMib?: number;
  /** Optional progress sink so callers can stream build logs. */
  onLog?: (line: string) => void;
}

export interface BuildResult {
  /** Snapshot name as stored in microsandbox DB. */
  snapshotName: string;
  /** Image used as the base layer. */
  baseImage: string;
  /** Wall time spent. */
  durationMs: number;
  /** Captured stdout/stderr tail (last 200 lines / 8 KB), for the
   *  metadata json. Full log goes to `onLog`. */
  logTail: string;
}

export class BuildFailedError extends Error {
  readonly code = "BUILD_FAILED" as const;
  constructor(
    message: string,
    /** Raw stdout/stderr from the failing step. */
    readonly stderr: string,
  ) {
    super(message);
    this.name = "BuildFailedError";
  }
}

const LOG_LINE_CAP = 200;
const LOG_BYTE_CAP = 8_000;

export async function buildSnapshot(opts: BuildOpts): Promise<BuildResult> {
  const start = Date.now();
  const { Sandbox, Snapshot } = await loadMsb();

  const builderName = `${opts.sandboxName}-build-${opts.buildId}`;
  const snapshotName = `${opts.sandboxName}-${opts.buildId}`;

  const cpus = opts.spec.cpus ?? opts.defaultCpus ?? 4;
  const memoryMib = opts.spec.memoryMib ?? opts.defaultMemoryMib ?? 4096;

  const log = opts.onLog ?? (() => {});
  const captured: string[] = [];
  const cap = (line: string) => {
    captured.push(line);
    log(line);
  };

  cap(
    `[builder] starting: image=${opts.spec.image} cpus=${cpus} memMib=${memoryMib}`,
  );

  await fs.mkdir(opts.workspaceDir, { recursive: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base: any = await (Sandbox as any)
    .builder(builderName)
    .image(opts.spec.image)
    .cpus(cpus)
    .memory(memoryMib)
    .volume("/workspace", (m: { bind(host: string): unknown }) =>
      m.bind(opts.workspaceDir),
    )
    .replace(true)
    .create();

  try {
    if (opts.spec.apt && opts.spec.apt.length > 0) {
      cap(`[builder] apt-get install ${opts.spec.apt.length} pkg(s)`);
      await runStepWithHeartbeat(
        "apt-get",
        cap,
        () =>
          runStep(
            base,
            "sh",
            [
              "-c",
              [
                "apt-get update -qq",
                `DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ${opts.spec.apt!.join(
                  " ",
                )}`,
              ].join(" && "),
            ],
            cap,
          ),
      );
    }
    if (opts.spec.pip && opts.spec.pip.length > 0) {
      cap(`[builder] pip install ${opts.spec.pip.length} pkg(s)`);
      await runStepWithHeartbeat("pip install", cap, () =>
        runStep(base, "pip", ["install", "--quiet", ...opts.spec.pip!], cap),
      );
    }
    if (opts.spec.npm && opts.spec.npm.length > 0) {
      cap(`[builder] npm install -g ${opts.spec.npm.length} pkg(s)`);
      await runStepWithHeartbeat("npm install", cap, () =>
        runStep(
          base,
          "sh",
          ["-c", `npm install -g ${opts.spec.npm!.join(" ")} 2>&1 | tail -3`],
          cap,
        ),
      );
    }
    if (opts.spec.exec && opts.spec.exec.length > 0) {
      for (let i = 0; i < opts.spec.exec.length; i++) {
        const cmd = opts.spec.exec[i]!;
        cap(`[builder] exec[${i}] ${cmd.slice(0, 120)}`);
        await runStepWithHeartbeat(`exec[${i}]`, cap, () =>
          runStep(base, "sh", ["-c", cmd], cap),
        );
      }
    }

    // Critical sync before snapshot — async page-cache writes on the
    // upper layer aren't on disk yet otherwise (mirrors closed-source).
    cap(`[builder] sync`);
    await runStep(base, "sync", [], cap);

    cap(`[builder] stopAndWait`);
    await base.stopAndWait();

    cap(`[builder] snapshotting -> "${snapshotName}"`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (Snapshot as any)
      .builder(builderName)
      .name(snapshotName)
      .force()
      .create();
  } finally {
    try {
      await base.removePersisted();
    } catch (err) {
      cap(
        `[builder] removePersisted failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  const durationMs = Date.now() - start;
  cap(`[builder] done in ${(durationMs / 1000).toFixed(1)}s`);
  return {
    snapshotName,
    baseImage: opts.spec.image,
    durationMs,
    logTail: tailJoin(captured),
  };
}

interface ExecHandle {
  exec(
    cmd: string,
    args?: readonly string[],
  ): Promise<{ code: number; stdout(): string; stderr(): string }>;
}

/**
 * Wrap a long-running step (apt-get / pip install / npm) with a
 * heartbeat that pings `cap` every few seconds while we wait. The
 * underlying SDK exec is synchronous (we only see stdout when the
 * process exits), so without this the build would appear frozen for
 * 30+ seconds while apt downloads packages.
 */
async function runStepWithHeartbeat(
  label: string,
  cap: (line: string) => void,
  step: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  const HEARTBEAT_MS = 3000;
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    cap(`[builder] … ${label} still running (${elapsed}s elapsed)`);
  }, HEARTBEAT_MS);
  try {
    await step();
  } finally {
    clearInterval(timer);
    if (ticks > 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      cap(`[builder] ✓ ${label} finished in ${elapsed}s`);
    }
  }
}

async function runStep(
  base: ExecHandle,
  cmd: string,
  args: string[],
  cap: (line: string) => void,
): Promise<void> {
  const r = await base.exec(cmd, args);
  if (r.code !== 0) {
    const stderr = r.stderr().slice(0, 1500);
    cap(`[builder] step failed (code=${r.code}): ${stderr}`);
    throw new BuildFailedError(
      `${cmd} ${args.join(" ").slice(0, 80)} → exit ${r.code}`,
      stderr,
    );
  }
}

function tailJoin(lines: string[]): string {
  const last = lines.slice(-LOG_LINE_CAP).join("\n");
  if (Buffer.byteLength(last, "utf8") <= LOG_BYTE_CAP) return last;
  // Trim from the front (head of the tail) until under the byte cap
  // so the most recent lines stay visible.
  let s = last;
  while (Buffer.byteLength(s, "utf8") > LOG_BYTE_CAP) {
    const nl = s.indexOf("\n");
    if (nl < 0) return s.slice(s.length - LOG_BYTE_CAP);
    s = s.slice(nl + 1);
  }
  return s;
}

/** Resolves to true iff `~/.microsandbox/snapshots/<name>` exists.
 *  Used by the runner to decide between fromSnapshot vs image. */
export async function snapshotExists(name: string): Promise<boolean> {
  try {
    const { Snapshot } = await loadMsb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (Snapshot as any).open(name);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort delete of a snapshot from microsandbox's DB. */
export async function removeSnapshot(name: string): Promise<void> {
  try {
    const { Snapshot } = await loadMsb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = await (Snapshot as any).open(name);
    if (typeof s.remove === "function") {
      await s.remove();
    } else if (typeof s.removePersisted === "function") {
      await s.removePersisted();
    }
  } catch {
    /* idempotent */
  }
}
