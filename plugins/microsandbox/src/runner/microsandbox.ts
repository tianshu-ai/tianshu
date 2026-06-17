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
      // Inject a per-tenant-user shell context. microsandbox v0
      // runs every guest process as root with an empty env, so a
      // `$USER` / `$HOME` lookup inside agent shell snippets gives
      // back nothing useful. The agent's mental model is `userId`
      // = the `users/<id>/` workspace it sees from file tools, so
      // we mirror that into the shell:
      //   USER, LOGNAME      = the tenant user id
      //   HOME               = /workspace/users/<id> (matches
      //                        ExecTool's default workdir)
      //   MSB_USER_ID        = same value, namespaced for scripts
      //                        that want to be explicit
      // Only set when req.userId is provided; otherwise the legacy
      // empty-env behaviour is preserved (admin debug shell, build
      // step verifications, etc).
      const envPrefix = req.userId
        ? `export USER=${shellEscape(req.userId)} LOGNAME=${shellEscape(req.userId)} HOME=${shellEscape(`/workspace/users/${req.userId}`)} MSB_USER_ID=${shellEscape(req.userId)}; `
        : "";
      // We always run through `bash -c "cd <wd> && <cmd>"` rather
      // than `shell(...)` because we want a hard-fail when the
      // workdir doesn't exist (mirrors the closed-source behaviour).
      // The microsandbox shell() wraps with `bash -lc` and ignores
      // `cd` failures.
      const script = `set -e; ${envPrefix}cd "${shellEscape(workdir)}"; ${req.command}`;
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
      const exec = await handle.shellStream(script);
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
      const winner = await Promise.race([collectP, timeoutP]);
      if (timer) clearTimeout(timer);
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
        .volume("/workspace", (m: any) => m.bind(ws))
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
