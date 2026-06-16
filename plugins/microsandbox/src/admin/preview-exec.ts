// One-shot command execution against a build snapshot.
//
// Used by the admin Shell when the user picks "test against build
// <id>" before switching the tenant to it. We boot a short-lived sandbox from the
// captured snapshot, run a single shell command, capture stdout +
// stderr, then tear it down. The tenant's live VM is untouched.
//
// We don't reuse MicrosandboxRunner here on purpose — that runner
// keeps a long-lived handle, while preview is fundamentally
// disposable. Sharing code with builder.ts (also disposable
// sandboxes) was tempting but the lifecycle is different: builder
// runs many steps + snapshots; preview runs one step + drops the VM.

type MsbModule = typeof import("microsandbox");
let msbModuleP: Promise<MsbModule> | null = null;
function loadMsb(): Promise<MsbModule> {
  if (!msbModuleP) msbModuleP = import("microsandbox");
  return msbModuleP;
}

export interface PreviewExecOpts {
  /** Snapshot to boot the preview VM from. */
  snapshotName: string;
  /** Shell command (run via `bash -c`). */
  command: string;
  /** Working directory. Default `/workspace`. */
  workdir?: string;
  /** CPU count for the preview VM. Default 2. */
  cpus?: number;
  /** Memory MiB for the preview VM. Default 2048. */
  memoryMib?: number;
  /** Tenant workspace bound at /workspace inside the guest. */
  workspaceDir: string;
  /** Stable name prefix; helper appends a unique suffix so concurrent
   *  previews don't collide. */
  sandboxNamePrefix: string;
  /**
   * Hard wall-clock timeout for the shell call. If exceeded we kick
   * off `stopAndWait` + `removePersisted` to tear the VM down (which
   * unblocks the in-flight `shell()` promise) and return a result
   * with `timedOut: true`. Default 60_000.
   *
   * Note: the underlying microsandbox SDK has no native timeout in
   * v0.4.x, so this is implemented as a Promise.race + forced VM
   * teardown. The teardown is the only way to interrupt a hung
   * command (e.g. `python -v` waiting on stdin).
   */
  timeoutMs?: number;
}

export interface PreviewExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export async function previewExec(opts: PreviewExecOpts): Promise<PreviewExecResult> {
  const start = Date.now();
  const { Sandbox } = await loadMsb();
  const cpus = opts.cpus ?? 2;
  const memoryMib = opts.memoryMib ?? 2048;
  const workdir = opts.workdir ?? "/workspace";

  // microsandbox sandbox names share a global namespace; previews
  // started in parallel must not collide.
  const suffix = `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.floor(
    Math.random() * 1e6,
  ).toString(36)}`;
  const previewName = `${opts.sandboxNamePrefix}-preview-${suffix}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle: any = await (Sandbox as any)
    .builder(previewName)
    .fromSnapshot(opts.snapshotName)
    .cpus(cpus)
    .memory(memoryMib)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .volume("/workspace", (m: any) => m.bind(opts.workspaceDir))
    .replace(true)
    .create();

  const timeoutMs = opts.timeoutMs ?? 60_000;
  let timedOut = false;
  let timeoutTimer: NodeJS.Timeout | null = null;

  try {
    // Mirror MicrosandboxRunner.exec() so previews are
    // observationally equivalent to the live shell — same `set -e;
    // cd <wd>; <cmd>` wrapper.
    const script = `set -e; cd "${shellEscape(workdir)}"; ${opts.command}`;

    // Race the shell against a timeout. On timeout we forcibly stop
    // the VM — that's the only way to interrupt a hung shell call
    // because the SDK doesn't expose a cancellation signal. Once the
    // VM dies the `shell()` promise rejects, which we swallow below.
    const shellP = handle.shell(script).then(
      (r: { code: number; stdout(): string; stderr(): string }) => ({
        kind: "done" as const,
        r,
      }),
      (err: unknown) => ({ kind: "error" as const, err }),
    );
    const timeoutP = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        // Kick off teardown so shell() can return. We prefer
        // `kill()` (SIGKILL) over `stopAndWait()` here because
        // commands waiting on stdin (e.g. `python -v`, `cat`) put
        // the SDK's shell() into a state where stopAndWait itself
        // hangs. SIGKILL gets us out of that. The finally block
        // does belt-and-suspenders cleanup.
        const tryKill = async () => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const h = handle as any;
            if (typeof h.kill === "function") {
              await h.kill();
            } else if (typeof h.stopWithTimeout === "function") {
              await h.stopWithTimeout(0);
            } else if (typeof h.stop === "function") {
              await h.stop();
            } else if (typeof h.stopAndWait === "function") {
              await h.stopAndWait();
            }
          } catch {
            /* swallow */
          }
        };
        tryKill();
        resolve({ kind: "timeout" });
      }, timeoutMs);
    });

    const winner = await Promise.race([shellP, timeoutP]);
    if (winner.kind === "done") {
      return {
        exitCode: winner.r.code,
        stdout: winner.r.stdout(),
        stderr: winner.r.stderr(),
        durationMs: Date.now() - start,
        timedOut: false,
      };
    }
    if (winner.kind === "error") {
      const msg =
        winner.err instanceof Error ? winner.err.message : String(winner.err);
      return {
        exitCode: -1,
        stdout: "",
        stderr: `preview shell threw: ${msg}`,
        durationMs: Date.now() - start,
        timedOut: false,
      };
    }
    // Timed out: wait briefly for the in-flight shell promise to
    // settle (it should reject once stopAndWait completes) so we
    // capture whatever output had accumulated.
    const settled = await Promise.race([
      shellP,
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 5_000),
      ),
    ]);
    let stdout = "";
    let stderr = `preview command exceeded timeout (${timeoutMs}ms) and was killed`;
    if (settled.kind === "done") {
      stdout = settled.r.stdout();
      const captured = settled.r.stderr();
      if (captured) stderr = `${stderr}\n${captured}`;
    }
    return {
      exitCode: -1,
      stdout,
      stderr,
      durationMs: Date.now() - start,
      timedOut: true,
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // Teardown the preview VM so the snapshot itself stays
    // untouched and the next preview starts from a clean copy.
    // On normal exits we can stopAndWait politely; on timeouts we
    // SIGKILL because the VM was misbehaving.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = handle as any;
      if (timedOut && typeof h.kill === "function") {
        await h.kill();
      } else if (typeof h.stopWithTimeout === "function") {
        await h.stopWithTimeout(15_000);
      } else if (typeof h.stop === "function") {
        await h.stop();
      } else if (typeof h.stopAndWait === "function") {
        await h.stopAndWait();
      }
    } catch {
      /* swallow — best effort */
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const h = handle as any;
      if (typeof h.removePersisted === "function") {
        await h.removePersisted();
      } else {
        const msb = await import("microsandbox");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SandboxAny = (msb as any).Sandbox;
        if (h.name && SandboxAny && typeof SandboxAny.remove === "function") {
          await SandboxAny.remove(h.name);
        }
      }
    } catch {
      /* swallow */
    }
  }
}

/**
 * Quote a string for safe interpolation into a `bash -c` script.
 * Same approach MicrosandboxRunner uses.
 */
function shellEscape(s: string): string {
  return s.replace(/(["\\$`])/g, "\\$1");
}
