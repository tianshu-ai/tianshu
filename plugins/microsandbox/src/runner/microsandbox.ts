// Real microsandbox runner.
//
// Uses the `microsandbox` npm package directly (napi-rs bindings to
// the Rust runtime) — no CLI, no per-call process spawn. The plugin
// keeps a single long-lived Sandbox per tenant for its lifetime,
// matching the closed-source repo's pattern.
//
// v0 scope (this PR, ADR-0004 N+2.5):
// - Lazy start: the actual `Sandbox.builder(...).create()` runs on
//   first `exec()` (or first explicit `start()`). Plugin activation
//   is cheap; we don't want enabling the plugin to block on a
//   first-time image pull (~1-2 minutes for python:3.12).
// - Single VM per tenant. Lives until plugin deactivate, an admin
//   `reset()`, or tenant DB pool eviction.
// - workspace bind-mount: <tenant>/workspace → /workspace inside the
//   guest. readFile/writeFile use the host path directly.
// - python:3.12-slim default. Custom images come in N+5 (Sandboxfile
//   editor UI).
//
// What this is NOT yet:
// - No browser sidecar. Lands in the follow-up that adds chromium +
//   Playwright MCP through the same VM.
// - No idle reaping. The closed-source repo pauses VMs after 4h; v0
//   keeps them around until the plugin is disabled.

import type {
  BrowserSidecar,
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu/plugin-sdk";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { MicroSandboxConfig } from "./types.js";
import { readPointer } from "../build/pointer.js";
import { snapshotExists } from "../build/builder.js";
import { MicrosandboxBrowserSidecar } from "./browser.js";
import { pickFreePorts } from "./free-port.js";

// Guest ports for the optional browser stack. The Sandboxfile
// browser template wires CloakBrowser to 9222, Playwright MCP to
// 3200, noVNC to 6080. We always forward all three even when
// the active image doesn't include the browser layer —
// microsandbox is fine with port forwards that nothing inside the
// guest is listening on.
const BROWSER_GUEST_CDP_PORT = 9222;
const BROWSER_GUEST_MCP_PORT = 3200;
const BROWSER_GUEST_VNC_PORT = 6080;

// Lazy-load the SDK so non-microsandbox deployments (or platforms
// without the prebuilt napi binary) don't pay the import cost.
type MsbModule = typeof import("microsandbox");
let msbModuleP: Promise<MsbModule> | null = null;
function loadMsb(): Promise<MsbModule> {
  if (!msbModuleP) {
    msbModuleP = import("microsandbox");
  }
  return msbModuleP;
}

export interface MicrosandboxRunnerOpts {
  pluginId: string;
  contributionId: string;
  workspaceDir: string;
  tenantId: string;
  config: MicroSandboxConfig;
}

interface LastExec {
  at: number;
  ok: boolean;
  durationMs: number;
  exitCode: number;
}

type State = "stopped" | "starting" | "ready" | "error";

// We keep a typed-as-unknown handle for the SDK's `Sandbox` because
// pulling in its type from a lazy import would force an eager
// compile-time dep on the napi types. The actual methods we call
// (exec, stopAndWait, removePersisted) are exercised by the runner
// itself; mistyping is caught at runtime.
/** Minimal subset of microsandbox's `Sandbox` we touch. The SDK
 *  exposes a much richer surface; we only declare what we use so a
 *  type drift in microsandbox doesn't break our build. */
type SandboxHandle = {
  /** Sandbox name (for static SDK calls like Sandbox.remove). */
  readonly name?: string;
  exec(cmd: string, args?: Iterable<string>): Promise<{
    code: number;
    stdout(): string;
    stderr(): string;
  }>;
  shell(script: string): Promise<{
    code: number;
    stdout(): string;
    stderr(): string;
  }>;
  /** Streaming variant of shell(). Returns an ExecHandle whose
   *  `kill()` we use to enforce per-exec timeouts — plain
   *  `shell()` blocks indefinitely if the host-guest exec
   *  channel dies mid-stream. */
  shellStream(script: string): Promise<ExecHandleLike>;
  // Modern SDK shape (microsandbox >= the rename):
  stop?(): Promise<unknown>;
  stopWithTimeout?(timeoutMs: number): Promise<unknown>;
  // Legacy shape kept for back-compat detection:
  stopAndWait?(): Promise<unknown>;
  removePersisted?(): Promise<unknown>;
};

/** Subset of microsandbox's `ExecHandle` (returned by `shellStream`)
 *  that our timeout wrapper relies on. */
type ExecHandleLike = {
  /** Drain stdout/stderr and wait for exit. */
  collect(): Promise<{
    code: number;
    stdout(): string;
    stderr(): string;
  }>;
  /** SIGKILL the process group. Best-effort; safe to call after
   *  the process has already exited. */
  kill(): Promise<void>;
};

export class MicrosandboxRunner implements SandboxRunner {
  readonly id: string;
  readonly kind = "shell" as const;
  /** Browser sidecar exposed via `provides: [browser.cdp]`. The
   *  N+5.1 scaffold returns undefined ports; N+5.3 will fill them
   *  in once chromium + Playwright MCP are running inside the VM. */
  readonly browser: BrowserSidecar = new MicrosandboxBrowserSidecar();
  private readonly opts: MicrosandboxRunnerOpts;
  private readonly bornAt = Date.now();

  private state: State = "stopped";
  private startError: string | null = null;
  private startedAt = 0;
  private handle: SandboxHandle | null = null;
  private startPromise: Promise<void> | null = null;
  private lastExec: LastExec | null = null;
  /** Snapshot name actually being used by the live VM, or null when
   *  booted from `image(...)`. Surfaced in status().meta. */
  private activeSnapshot: string | null = null;

  constructor(opts: MicrosandboxRunnerOpts) {
    this.id = `${opts.pluginId}.${opts.contributionId}`;
    this.opts = opts;
  }

  /**
   * Kick off a VM start without waiting for it. Used by the plugin's
   * `activate()` so the sandbox is warm by the time the user opens
   * the chat — no first-exec stall, status panel reads `ready`
   * within ~10s of plugin enable.
   *
   * Errors during warm-up land in `this.startError` and surface via
   * `status()`; we don't throw because the caller (activate hook)
   * shouldn't fail just because a background warm-up failed. The
   * next real `exec()` will see the error state and surface it to
   * the agent properly.
   */
  warmUp(): void {
    if ((this.state as State) === "ready") return;
    if (this.startPromise) return;
    this.state = "starting";
    this.startError = null;
    this.startPromise = this.doStart()
      .catch(() => {
        // doStart already set state="error" + startError. Swallow
        // here so the unhandled-rejection guard doesn't fire.
      })
      .finally(() => {
        this.startPromise = null;
      });
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const start = Date.now();
    // Resolve effective timeout: caller-supplied wins, then
    // tenant-config (configurable via the new admin form), then
    // DEFAULT_CONFIG.execTimeoutMs (5 min). 0 / undefined means
    // "no timeout" — we still recommend the configured one but
    // honour an explicit opt-out for the rare e2e fixture.
    const timeoutMs =
      typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs)
        ? Math.max(0, req.timeoutMs)
        : this.opts.config.execTimeoutMs;
    try {
      const handle = await this.ensureStarted();
      const workdir = req.workdir ?? "/workspace";
      // Switch to the tenant user (created on demand) instead of
      // running every command as root. microsandbox v0 has no user
      // namespace, so the OS-level uid was always 0; the agent's
      // `whoami` answered "root", and there was no way to express
      // "I am tenant user dev" except via the env hack we used to
      // ship in PR #137.
      //
      // New approach: each `req.userId` becomes a real Linux
      // account inside the guest with `useradd`, gets nopasswd
      // sudoers, and the actual command runs through
      // `runuser -u <id> -- bash -c '...'`. So:
      //   - `whoami` returns <id>             (real uid)
      //   - `$USER` / `$LOGNAME` set to <id>  (runuser injects)
      //   - `$HOME` set to /workspace/users/<id> (passwd entry)
      //   - `~` expands to that home          (shell honours $HOME)
      //   - `sudo apt install ...` works      (nopasswd sudoers)
      //   - `id <id>` returns a stable uid    (cksum-derived, so
      //                                        the same userId
      //                                        always picks the
      //                                        same uid)
      //
      // The user creation is idempotent (`id <id>` short-circuits
      // when the account already exists). Sandboxfile build steps
      // and admin/debug exec calls (no req.userId) keep the legacy
      // root-with-empty-env behaviour — useful for image setup
      // and debugging the system layer directly.
      //
      // We also export `MSB_USER_ID` after `runuser` so scripts
      // that want an unambiguous "injected by microsandbox" name
      // can read it.
      const userBlock = req.userId
        ? buildTenantUserBlock(req.userId, workdir, req.command)
        : `set -e; cd "${shellEscape(workdir)}"; ${req.command}`;
      const script = userBlock;
      // Use shellStream (which yields an ExecHandle we can kill)
      // instead of shell (which is fire-and-wait). With a handle
      // we can race `collect()` against a timeout and call
      // `handle.kill()` on overrun, instead of letting the SDK
      // sit forever waiting for an exit event that never comes.
      // The "exec session ended without exit event" failure mode
      // Yu was hitting was specifically this: a 13-minute exec
      // where the host-guest channel had broken, but our code had
      // no way to give up on it.
      // Sentinel object identity — not a string — so TS narrows
      // the union cleanly without us casting the ExecOutput shape.
      const TIMEOUT = Symbol("exec-timeout");
      const HANDSHAKE = Symbol("exec-handshake-timeout");
      const ABORTED = Symbol("exec-aborted");
      // Shared abort race used by both the handshake and the
      // collect step below. If the caller already aborted before
      // we got here, fast-path back; otherwise listen once.
      const buildAbortP = (): Promise<typeof ABORTED> => {
        const sig = req.signal;
        if (!sig) return new Promise(() => {});
        if (sig.aborted) return Promise.resolve(ABORTED);
        return new Promise((resolve) => {
          sig.addEventListener("abort", () => resolve(ABORTED), {
            once: true,
          });
        });
      };
      // `shellStream(script)` itself can hang if the host-guest
      // agent socket is dead — the SDK is waiting on a
      // start-of-stream ack that will never come. Without this
      // race, the timeout below is *never armed* and the call
      // blocks forever. We give the handshake the same budget as
      // the exec itself; whichever fires first surfaces a
      // structured timeout instead of an unbounded hang.
      const handshakeP: Promise<typeof HANDSHAKE> =
        timeoutMs > 0
          ? new Promise((resolve) =>
              setTimeout(() => resolve(HANDSHAKE), timeoutMs),
            )
          : new Promise(() => {});
      const startedExec = await Promise.race([
        handle.shellStream(script),
        handshakeP,
        buildAbortP(),
      ]);
      if (startedExec === HANDSHAKE) {
        const durationMs = Date.now() - start;
        this.lastExec = {
          at: Date.now(),
          ok: false,
          durationMs,
          exitCode: -1,
        };
        return {
          exitCode: -1,
          stdout: "",
          stderr:
            `[microsandbox] shellStream() did not return within ${timeoutMs}ms — ` +
            `the host-guest agent socket may be wedged. Try \`reset_sandbox\`; ` +
            `if it repeats across resets, the VM itself is stuck.`,
          durationMs,
          timedOut: true,
        };
      }
      if (startedExec === ABORTED) {
        // Abort fired before shellStream even returned. Nothing to
        // kill on the guest side; just surface the cancellation.
        const durationMs = Date.now() - start;
        this.lastExec = {
          at: Date.now(),
          ok: false,
          durationMs,
          exitCode: -1,
        };
        return {
          exitCode: -1,
          stdout: "",
          stderr:
            `[microsandbox] exec aborted by caller before shellStream returned.`,
          durationMs,
          timedOut: false,
          aborted: true,
        };
      }
      const exec = startedExec;
      let timer: NodeJS.Timeout | null = null;
      const collectP = exec.collect();
      const timeoutP =
        timeoutMs > 0
          ? new Promise<typeof TIMEOUT>((resolve) => {
              timer = setTimeout(() => {
                // Best-effort: SIGKILL the running process. If the
                // channel itself is dead, kill() may also fail;
                // we just want to break out of collect()'s wait so
                // the caller sees a structured timeout instead of
                // an unbounded hang.
                exec.kill().catch(() => {});
                resolve(TIMEOUT);
              }, timeoutMs);
            })
          : new Promise<never>(() => {});
      // Abort race for the collect step: when the agent loop's
      // signal fires, SIGKILL the guest process and surface a
      // structured `aborted` result. Mirror of the timeout path
      // but distinguishable to the caller (`aborted: true`,
      // `timedOut: false`).
      const collectAbortP = buildAbortP();
      const winner = await Promise.race([collectP, timeoutP, collectAbortP]);
      if (timer) clearTimeout(timer);
      if (winner === ABORTED) {
        exec.kill().catch(() => {});
        // Best-effort drain so the agent sees whatever stdout
        // the killed command produced before it died.
        let partial = { stdout: "", stderr: "" };
        try {
          const drained = await Promise.race([
            collectP,
            new Promise<null>((r) => setTimeout(() => r(null), 1500)),
          ]);
          if (drained) {
            partial = { stdout: drained.stdout(), stderr: drained.stderr() };
          }
        } catch {
          // best-effort
        }
        const durationMs = Date.now() - start;
        this.lastExec = {
          at: Date.now(),
          ok: false,
          durationMs,
          exitCode: -1,
        };
        return {
          exitCode: -1,
          stdout: partial.stdout,
          stderr:
            (partial.stderr ? partial.stderr + "\n" : "") +
            `[microsandbox] exec aborted by caller; SIGKILL sent.`,
          durationMs,
          timedOut: false,
          aborted: true,
        };
      }
      if (winner === TIMEOUT) {
        // Try to drain whatever stdout/stderr the kill produced;
        // collect() resolves shortly after kill on a healthy channel.
        let partial: { stdout: string; stderr: string } = {
          stdout: "",
          stderr: "",
        };
        try {
          const drained = await Promise.race([
            collectP,
            new Promise<null>((r) => setTimeout(() => r(null), 1500)),
          ]);
          if (drained) {
            partial = { stdout: drained.stdout(), stderr: drained.stderr() };
          }
        } catch {
          // best-effort drain
        }
        const durationMs = Date.now() - start;
        this.lastExec = {
          at: Date.now(),
          ok: false,
          durationMs,
          exitCode: -1,
        };
        return {
          exitCode: -1,
          stdout: partial.stdout,
          stderr:
            (partial.stderr ? partial.stderr + "\n" : "") +
            `[microsandbox] exec timed out after ${timeoutMs}ms; sent SIGKILL. ` +
            `If you need a longer budget, raise plugins.microsandbox.config.execTimeoutMs ` +
            `(currently ${this.opts.config.execTimeoutMs}ms) or pass timeoutMs in the call. ` +
            `For commands that should outlive the call (servers, supervisord), ` +
            `start them with 'nohup setsid … > /tmp/log 2>&1 < /dev/null &'.`,
          durationMs,
          timedOut: true,
        };
      }
      const out = winner;
      const durationMs = Date.now() - start;
      const exitCode = out.code;
      this.lastExec = {
        at: Date.now(),
        ok: exitCode === 0,
        durationMs,
        exitCode,
      };
      return {
        exitCode,
        stdout: out.stdout(),
        stderr: out.stderr(),
        durationMs,
        timedOut: false,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.lastExec = { at: Date.now(), ok: false, durationMs, exitCode: -1 };
      // "exec session ended without exit event" is the SDK's way
      // of saying the host-guest channel died mid-stream. The
      // sandbox itself may still be reachable (status=ready) but
      // any further `exec` calls have a high chance of doing the
      // same. Surface a recovery hint so the agent doesn't loop.
      const looksLikeChannelLoss =
        message.includes("exec session ended") ||
        message.includes("without exit event") ||
        message.includes("connection closed") ||
        message.includes("channel closed");
      const advice = looksLikeChannelLoss
        ? "\n[microsandbox] the exec channel between host and guest agent died " +
          "mid-stream. The VM itself may still be running, but new exec calls " +
          "are likely to repeat the failure. Recovery: call `reset_sandbox`. " +
          "Files under /workspace survive a reset."
        : "";
      return {
        exitCode: -1,
        stdout: "",
        stderr: `microsandbox exec failed: ${message}${advice}`,
        durationMs,
        timedOut: false,
      };
    }
  }

  async readFile(relPath: string): Promise<string> {
    return fs.readFile(this.resolveSafe(relPath), "utf8");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const abs = this.resolveSafe(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  workspacePath(): string {
    return this.opts.workspaceDir;
  }

  async reset(): Promise<void> {
    console.log("[microsandbox] reset() begin");
    await this.shutdown();
    console.log(`[microsandbox] reset() shutdown done state=${this.state}`);
    this.state = "stopped";
    this.startError = null;
    this.handle = null;
    this.startPromise = null;
    this.lastExec = null;
    this.activeSnapshot = null;
    console.log("[microsandbox] reset() calling warmUp()");
    this.warmUp();
    console.log(`[microsandbox] reset() after warmUp state=${this.state} hasStartPromise=${!!this.startPromise}`);
  }

  async shutdown(): Promise<void> {
    if (this.handle) {
      // SDK rename: stopAndWait → stop / stopWithTimeout. Try modern
      // shape first, fall back to legacy. All wrapped in try/catch
      // because shutdown is idempotent and best-effort.
      try {
        const h = this.handle;
        if (typeof h.stopWithTimeout === "function") {
          await h.stopWithTimeout(15_000);
        } else if (typeof h.stop === "function") {
          await h.stop();
        } else if (typeof h.stopAndWait === "function") {
          await h.stopAndWait();
        }
      } catch {
        /* may have already exited */
      }
      try {
        const h = this.handle;
        if (typeof h.removePersisted === "function") {
          await h.removePersisted();
        } else {
          // Modern SDK uses static Sandbox.remove(name).
          const msb = await import("microsandbox");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const SandboxAny = (msb as any).Sandbox;
          if (h.name && SandboxAny && typeof SandboxAny.remove === "function") {
            await SandboxAny.remove(h.name);
          }
        }
      } catch {
        /* idempotent */
      }
    }
    this.handle = null;
    this.state = "stopped";
  }

  async status(): Promise<SandboxStatus> {
    const stateForClient: SandboxStatus["state"] =
      this.state === "stopped"
        ? "stopped"
        : this.state === "starting"
          ? "starting"
          : this.state === "error"
            ? "error"
            : "ready";
    return {
      state: stateForClient,
      uptimeMs:
        this.state === "ready" && this.startedAt > 0
          ? Date.now() - this.startedAt
          : Date.now() - this.bornAt,
      lastError: this.startError ?? undefined,
      meta: {
        runner: "microsandbox",
        sandboxName: this.opts.config.sandboxName,
        image: this.opts.config.image,
        cpus: this.opts.config.cpus,
        memoryMib: this.opts.config.memoryMib,
        workspaceDir: this.opts.workspaceDir,
        activeSnapshot: this.activeSnapshot ?? undefined,
        lastExec: this.lastExec ?? undefined,
      },
    };
  }

  // ─── internals ──────────────────────────────────────────────────

  /** Ensure the sandbox is running. Single-flight: concurrent exec
   *  calls during startup share the same in-flight promise. */
  private async ensureStarted(): Promise<SandboxHandle> {
    if (this.handle && (this.state as State) === "ready") return this.handle;
    if (this.startPromise) {
      await this.startPromise;
      if ((this.state as State) !== "ready" || !this.handle) {
        throw new Error(this.startError ?? "sandbox failed to start");
      }
      return this.handle;
    }
    this.state = "starting";
    this.startError = null;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
    if ((this.state as State) !== "ready" || !this.handle) {
      throw new Error(this.startError ?? "sandbox failed to start");
    }
    return this.handle;
  }

  private async doStart(): Promise<void> {
    try {
      const { Sandbox } = await loadMsb();
      const ws = this.opts.workspaceDir;
      await fs.mkdir(ws, { recursive: true });

      // If the tenant has selected a custom build via
      // use_sandbox_build, prefer that over the configured base
      // image. Falls back to image(...) if no pointer or the
      // snapshot was removed out-of-band.
      const pointer = await readPointer(ws);
      let useSnapshot: string | null = null;
      if (pointer) {
        const exists = await snapshotExists(pointer.snapshotName);
        if (exists) {
          useSnapshot = pointer.snapshotName;
        }
      }

      // Pick host ports for the browser stack BEFORE we hand the
      // builder to napi. Doing this lazily later means another
      // process could grab the port between snapshot boot and our
      // .port() call.
      const [cdpHost, mcpHost, vncHost] = await pickFreePorts(3);

      // napi-rs builder methods are runtime-typed; we re-cast through
      // a structural any-shape to keep the call sites readable.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let builder: any = (Sandbox as any)
        .builder(this.opts.config.sandboxName)
        .cpus(this.opts.config.cpus)
        .memory(this.opts.config.memoryMib)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .volume("/workspace", (m: any) =>
          // statVirtualization("off") makes the guest see the real
          // host uid/gid on bind-mounted files, instead of the
          // virtualized 0:0 view that microsandbox defaults to. This
          // is what lets a non-root tenant user (created via
          // `useradd -u <hostUid>` below) actually read and write
          // its own workspace directory — chmod / chown on the
          // virtualized view of a bind-mount has no effect on the
          // underlying access check, which is performed against the
          // host filesystem with the real host uid.
          m.bind(ws).statVirtualization("off"),
        )
        // Forward host:cdp -> guest:9222 and friends. Always wired
        // even when the active image doesn't include the browser
        // stack; the forward is a no-op until something inside the
        // guest binds the matching guest port.
        .port(cdpHost, BROWSER_GUEST_CDP_PORT)
        .port(mcpHost, BROWSER_GUEST_MCP_PORT)
        .port(vncHost, BROWSER_GUEST_VNC_PORT)
        .replace(true);

      if (useSnapshot) {
        builder = builder.fromSnapshot(useSnapshot);
      } else {
        builder = builder.image(this.opts.config.image);
      }

      this.handle = (await builder.create()) as SandboxHandle;
      this.activeSnapshot = useSnapshot;
      this.state = "ready";
      this.startedAt = Date.now();

      // Surface the host ports through the sidecar so the host
      // capability registry advertises browser.cdp with real
      // values, and the admin Browser page renders them.
      // __setDetectedPorts is the runner's back-channel into its
      // own sidecar; the public BrowserSidecar surface stays
      // read-only.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.browser as any).__setDetectedPorts({
        cdp: cdpHost,
        mcp: mcpHost,
        vnc: vncHost,
      });

      // If the snapshot includes the browser stack (its rootfs has
      // the supervisord conf we ship in templates/browser.yaml),
      // bring supervisord up. Otherwise it's a no-op silent.
      // We don't await: supervisord forks into daemon mode in <1s
      // and the sandbox is already "ready" once the VM exists.
      void this.maybeStartBrowserStack();
    } catch (err) {
      this.state = "error";
      this.startError = err instanceof Error ? err.message : String(err);
      this.handle = null;
      throw err;
    }
  }

  /**
   * If the active image ships /etc/supervisor/conf.d/browser.conf
   * (browser-template-built sandboxes), start supervisord. Best
   * effort: any failure logs and is forgotten so the shell sandbox
   * stays usable on plain images. The runtime conf check + the
   * existing rm of the chrome profile lock from a previous boot
   * keep restarts idempotent.
   */
  private async maybeStartBrowserStack(): Promise<void> {
    if (!this.handle) return;
    try {
      const probe = await this.handle.shell(
        "test -f /etc/supervisor/conf.d/browser.conf && command -v supervisord >/dev/null && echo present || echo absent",
      );
      const stdout = probe.stdout().trim();
      if (stdout !== "present") return;
      // Clean stale state from prior boots: socket from a dead
      // supervisord, pid file, and the chrome profile lock the
      // build VM may have left behind. Then daemonise.
      await this.handle.shell(
        "rm -f /var/run/supervisor.sock /var/run/supervisord.pid; rm -rf /tmp/chrome-profile; supervisord -c /etc/supervisor/conf.d/browser.conf",
      );
    } catch {
      // Don't surface to startError — the shell sandbox itself is
      // fine, only the optional browser stack failed.
    }
  }

  private resolveSafe(relPath: string): string {
    if (path.isAbsolute(relPath)) {
      throw new Error(`absolute paths not allowed: ${relPath}`);
    }
    const abs = path.resolve(this.opts.workspaceDir, relPath);
    const rel = path.relative(this.opts.workspaceDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${relPath}`);
    }
    return abs;
  }
}

function shellEscape(s: string): string {
  return s.replace(/(["\\$`])/g, "\\$1");
}

// Tenant user ids reach this code from `ctx.userId`, which the host
// derives from the auth resolver (today: hardcoded "dev"; future:
// JWT subject). We still validate here as a defence-in-depth check
// because the value ends up as part of a shell script (useradd /
// runuser arguments) inside the guest.
const TENANT_USER_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/;

/**
 * Build the bash script that
 *   1. ensures a Linux user matching `userId` exists in the guest
 *      (idempotent useradd + sudoers grant)
 *   2. drops to that user via `runuser` and runs `command` in `cwd`.
 *
 * Why host uid: microsandbox bind-mounts enforce permissions against
 * the host's real uid even when the guest sees a virtualised owner.
 * Combined with `.statVirtualization("off")` on the mount (set at
 * sandbox boot) the guest now sees the real host uid, and creating
 * the tenant user with that same uid is the only way a non-root
 * guest process can actually access its own workspace files. All
 * tenant users on this host therefore share one numeric uid, which
 * is fine because the sandbox is per-tenant and per-user role names
 * still come from `useradd -o ${name}`.
 */
function hostUid(): number {
  const fn = (process as { getuid?: () => number }).getuid;
  return typeof fn === "function" ? fn.call(process) : 1000;
}

function buildTenantUserBlock(
  userId: string,
  cwd: string,
  command: string,
): string {
  if (!TENANT_USER_ID_RE.test(userId)) {
    throw new Error(
      `invalid tenant userId for sandbox exec: ${JSON.stringify(userId)}`,
    );
  }
  const safeUserId = userId; // already regex-validated above
  const home = `/workspace/users/${safeUserId}`;
  const uid = hostUid();
  // Shell-safe quoting of the user-supplied command: pass it as a
  // single argv to `bash -c`, embedded as a single-quoted string so
  // no inner expansion happens at the outer layer (the inner
  // `bash -c` does its own parsing).
  const innerCmd = command.replace(/'/g, `'\\''`);
  return [
    `set -e`,
    // Idempotent user creation. `id <user>` short-circuits when the
    // account exists. The `-o` flag allows reuse of an already-taken
    // uid (necessary because we deliberately match the host uid),
    // and the workspace bind-mount becomes the user's $HOME so a
    // bare `cd ~` lands where the file tools see "/".
    `if ! id ${safeUserId} >/dev/null 2>&1; then`,
    `  useradd -d "${home}" -s /bin/bash -u ${uid} -o ${safeUserId} >/dev/null 2>&1 || true`,
    `  echo '${safeUserId} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${safeUserId}`,
    `  chmod 440 /etc/sudoers.d/${safeUserId}`,
    `fi`,
    // Drop to the tenant user and run the command. `runuser`
    // initialises HOME / USER / LOGNAME from /etc/passwd, and we
    // additionally export MSB_USER_ID for scripts that want an
    // unambiguous "injected by microsandbox" handle.
    `runuser -u ${safeUserId} -- env MSB_USER_ID=${safeUserId} bash -c 'cd "${shellEscape(cwd)}" && ${innerCmd}'`,
  ].join("\n");
}
