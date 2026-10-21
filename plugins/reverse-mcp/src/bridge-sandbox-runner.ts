// BridgeSandboxRunner — implements SandboxRunner by forwarding exec/file
// operations to a connected local-bridge device.

import type {
  ExecRequest,
  ExecResult,
  SandboxRunner,
  SandboxKind,
  SandboxStatus,
} from "@tianshu-ai/plugin-sdk";
import type { BridgeRegistry } from "./registry.js";

const log = {
  info: (msg: string, ...a: unknown[]) => console.log('[reverse-mcp/bridge-sandbox-runner]', msg, ...a),
  warn: (msg: string, ...a: unknown[]) => console.warn('[reverse-mcp/bridge-sandbox-runner]', msg, ...a),
  error: (msg: string, ...a: unknown[]) => console.error('[reverse-mcp/bridge-sandbox-runner]', msg, ...a),
  debug: (msg: string, ...a: unknown[]) => { if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace') console.log('[reverse-mcp/bridge-sandbox-runner] [debug]', msg, ...a); },
};




export interface BridgeSandboxRunnerOpts {
  registry: BridgeRegistry;
  userId: string;
  deviceId: string;
  /** Server-side workspace path (for syncDown to write files). */
  serverWorkspacePath?: string;
}

export class BridgeSandboxRunner implements SandboxRunner {
  readonly id = "reverse-mcp.bridge-shell";
  readonly kind: SandboxKind = "shell";

  private registry: BridgeRegistry;

  private _workspacePath: string;

  constructor(opts: BridgeSandboxRunnerOpts) {
    this.registry = opts.registry;
    this._workspacePath = opts.serverWorkspacePath ?? "/tmp/tianshu-bridge-workspace";
  }

  private getConn(userId?: string) {
    if (userId) {
      const conns = this.registry.forUser(userId);
      if (conns.length > 0) return conns[0];
    }
    const all = this.registry.all();
    return all[0] ?? null;
  }

  /** Wait for a bridge device to connect (up to timeoutMs). */
  private async waitForConn(userId?: string, timeoutMs = 30000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.getConn(userId)) {
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private async callBridgeTool(
    userId: string | undefined,
    name: string,
    args: Record<string, unknown>,
    callTimeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    // Exponential backoff retry for transient bridge failures
    // (connection drop, timeout, socket send error). Re-resolve
    // the connection on each attempt so a reconnected bridge is
    // picked up automatically.
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 1000; // 1s, 2s, 4s, 8s, 16s (capped at 30s)
    let lastErr: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let conn = this.getConn(userId);
      if (!conn) {
        // First attempt: wait up to 30s for bridge to connect.
        // Retries: wait remaining backoff time for reconnection.
        const waitMs = attempt === 0 ? 30000 : Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 30_000);
        log.info(`no bridge connected, waiting up to ${waitMs / 1000}s... (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);
        await this.waitForConn(userId, waitMs);
        conn = this.getConn(userId);
      }
      if (!conn) {
        lastErr = new Error("No bridge device connected");
        if (attempt < MAX_RETRIES) continue;
        throw new Error(
          "No bridge device connected after retries. Start the Tianshu Bridge desktop app and try again.",
        );
      }
      try {
        log.info(`calling bridge tool "${name}" on device "${conn.deviceId}" (attempt ${attempt + 1}/${MAX_RETRIES + 1})`, JSON.stringify(args).slice(0, 300));
        const result = await this.registry.call(conn, "tools/call", {
          name,
          arguments: args,
        }, callTimeoutMs);
        return (result ?? {}) as Record<string, unknown>;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        log.info(`call failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg}`);
        // Don't retry on user abort
        if (/aborted by user/i.test(msg)) throw err;
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), 30_000);
          log.info(`retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const t0 = Date.now();
    log.info(`exec:`, {
      command: req.command?.slice(0, 200),
      workdir: req.workdir,
      userId: req.userId,
      timeoutMs: req.timeoutMs,
    });
    try {
      // Adapt command for non-Linux (macOS bridge):
      // 1. Replace GNU `timeout -s KILL N` (not available on macOS) —
      //    bridge's own timeout_ms handles it.
      // 2. Replace /sandbox/workspace paths with the shell root.
      let command = req.command;
      const timeoutMatch = command.match(/timeout\s+(?:-s\s+\S+\s+)?(\d+)\s+/);
      let bridgeTimeoutMs = req.timeoutMs;
      if (timeoutMatch) {
        // Extract the timeout seconds and use bridge's timeout_ms instead.
        if (!bridgeTimeoutMs) {
          bridgeTimeoutMs = parseInt(timeoutMatch[1], 10) * 1000;
        }
        command = command.replace(/timeout\s+(?:-s\s+\S+\s+)?\d+\s+/, "");
      }
      // /sandbox/workspace is the Docker sandbox path — not relevant on bridge.
      command = command.replace(/\/sandbox\/workspace\//g, "");
      command = command.replace(/\/sandbox\/workspace/g, ".");
      // GNU find's -printf is not available on macOS (BSD find).
      if (command.includes("-printf")) {
        command = command.replace(/-printf\s+'[^']*'(\s*2>\/dev\/null)?/g, "$1 | sed 's|^\\./||'");
      }
      // zsh doesn't support bash's `read -r -d ''` (null-delimiter).
      // Replace -print0 with -print, and remove `-d ''` from read.
      command = command.replace(/-print0/g, "-print");
      command = command.replace(/read\s+-r\s+-d\s+''/g, "read -r");
      command = command.replace(/read\s+-r\s+-d\s+""/g, "read -r");

      log.info(`exec adapted command:`, command.slice(0, 300));
      // Pass timeout to both the bridge tool AND the registry call
      // so long-running commands (opencode) don't hit the 60s default.
      const callTimeout = bridgeTimeoutMs ? bridgeTimeoutMs + 30000 : undefined;
      const result = await this.callBridgeTool(req.userId, "exec", {
        command,
        workdir: req.workdir?.replace(/\/sandbox\/workspace\/?/, "") || undefined,
        ...(bridgeTimeoutMs ? { timeout_ms: bridgeTimeoutMs } : {}),
      }, callTimeout);
      const durationMs = Date.now() - t0;
      const content = Array.isArray(result.content) ? result.content : [];
      const rawText = content.map((c: { text?: string }) => c.text ?? "").join("\n");
      log.info(`exec raw response (first 500):`, rawText.slice(0, 500));
      try {
        const parsed = JSON.parse(rawText) as {
          ok?: boolean;
          exit_code?: number;
          stdout?: string;
          stderr?: string;
          duration_ms?: number;
          timed_out?: boolean;
        };
        const execResult: ExecResult = {
          stdout: parsed.stdout ?? "",
          stderr: parsed.stderr ?? "",
          exitCode: parsed.exit_code ?? 0,
          durationMs: parsed.duration_ms ?? durationMs,
          timedOut: parsed.timed_out ?? false,
        };
        log.info(`exec parsed:`, {
          exitCode: execResult.exitCode,
          stdoutLen: execResult.stdout.length,
          stderrPreview: execResult.stderr.slice(0, 200),
          timedOut: execResult.timedOut,
        });
        return execResult;
      } catch {
        log.info(`exec response not JSON, treating as stdout. len=${rawText.length}`);
        return { stdout: rawText, stderr: "", exitCode: 0, durationMs, timedOut: false };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`exec ERROR:`, msg);
      return {
        stdout: "",
        stderr: msg,
        exitCode: 1,
        durationMs: Date.now() - t0,
        timedOut: msg.includes("timed out"),
      };
    }
  }

  async readFile(relPath: string): Promise<string> {
    log.info(`readFile:`, relPath);
    try {
      const result = await this.callBridgeTool(undefined, "read_file", { path: relPath });
      const parsed = this.parseBridgeResult(result);
      if (!parsed.ok) {
        log.info(`readFile error:`, parsed.error);
        return "";
      }
      const b64 = String(parsed.base64 ?? "");
      return b64 ? Buffer.from(b64, "base64").toString("utf-8") : "";
    } catch (err) {
      log.error(`readFile ERROR:`, err instanceof Error ? err.message : String(err));
      return "";
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    log.info(`writeFile:`, relPath, `(${content.length} bytes)`);
    try {
      const b64 = Buffer.from(content).toString("base64");
      const result = await this.callBridgeTool(undefined, "write_file", {
        path: relPath,
        base64: b64,
      });
      const parsed = this.parseBridgeResult(result);
      if (!parsed.ok) {
        log.error(`writeFile failed:`, parsed.error);
      }
    } catch (err) {
      log.error(`writeFile ERROR:`, err instanceof Error ? err.message : String(err));
    }
  }

  workspacePath(): string {
    return this._workspacePath;
  }

  /** Parse bridge tool response JSON from content blocks. */
  private parseBridgeResult(result: Record<string, unknown>): Record<string, unknown> {
    const content = Array.isArray(result.content)
      ? (result.content as { text?: string }[]).map((c) => c.text ?? "").join("")
      : "";
    try {
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "unparseable response" };
    }
  }

  /**
   * Sync files from the bridge machine to the server workspace.
   * Uses read_file to pull each file's content, writes to server.
   */
  async syncDown(
    paths: string[] | Array<{ sandbox: string; host: string }>,
  ): Promise<{ downloaded: string[]; skipped: Array<{ relPath: string; reason: string }> }> {
    const pairs: Array<{ sandbox: string; host: string }> = Array.isArray(paths) && typeof paths[0] === "string"
      ? (paths as string[]).map((p) => ({ sandbox: p, host: p }))
      : (paths as Array<{ sandbox: string; host: string }>);
    const downloaded: string[] = [];
    const skipped: Array<{ relPath: string; reason: string }> = [];
    const fs = await import("node:fs");
    const path = await import("node:path");

    for (const { sandbox, host } of pairs) {
      try {
        const result = await this.callBridgeTool(undefined, "read_file", { path: sandbox });
        const parsed = this.parseBridgeResult(result);
        if (!parsed.ok) {
          skipped.push({ relPath: host, reason: String(parsed.error ?? "read_file failed") });
          continue;
        }
        const b64 = String(parsed.base64 ?? "");
        if (!b64) { skipped.push({ relPath: host, reason: "empty content" }); continue; }

        const wsPath = this.workspacePath();
        const fullPath = path.join(wsPath, host);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, Buffer.from(b64, "base64"));
        downloaded.push(host);
      } catch (err) {
        skipped.push({ relPath: host, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { downloaded, skipped };
  }

  /**
   * Sync files from the server workspace to the bridge machine.
   * Uses write_file to push each file's content to the bridge.
   */
  async syncUp(
    hostRelPaths: string[],
  ): Promise<{ uploaded: string[]; skipped: Array<{ relPath: string; reason: string }> }> {
    const uploaded: string[] = [];
    const skipped: Array<{ relPath: string; reason: string }> = [];
    const fs = await import("node:fs");
    const path = await import("node:path");

    const wsPath = this.workspacePath();
    for (const rel of hostRelPaths) {
      try {
        const fullPath = path.join(wsPath, rel);
        const buf = fs.readFileSync(fullPath);
        const result = await this.callBridgeTool(undefined, "write_file", {
          path: rel,
          base64: buf.toString("base64"),
        });
        const parsed = this.parseBridgeResult(result);
        if (!parsed.ok) {
          skipped.push({ relPath: rel, reason: String(parsed.error ?? "write_file failed") });
          continue;
        }
        uploaded.push(rel);
      } catch (err) {
        skipped.push({ relPath: rel, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return { uploaded, skipped };
  }

  async reset(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async status(): Promise<SandboxStatus> {
    const conns = this.registry.all();
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
