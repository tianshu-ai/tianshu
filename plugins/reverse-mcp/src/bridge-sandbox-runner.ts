// BridgeSandboxRunner — implements SandboxRunner by forwarding exec/file
// operations to a connected local-bridge device. This lets the workboard
// run opencode tasks on the user's own machine (where opencode is already
// installed) instead of the Docker sandbox.

import type {
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxKind,
  SandboxStatus,
} from "@tianshu-ai/plugin-sdk";
import type { BridgeRegistry, BridgeConn } from "./registry.js";

export interface BridgeSandboxRunnerOpts {
  registry: BridgeRegistry;
  userId: string;
  deviceId: string;
  /** Working directory on the remote machine. Defaults to ~/.tianshu-bridge/workspace */
  workdir?: string;
}

/**
 * A SandboxRunner backed by a local-bridge connection.
 * exec → bridge shell_exec tool
 * readFile/writeFile → bridge sync_down / sync_up (or direct file tools)
 */
export class BridgeSandboxRunner implements SandboxRunner {
  readonly id: string;
  readonly kind: SandboxKind = "bridge";

  private registry: BridgeRegistry;
  private userId: string;
  private deviceId: string;
  private workdir: string;

  constructor(opts: BridgeSandboxRunnerOpts) {
    this.registry = opts.registry;
    this.userId = opts.userId;
    this.deviceId = opts.deviceId;
    this.workdir = opts.workdir ?? "~/.tianshu-bridge/workspace";
    this.id = `reverse-mcp.bridge-${opts.deviceId}`;
  }

  private getConn(): BridgeConn {
    const conn = this.registry
      .forUser(this.userId)
      .find((c) => c.deviceId === this.deviceId);
    if (!conn) {
      throw new Error(
        `Bridge device "${this.deviceId}" is not connected. Start the bridge and try again.`,
      );
    }
    return conn;
  }

  private async callBridgeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const conn = this.getConn();
    const result = await this.registry.call(conn, "tools/call", {
      name,
      arguments: args,
    });
    return (result ?? {}) as Record<string, unknown>;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const args: Record<string, unknown> = {
      command: req.command,
    };
    if (req.workdir) {
      args.cwd = req.workdir;
    } else {
      args.cwd = this.workdir;
    }
    if (req.timeoutMs) {
      args.timeout_ms = req.timeoutMs;
    }

    const t0 = Date.now();
    try {
      const result = await this.callBridgeTool("shell_exec", args);
      const durationMs = Date.now() - t0;
      // bridge shell_exec returns { content: [{type:"text", text:"..."}] }
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((c: { text?: string }) => c.text ?? "")
        .join("\n");

      const exitCode =
        typeof result.exit_code === "number"
          ? result.exit_code
          : typeof (result as { exitCode?: number }).exitCode === "number"
            ? (result as { exitCode?: number }).exitCode!
            : 0;

      return {
        stdout: text,
        stderr: "",
        exitCode,
        durationMs,
        timedOut: false,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: Date.now() - t0,
        timedOut: String(err).includes("timed out"),
      };
    }
  }

  async readFile(relPath: string): Promise<string> {
    const result = await this.callBridgeTool("shell_exec", {
      command: `cat ${JSON.stringify(relPath)}`,
      cwd: this.workdir,
    });
    const content = Array.isArray(result.content) ? result.content : [];
    return content.map((c: { text?: string }) => c.text ?? "").join("\n");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    // Use heredoc to write file content safely
    const escaped = content.replace(/'/g, "'\\''");
    await this.callBridgeTool("shell_exec", {
      command: `mkdir -p "$(dirname ${JSON.stringify(relPath)})" && cat > ${JSON.stringify(relPath)} << 'TIANSHU_EOF'\n${escaped}\nTIANSHU_EOF`,
      cwd: this.workdir,
    });
  }

  workspacePath(): string {
    return this.workdir;
  }

  async reset(): Promise<void> {
    // Clean the workspace directory
    await this.callBridgeTool("shell_exec", {
      command: `rm -rf ${JSON.stringify(this.workdir)} && mkdir -p ${JSON.stringify(this.workdir)}`,
    });
  }

  async shutdown(): Promise<void> {
    // Nothing to tear down — bridge connection persists.
  }

  async status(): Promise<SandboxStatus> {
    const conn = this.registry
      .forUser(this.userId)
      .find((c) => c.deviceId === this.deviceId);
    return {
      state: conn ? "running" : "stopped",
      uptimeMs: conn?.connectedAt
        ? Date.now() - new Date(conn.connectedAt).getTime()
        : 0,
      meta: conn
        ? { device: conn.label ?? conn.deviceId, tools: conn.tools.length }
        : undefined,
    };
  }
}
