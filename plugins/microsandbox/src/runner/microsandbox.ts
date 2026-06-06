// Real microsandbox runner.
//
// v0 scope (this PR, ADR-0004 N+2):
// - Resolves the `microsandbox` binary on first use; caches the
//   result. If it isn't on PATH (or wherever config.binary points),
//   the facade falls back to `NullableRunner` instead of
//   instantiating us.
// - exec() shells out to `microsandbox <subcommand>` synchronously
//   per call. We do NOT keep a long-lived microVM in v0 — the
//   binary's project model already amortises VM start by forking
//   from a warm snapshot, so per-call overhead is acceptable for
//   first-cut implementations. A persistent-VM upgrade is a follow-up
//   PR (and what the closed-source repo's MicrosandboxBackend does).
// - readFile / writeFile route through the host workspace bind-mount
//   (same dir mounted as /workspace inside the guest); we read/write
//   on the host side directly. The guest sees changes immediately.
//
// What this is NOT yet:
// - No browser sidecar (browser.cdp). That land in a follow-up PR
//   along with the Sandboxfile-driven warm snapshot.
// - No idle reaping. Implicit because we don't keep a VM around.
// - No status streaming. `status()` returns a snapshot computed on
//   the fly from binary presence + last exec result.

import type {
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu/plugin-sdk";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { MicroSandboxConfig } from "./types.js";

export interface MicrosandboxRunnerOpts {
  pluginId: string;
  contributionId: string;
  workspaceDir: string;
  config: MicroSandboxConfig;
  /** Resolved absolute path to the microsandbox binary. */
  binaryPath: string;
}

interface LastExec {
  at: number;
  ok: boolean;
  durationMs: number;
  exitCode: number;
}

export class MicrosandboxRunner implements SandboxRunner {
  readonly id: string;
  readonly kind = "shell" as const;
  private readonly opts: MicrosandboxRunnerOpts;
  private readonly bornAt = Date.now();
  private lastExec: LastExec | null = null;

  constructor(opts: MicrosandboxRunnerOpts) {
    this.id = `${opts.pluginId}.${opts.contributionId}`;
    this.opts = opts;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const start = Date.now();
    const timeoutMs = req.timeoutMs ?? this.opts.config.execTimeoutMs;
    const workdir = req.workdir ?? "/workspace";
    // Subcommand layout: `microsandbox exec --workdir <wd> --
    // <command>`. We treat the command as a single bash -c string
    // because that mirrors the closed-source repo's contract and
    // matches what plugin authors expect from a "shell" sandbox.
    //
    // NB: this is the *intended* invocation. Until the actual
    // microsandbox project layout is wired (Sandboxfile + warm
    // snapshot — N+2 follow-up), we still get a meaningful exit code
    // and stderr from the binary itself, which is enough to
    // demonstrate the surface end-to-end.
    const args = [
      "exec",
      "--project",
      this.absoluteProjectDir(),
      "--sandbox",
      this.opts.config.sandboxName,
      "--workdir",
      workdir,
      "--",
      "bash",
      "-c",
      req.command,
    ];

    return await new Promise<ExecResult>((resolve) => {
      const child = execFile(
        this.opts.binaryPath,
        args,
        {
          timeout: Math.max(1, timeoutMs),
          maxBuffer: 10 * 1024 * 1024, // 10 MiB; exec.ts tool truncates anyway
          // Inherit env minus DEBUG-y vars we don't want bubbling in.
          env: { ...process.env },
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - start;
          // execFile returns err with .killed === true on SIGTERM
          // from timeout; that's the only timed-out signal node
          // surfaces directly.
          const timedOut =
            (err as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT" ||
            (err && (err as { killed?: boolean }).killed === true && timeoutMs > 0);
          const exitCode =
            err && typeof (err as { code?: number }).code === "number"
              ? ((err as { code: number }).code ?? -1)
              : err
                ? -1
                : 0;
          this.lastExec = {
            at: Date.now(),
            ok: !err,
            durationMs,
            exitCode,
          };
          resolve({
            exitCode,
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() ?? "",
            durationMs,
            timedOut: Boolean(timedOut),
          });
        },
      );
      // Best-effort detach: don't keep the parent alive on shutdown.
      child.on?.("error", () => {});
    });
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
    // v0: per-call invocation, nothing to reset. When the persistent-VM
    // upgrade lands, this will tear down + restart the warm sandbox.
    this.lastExec = null;
  }

  async shutdown(): Promise<void> {
    // v0: per-call invocation, nothing to tear down.
  }

  async status(): Promise<SandboxStatus> {
    // We're "ready" if the binary exists. We don't ping it on every
    // status call — that'd flood the host with `microsandbox version`
    // invocations from the Plugin Manager polling. Initial existence
    // check happened in the facade.
    return {
      state: "ready",
      uptimeMs: Date.now() - this.bornAt,
      meta: {
        runner: "microsandbox",
        binaryPath: this.opts.binaryPath,
        projectDir: this.absoluteProjectDir(),
        sandboxName: this.opts.config.sandboxName,
        lastExec: this.lastExec ?? undefined,
      },
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────

  private absoluteProjectDir(): string {
    return path.isAbsolute(this.opts.config.projectDir)
      ? this.opts.config.projectDir
      : path.join(this.opts.workspaceDir, this.opts.config.projectDir);
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
