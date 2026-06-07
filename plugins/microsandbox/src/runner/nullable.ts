// Nullable runner — used when the microsandbox binary isn't found on
// PATH (or wherever `config.binary` points). Per ADR-0004 §9 the
// capability is **still** registered with the host so dependent
// plugins don't fail with "no provider", but every operation
// returns a structured error and the agent's tool gating (§10) will
// refuse to surface `exec` to the model because `status().state`
// reports "error".
//
// The class is intentionally trivial — its only job is to be honest
// about why nothing works.

import type {
  BrowserSidecar,
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu/plugin-sdk";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { MicrosandboxBrowserSidecar } from "./browser.js";

export interface NullableRunnerOpts {
  pluginId: string;
  contributionId: string;
  workspaceDir: string;
  /** Filled in by the facade — describes why the real runner couldn't
   *  start. Surfaces verbatim in `status().lastError`. */
  reason: string;
}

export class NullableRunner implements SandboxRunner {
  readonly id: string;
  readonly kind = "shell" as const;
  /** Browser sidecar slot — even the nullable runner exposes one
   *  so `browser.cdp` registers as a provider when the SDK loads
   *  but the chromium stack hasn't been built yet. The sidecar
   *  reports no ports and refuses restart, exactly matching the
   *  nullable shell semantics. */
  readonly browser: BrowserSidecar = new MicrosandboxBrowserSidecar();
  private readonly opts: NullableRunnerOpts;
  private readonly bornAt = Date.now();

  constructor(opts: NullableRunnerOpts) {
    this.id = `${opts.pluginId}.${opts.contributionId}`;
    this.opts = opts;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async exec(_req: ExecRequest): Promise<ExecResult> {
    return {
      exitCode: -1,
      stdout: "",
      stderr: `microsandbox unavailable: ${this.opts.reason}`,
      durationMs: 0,
      timedOut: false,
    };
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
    // Nothing to reset.
  }

  async shutdown(): Promise<void> {
    // Nothing to tear down.
  }

  async status(): Promise<SandboxStatus> {
    return {
      state: "error",
      uptimeMs: Date.now() - this.bornAt,
      lastError: this.opts.reason,
      meta: { runner: "nullable" },
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────

  /**
   * Resolve a relative path against the host workspace dir, refusing
   * paths that escape it. We ban absolute paths and anything that
   * normalises outside the workspace.
   */
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
