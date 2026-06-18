// Per-task sandbox pool.
//
// Lifecycle (matches PR #140 + this PR's design):
//
//   workboard task pickup
//     → SandboxPool.acquireTask(taskId)
//         → first time:  Sandbox.builder(tianshu-task-<taskId>)
//                          .fromSnapshot(<task-role pointer>)
//                          .create()         (await; ~500ms warm)
//         → resume:      Sandbox.start(name) (await; ~200ms)
//
//   agent-loop runs on this task
//     → ExecTool sees ctx.taskId, calls runner.exec({...,taskId})
//     → SandboxRunner facade routes to pool.execForTask(taskId, req)
//
//   worker run terminates (any reason)
//     → SandboxPool.releaseTask(taskId)
//         → sandbox.stop()  (preserves disk + installed packages;
//                            frees RAM)
//         → state = 'stopped'; pool entry kept so retry can resume
//
//   workboard task_delete
//     → SandboxPool.destroyTask(taskId)
//         → sandbox.stop() if running, then handle.remove() so
//                            disk image is reclaimed
//
//   plugin deactivate
//     → SandboxPool.dispose()
//         → stop every running task sandbox (don't remove; next
//                            activate can resume)
//
// Resource sizing comes from MicroSandboxConfig.task* fields
// (PR #140); falling back to the browser-role values when not set.
//
// `bindSession(sessionId, taskId)` lets the SandboxRunner facade
// resolve `ctx.sessionId` -> taskId for tool calls that don't
// carry an explicit `req.taskId`. Workboard wires this from
// onSessionStart so every worker session lands in the right
// per-task sandbox.

import type {
  ExecRequest,
  ExecResult,
  TaskSandboxPool,
  PluginLogger,
} from "@tianshu/plugin-sdk";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { MicroSandboxConfig } from "./types.js";
import { readPointers } from "../build/pointer.js";
import { snapshotExists } from "../build/builder.js";

// Lazy-load the SDK identical to microsandbox.ts so non-msb
// platforms don't pay the import cost when the pool is referenced
// but never used.
type MsbModule = typeof import("microsandbox");
let msbModuleP: Promise<MsbModule> | null = null;
function loadMsb(): Promise<MsbModule> {
  if (!msbModuleP) {
    msbModuleP = import("microsandbox");
  }
  return msbModuleP;
}

/** Subset of microsandbox's `Sandbox` we touch. Mirrors the
 *  SandboxHandle in microsandbox.ts. */
type SandboxLike = {
  readonly name?: string;
  shellStream(script: string): Promise<{
    collect(): Promise<{
      code: number;
      stdout(): string;
      stderr(): string;
    }>;
    kill(): Promise<void>;
  }>;
  stop?(): Promise<unknown>;
  stopWithTimeout?(timeoutMs: number): Promise<unknown>;
};

interface TaskEntry {
  readonly taskId: string;
  /** microsandbox sandbox name. Stable across stop/start so we can
   *  resume the same on-disk image. */
  readonly sandboxName: string;
  /** Active sandbox handle, or null when stopped. */
  sandbox: SandboxLike | null;
  state: "starting" | "running" | "stopped" | "error";
  startError: string | null;
  /** In-flight start promise so concurrent acquires de-dupe. */
  startPromise: Promise<void> | null;
}

export interface SandboxPoolOpts {
  tenantId: string;
  workspaceDir: string;
  config: MicroSandboxConfig;
  log: PluginLogger;
}

/**
 * Build a buildTenantUserBlock-equivalent shell wrapper. This is
 * the same logic as MicrosandboxRunner uses; we reimplement here
 * to keep the pool independent of the (per-tenant singleton)
 * runner. The contract is "drop privileges to the tenant user
 * before running the user-supplied command".
 *
 * Kept in sync with microsandbox.ts:buildTenantUserBlock.
 */
const TENANT_USER_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/;

function shellEscape(s: string): string {
  return s.replace(/(["\\$`])/g, "\\$1");
}

function hostUid(): number {
  const fn = (process as { getuid?: () => number }).getuid;
  return typeof fn === "function" ? fn.call(process) : 1000;
}

function buildScript(
  userId: string | undefined,
  workdir: string,
  command: string,
): string {
  if (!userId) {
    return `set -e; cd "${shellEscape(workdir)}"; ${command}`;
  }
  if (!TENANT_USER_ID_RE.test(userId)) {
    throw new Error(
      `invalid tenant userId for sandbox exec: ${JSON.stringify(userId)}`,
    );
  }
  const safeUserId = userId;
  const home = `/workspace/users/${safeUserId}`;
  const uid = hostUid();
  const innerCmd = command.replace(/'/g, `'\\''`);
  return [
    `set -e`,
    `if ! id ${safeUserId} >/dev/null 2>&1; then`,
    `  useradd -d "${home}" -s /bin/bash -u ${uid} -o ${safeUserId} >/dev/null 2>&1 || true`,
    `  echo '${safeUserId} ALL=(ALL) NOPASSWD:***' > /etc/sudoers.d/${safeUserId}`,
    `  chmod 440 /etc/sudoers.d/${safeUserId}`,
    `fi`,
    `runuser -u ${safeUserId} -- env MSB_USER_ID=${safeUserId} bash -c 'cd "${shellEscape(workdir)}" && ${innerCmd}'`,
  ].join("\n");
}

const STOPPED_STATE: TaskEntry["state"] = "stopped";

export class SandboxPool implements TaskSandboxPool {
  private readonly entries = new Map<string, TaskEntry>();
  private readonly sessionToTask = new Map<string, string>();
  private readonly opts: SandboxPoolOpts;

  constructor(opts: SandboxPoolOpts) {
    this.opts = opts;
  }

  /**
   * Map a session id back to its task entry, if any. Used by the
   * SandboxRunner facade so a chat tool call without an explicit
   * taskId can still find the right per-task sandbox.
   */
  resolveBySession(sessionId: string | undefined): TaskEntry | undefined {
    if (!sessionId) return undefined;
    const taskId = this.sessionToTask.get(sessionId);
    if (!taskId) return undefined;
    return this.entries.get(taskId);
  }

  /** Direct lookup by taskId. */
  get(taskId: string): TaskEntry | undefined {
    return this.entries.get(taskId);
  }

  /**
   * Snapshot every task entry the pool currently tracks. Used by
   * the admin UI's pool monitor. Mutations to the returned array
   * don't affect the pool.
   */
  list(): ReadonlyArray<{
    taskId: string;
    sandboxName: string;
    state: TaskEntry["state"];
    startError: string | null;
  }> {
    const out: Array<{
      taskId: string;
      sandboxName: string;
      state: TaskEntry["state"];
      startError: string | null;
    }> = [];
    for (const e of this.entries.values()) {
      out.push({
        taskId: e.taskId,
        sandboxName: e.sandboxName,
        state: e.state,
        startError: e.startError,
      });
    }
    return out;
  }

  bindSession(sessionId: string, taskId: string): void {
    this.sessionToTask.set(sessionId, taskId);
  }

  /**
   * Block until a sandbox exists and is ready for `taskId`. First
   * call boots from the configured task-role snapshot; subsequent
   * calls after a release resume the same sandbox so installed
   * packages and saved files survive across attempts.
   */
  async acquireTask(taskId: string, sessionId?: string): Promise<void> {
    if (sessionId) this.sessionToTask.set(sessionId, taskId);
    let entry = this.entries.get(taskId);
    if (!entry) {
      entry = {
        taskId,
        sandboxName: `tianshu-task-${this.opts.tenantId}-${taskId}`,
        sandbox: null,
        state: "starting",
        startError: null,
        startPromise: null,
      };
      this.entries.set(taskId, entry);
    }

    if (entry.state === "running" && entry.sandbox) return;

    if (entry.startPromise) {
      await entry.startPromise;
      if (entry.state !== "running" || !entry.sandbox) {
        throw new Error(entry.startError ?? "sandbox failed to start");
      }
      return;
    }

    entry.state = "starting";
    entry.startError = null;
    entry.startPromise = this.bringUp(entry).finally(() => {
      entry!.startPromise = null;
    });
    await entry.startPromise;
    if ((entry.state as TaskEntry["state"]) !== "running" || !entry.sandbox) {
      throw new Error(entry.startError ?? "sandbox failed to start");
    }
  }

  private async bringUp(entry: TaskEntry): Promise<void> {
    try {
      const { Sandbox } = await loadMsb();
      // Resume path: existing sandbox row with on-disk state.
      // microsandbox throws on Sandbox.start when no row exists,
      // so we don't need to probe up front; the start will fail
      // fast and we fall through to the create path.
      let sandbox: SandboxLike | null = null;
      try {
        const SbStart = (
          Sandbox as unknown as {
            start(name: string): Promise<SandboxLike>;
          }
        ).start;
        if (typeof SbStart === "function") {
          sandbox = await SbStart.call(Sandbox, entry.sandboxName);
        }
      } catch {
        sandbox = null;
      }
      if (!sandbox) {
        // First run: ensure workspace dir, pick the task-role
        // snapshot if any, fork.
        const ws = this.opts.workspaceDir;
        await fs.mkdir(ws, { recursive: true });
        const pointers = await readPointers(ws);
        const taskPointer = pointers.task ?? pointers.browser;
        let snapshotName: string | null = null;
        if (taskPointer) {
          const exists = await snapshotExists(taskPointer.snapshotName);
          if (exists) snapshotName = taskPointer.snapshotName;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let builder: any = (Sandbox as any)
          .builder(entry.sandboxName)
          .cpus(this.opts.config.taskCpus)
          .memory(this.opts.config.taskMemoryMib)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .volume("/workspace", (m: any) =>
            // Same as the long-lived runner: expose host uid so
            // tenant users created inside the guest can access
            // the workspace bind-mount.
            m.bind(ws).statVirtualization("off"),
          )
          .replace(true);
        if (snapshotName) {
          builder = builder.fromSnapshot(snapshotName);
        } else {
          builder = builder.image(this.opts.config.image);
        }
        sandbox = (await builder.create()) as SandboxLike;
      }
      entry.sandbox = sandbox;
      entry.state = "running";
      this.opts.log.info(
        `task sandbox up`,
        { taskId: entry.taskId, sandboxName: entry.sandboxName },
      );
    } catch (err) {
      entry.state = "error";
      entry.startError = err instanceof Error ? err.message : String(err);
      this.opts.log.error(
        `task sandbox failed to start`,
        {
          taskId: entry.taskId,
          err: entry.startError,
        },
      );
      throw err;
    }
  }

  /**
   * Stop the sandbox bound to `taskId` without removing its disk
   * image. Fire-and-forget — returns once the stop has been kicked
   * off so callers (worker pool's runOne finally) aren't blocked
   * on graceful shutdown. Errors are logged.
   */
  releaseTask(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    if (entry.state === STOPPED_STATE) return;
    if (entry.state === "starting" && entry.startPromise) {
      // Defer the stop until startup completes; otherwise we'll
      // race the SDK's create() lock and likely fail.
      void entry.startPromise.then(
        () => this.stopEntry(entry),
        () => {
          /* startPromise already updated state to error */
        },
      );
      return;
    }
    void this.stopEntry(entry);
  }

  private async stopEntry(entry: TaskEntry): Promise<void> {
    const sb = entry.sandbox;
    entry.sandbox = null;
    entry.state = STOPPED_STATE;
    if (!sb) return;
    try {
      if (typeof sb.stopWithTimeout === "function") {
        await sb.stopWithTimeout(10_000);
      } else if (typeof sb.stop === "function") {
        await sb.stop();
      }
    } catch (err) {
      this.opts.log.warn(`task sandbox stop failed`, {
        taskId: entry.taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop AND remove the sandbox so its disk is reclaimed. Called
   * from workboard's task delete handler.
   */
  async destroyTask(taskId: string): Promise<void> {
    const entry = this.entries.get(taskId);
    // Sandbox name is deterministic (tianshu-task-<tenantId>-<taskId>),
    // so we can reclaim the on-disk image even when the in-memory
    // pool entry is missing — the typical case for orphan VMs left
    // behind by a previous process incarnation. Synthesise an entry
    // so the regular stop-and-remove path runs uniformly.
    const sandboxName =
      entry?.sandboxName ?? `tianshu-task-${this.opts.tenantId}-${taskId}`;
    if (entry) {
      // Wait for any in-flight startup so we don't race the SDK.
      if (entry.startPromise) {
        try {
          await entry.startPromise;
        } catch {
          /* startup may have failed; we can still attempt remove */
        }
      }
      if (entry.state === "running") {
        await this.stopEntry(entry);
      }
      this.entries.delete(taskId);
      // Drop session bindings pointing at this taskId.
      for (const [sid, tid] of this.sessionToTask) {
        if (tid === taskId) this.sessionToTask.delete(sid);
      }
    }
    try {
      const { Sandbox } = await loadMsb();
      const SbGet = (
        Sandbox as unknown as {
          get(name: string): Promise<{
            remove(): Promise<void>;
            stopWithTimeout?(ms: number): Promise<void>;
          }>;
        }
      ).get;
      if (typeof SbGet === "function") {
        const handle = await SbGet.call(Sandbox, sandboxName);
        // Orphan VMs may still be 'running' (e.g. a previous process
        // crashed before stop). Attempt a best-effort stop before
        // remove; the SDK's remove rejects on a still-running VM.
        if (typeof handle.stopWithTimeout === "function") {
          await handle.stopWithTimeout(10_000).catch(() => {});
        }
        await handle.remove();
      }
    } catch (err) {
      this.opts.log.warn(`task sandbox remove failed`, {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop every running task sandbox without removing them. Called
   * from plugin deactivate so the next activate cycle can resume.
   */
  async dispose(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state === "running" || entry.state === "starting") {
        tasks.push(this.stopEntry(entry));
      }
    }
    await Promise.allSettled(tasks);
    this.sessionToTask.clear();
  }

  /**
   * Run an exec inside the sandbox bound to `taskId`. Mirrors the
   * timeout / kill semantics of MicrosandboxRunner.exec but
   * without the per-tenant singleton plumbing.
   */
  async execForTask(taskId: string, req: ExecRequest): Promise<ExecResult> {
    const entry = this.entries.get(taskId);
    if (!entry) {
      throw new Error(`no task sandbox for taskId=${taskId}`);
    }
    // Lazy resume: the worker pool is supposed to acquire before
    // exec, but a chat session bound via bindSession() may hit a
    // task whose worker run has ended (state=stopped). Resume on
    // the fly in that case.
    if (entry.state !== "running") {
      await this.acquireTask(taskId);
    }
    if (!entry.sandbox) {
      throw new Error(`task sandbox not ready for taskId=${taskId}`);
    }
    const start = Date.now();
    const timeoutMs =
      typeof req.timeoutMs === "number" && Number.isFinite(req.timeoutMs)
        ? Math.max(0, req.timeoutMs)
        : this.opts.config.taskExecTimeoutMs;
    const workdir = req.workdir ?? "/workspace";
    const script = buildScript(req.userId, workdir, req.command);
    const TIMEOUT = Symbol("exec-timeout");
    const exec = await entry.sandbox.shellStream(script);
    let timer: NodeJS.Timeout | null = null;
    const collectP = exec.collect();
    const timeoutP =
      timeoutMs > 0
        ? new Promise<typeof TIMEOUT>((resolve) => {
            timer = setTimeout(() => {
              exec.kill().catch(() => {});
              resolve(TIMEOUT);
            }, timeoutMs);
          })
        : new Promise<never>(() => {});
    const winner = await Promise.race([collectP, timeoutP]);
    if (timer) clearTimeout(timer);
    if (winner === TIMEOUT) {
      let partial = { stdout: "", stderr: "" };
      try {
        const o = await collectP;
        partial = { stdout: o.stdout(), stderr: o.stderr() };
      } catch {
        /* ignore */
      }
      return {
        exitCode: 124,
        stdout: partial.stdout,
        stderr: partial.stderr,
        durationMs: Date.now() - start,
        timedOut: true,
      };
    }
    const out = winner as Awaited<typeof collectP>;
    return {
      exitCode: out.code,
      stdout: out.stdout(),
      stderr: out.stderr(),
      durationMs: Date.now() - start,
      timedOut: false,
    };
  }
}

/** Path helper exported for tests. */
export function taskSandboxName(tenantId: string, taskId: string): string {
  return `tianshu-task-${tenantId}-${taskId}`;
}
