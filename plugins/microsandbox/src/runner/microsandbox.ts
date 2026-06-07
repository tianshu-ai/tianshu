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
type SandboxHandle = {
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
  stopAndWait(): Promise<unknown>;
  removePersisted(): Promise<unknown>;
};

export class MicrosandboxRunner implements SandboxRunner {
  readonly id: string;
  readonly kind = "shell" as const;
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
    try {
      const handle = await this.ensureStarted();
      const workdir = req.workdir ?? "/workspace";
      // We always run through `bash -c "cd <wd> && <cmd>"` rather
      // than `shell(...)` because we want a hard-fail when the
      // workdir doesn't exist (mirrors the closed-source behaviour).
      // The microsandbox shell() wraps with `bash -lc` and ignores
      // `cd` failures.
      const script = `set -e; cd "${shellEscape(workdir)}"; ${req.command}`;
      const out = await handle.shell(script);
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
        timedOut: false, // SDK doesn't expose timeout signal in v0.4.x
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.lastExec = { at: Date.now(), ok: false, durationMs, exitCode: -1 };
      return {
        exitCode: -1,
        stdout: "",
        stderr: `microsandbox exec failed: ${message}`,
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
    await this.shutdown();
    // Reset state then immediately warm-up so the VM is back to
    // "ready" without waiting for the next exec(). Without this,
    // the admin Live-sandbox panel sits at state="stopped" until
    // someone happens to call exec, which is confusing right after
    // a Publish & Reset (the user wants to see the new snapshot
    // running, not a stopped marker).
    this.state = "stopped";
    this.startError = null;
    this.handle = null;
    this.startPromise = null;
    this.lastExec = null;
    this.activeSnapshot = null;
    this.warmUp();
  }

  async shutdown(): Promise<void> {
    if (this.handle) {
      try {
        await this.handle.stopAndWait();
      } catch {
        /* may have already exited */
      }
      try {
        await this.handle.removePersisted();
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

      // If a tenant has published a custom snapshot via
      // publish_sandbox, prefer that over the configured base image.
      // Falls back to image(...) if no pointer or the snapshot was
      // removed out-of-band.
      const pointer = await readPointer(ws);
      let useSnapshot: string | null = null;
      if (pointer) {
        const exists = await snapshotExists(pointer.snapshotName);
        if (exists) {
          useSnapshot = pointer.snapshotName;
        }
      }

      // napi-rs builder methods are runtime-typed; we re-cast through
      // a structural any-shape to keep the call sites readable.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let builder: any = (Sandbox as any)
        .builder(this.opts.config.sandboxName)
        .cpus(this.opts.config.cpus)
        .memory(this.opts.config.memoryMib)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .volume("/workspace", (m: any) => m.bind(ws))
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
    } catch (err) {
      this.state = "error";
      this.startError = err instanceof Error ? err.message : String(err);
      this.handle = null;
      throw err;
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
