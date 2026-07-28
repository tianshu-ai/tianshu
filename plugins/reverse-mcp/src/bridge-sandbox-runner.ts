// BridgeSandboxRunner — implements SandboxRunner by forwarding exec/file
// operations to a connected local-bridge device. Registered as the
// sandbox.shell capability so the workboard (and any other consumer)
// can run commands on the user's machine transparently.
//
// This runner is shared (one instance per tenant). Each exec/readFile/
// writeFile call resolves the user from the request context and picks
// the first connected bridge device for that user.

import type {
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxKind,
  SandboxStatus,
} from "@tianshu-ai/plugin-sdk";
import type { BridgeRegistry } from "./registry.js";

export interface BridgeSandboxRunnerOpts {
  registry: BridgeRegistry;
  /** Placeholder — actual userId comes from ExecRequest.userId at runtime. */
  userId: string;
  deviceId: string;
}

export class BridgeSandboxRunner implements SandboxRunner {
  readonly id = "reverse-mcp.bridge-shell";
  readonly kind: SandboxKind = "shell";

  private registry: BridgeRegistry;

  constructor(opts: BridgeSandboxRunnerOpts) {
    this.registry = opts.registry;
  }

  private getConn(userId?: string) {
    // Find the first bridge device for the given user, or any user
    // if userId is not specified.
    if (userId) {
      const conns = this.registry.forUser(userId);
      if (conns.length > 0) return conns[0];
    }
    // Fallback: any connected device (single-user setups).
    const all = this.registry.all?.() ?? [];
    return all[0] ?? null;
  }

  private async callBridgeTool(
    userId: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const conn = this.getConn(userId);
    if (!conn) {
      throw new Error(
        "No bridge device connected. Start the Tianshu Bridge desktop app and try again.",
      );
    }
    const result = await this.registry.call(conn, "tools/call", {
      name,
      arguments: args,
    });
    return (result ?? {}) as Record<string, unknown>;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const t0 = Date.now();
    try {
      const result = await this.callBridgeTool(req.userId, "shell_exec", {
        command: req.command,
        cwd: req.workdir ?? "/tmp",
        ...(req.timeoutMs ? { timeout_ms: req.timeoutMs } : {}),
      });
      const durationMs = Date.now() - t0;
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map((c: { text?: string }) => c.text ?? "").join("\n");
      const exitCode =
        typeof result.exit_code === "number" ? result.exit_code :
        typeof (result as { exitCode?: number }).exitCode === "number"
          ? (result as { exitCode?: number }).exitCode! : 0;
      return { stdout: text, stderr: "", exitCode, durationMs, timedOut: false };
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
    const result = await this.callBridgeTool(undefined, "shell_exec", {
      command: `cat ${JSON.stringify(relPath)}`,
    });
    const content = Array.isArray(result.content) ? result.content : [];
    return content.map((c: { text?: string }) => c.text ?? "").join("\n");
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const escaped = content.replace(/'/g, "'\\''");
    await this.callBridgeTool(undefined, "shell_exec", {
      command: `mkdir -p "$(dirname ${JSON.stringify(relPath)})" && printf '%s' '${escaped}' > ${JSON.stringify(relPath)}`,
    });
  }

  workspacePath(): string {
    return "/tmp/tianshu-bridge-workspace";
  }

  async reset(): Promise<void> {
    // No-op for bridge.
  }

  async shutdown(): Promise<void> {
    // Bridge connection persists independently.
  }

  async status(): Promise<SandboxStatus> {
    const conns = this.registry.all?.() ?? [];
    if (conns.length > 0) {
      return {
        state: "running",
        uptimeMs: conns[0].connectedAt
          ? Date.now() - new Date(conns[0].connectedAt).getTime()
          : 0,
        meta: { devices: conns.length },
      };
    }
    return { state: "stopped", uptimeMs: 0 };
  }
}
