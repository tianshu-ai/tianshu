// BridgeSandboxRunner — implements SandboxRunner by forwarding exec/file
// operations to a connected local-bridge device.

import type {
  ExecRequest,
  ExecResult,
  RunOpencodeOpts,
  SandboxRunner,
  SandboxKind,
  SandboxStatus,
} from "@tianshu-ai/plugin-sdk";
import type { BridgeRegistry } from "./registry.js";

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
    let conn = this.getConn(userId);
    if (!conn) {
      console.log(`[BridgeSandboxRunner] no bridge connected, waiting up to 30s...`);
      await this.waitForConn(userId, 30000);
      conn = this.getConn(userId);
    }
    if (!conn) {
      throw new Error(
        "No bridge device connected after 30s wait. Start the Tianshu Bridge desktop app and try again.",
      );
    }
    console.log(`[BridgeSandboxRunner] calling bridge tool "${name}" on device "${conn.deviceId}"`, JSON.stringify(args).slice(0, 300));
    const result = await this.registry.call(conn, "tools/call", {
      name,
      arguments: args,
    }, callTimeoutMs);
    return (result ?? {}) as Record<string, unknown>;
  }

  async exec(req: ExecRequest): Promise<ExecResult> {
    const t0 = Date.now();
    console.log(`[BridgeSandboxRunner] exec:`, {
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
      // Replace -printf '%P\n' with portable: | sed 's|^\./||'
      command = command.replace(/-printf\s+'%P\\n'/g, "| sed 's|^\\./||'");

      console.log(`[BridgeSandboxRunner] exec adapted command:`, command.slice(0, 300));
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
      console.log(`[BridgeSandboxRunner] exec raw response (first 500):`, rawText.slice(0, 500));
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
        console.log(`[BridgeSandboxRunner] exec parsed:`, {
          exitCode: execResult.exitCode,
          stdoutLen: execResult.stdout.length,
          stderrPreview: execResult.stderr.slice(0, 200),
          timedOut: execResult.timedOut,
        });
        return execResult;
      } catch {
        console.log(`[BridgeSandboxRunner] exec response not JSON, treating as stdout. len=${rawText.length}`);
        return { stdout: rawText, stderr: "", exitCode: 0, durationMs, timedOut: false };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[BridgeSandboxRunner] exec ERROR:`, msg);
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
    console.log(`[BridgeSandboxRunner] readFile:`, relPath);
    try {
      const result = await this.callBridgeTool(undefined, "exec", {
        command: `cat ${JSON.stringify(relPath)}`,
      });
      const content = Array.isArray(result.content) ? result.content : [];
      const rawText = content.map((c: { text?: string }) => c.text ?? "").join("\n");
      try {
        const parsed = JSON.parse(rawText) as { stdout?: string; stderr?: string; ok?: boolean };
        if (!parsed.ok) console.log(`[BridgeSandboxRunner] readFile error:`, parsed.stderr?.slice(0, 200));
        return parsed.stdout ?? "";
      } catch {
        return rawText;
      }
    } catch (err) {
      console.error(`[BridgeSandboxRunner] readFile ERROR:`, err instanceof Error ? err.message : String(err));
      return "";
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    console.log(`[BridgeSandboxRunner] writeFile:`, relPath, `(${content.length} bytes)`);
    // Use base64 to avoid shell escaping issues.
    const b64 = Buffer.from(content).toString("base64");
    try {
      const result = await this.callBridgeTool(undefined, "exec", {
        command: `mkdir -p "$(dirname ${JSON.stringify(relPath)})" && echo '${b64}' | base64 -d > ${JSON.stringify(relPath)}`,
      });
      const raw = Array.isArray(result.content) ? (result.content as {text?: string}[]).map(c => c.text ?? "").join("") : "";
      try {
        const p = JSON.parse(raw) as { ok?: boolean; stderr?: string };
        if (!p.ok) console.error(`[BridgeSandboxRunner] writeFile failed:`, p.stderr?.slice(0, 200));
        else console.log(`[BridgeSandboxRunner] writeFile OK`);
      } catch { /* ok */ }
    } catch (err) {
      console.error(`[BridgeSandboxRunner] writeFile ERROR:`, err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Run opencode using the user's LOCAL config (no tianshu proxy).
   * The bridge machine already has opencode installed + configured
   * with the user's own API keys.
   */
  async runOpencode(opts: RunOpencodeOpts): Promise<ExecResult> {
    const { workdir, prompt, resume, timeoutMs, userId } = opts;
    console.log(`[BridgeSandboxRunner] runOpencode:`, { workdir, promptLen: prompt.length, resume });

    // 1. Create workdir + write prompt
    await this.exec({ command: `mkdir -p ${JSON.stringify(workdir)}`, userId });
    // Write prompt via base64
    const b64 = Buffer.from(prompt).toString("base64");
    await this.exec({
      command: `echo '${b64}' | base64 -d > ${JSON.stringify(workdir + "/.prompt.txt")}`,
      userId,
    });

    // 2. Run opencode with user's own config (no OPENCODE_CONFIG override)
    const cmd =
      `cd ${JSON.stringify(workdir)} && ` +
      `opencode run --auto --format json ` +
      (resume ? `--continue ` : ``) +
      `< .prompt.txt > oc.out 2> oc.err ; ` +
      `rc=$? ; cat oc.out ; exit $rc`;

    console.log(`[BridgeSandboxRunner] runOpencode cmd:`, cmd.slice(0, 200));
    return this.exec({
      command: cmd,
      userId,
      timeoutMs: timeoutMs ?? 1200000,
    });
  }

  workspacePath(): string {
    return this._workspacePath;
  }

  /**
   * Sync files from the bridge machine to the server workspace.
   * Reads each file via bridge exec (cat | base64), decodes, writes locally.
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
        // Read file from bridge as base64.
        const result = await this.callBridgeTool(undefined, "exec", {
          command: `base64 < ${JSON.stringify(sandbox)}`,
        });
        const content = Array.isArray(result.content)
          ? (result.content as { text?: string }[]).map((c) => c.text ?? "").join("")
          : "";
        let b64: string;
        try {
          const parsed = JSON.parse(content) as { stdout?: string; ok?: boolean };
          if (!parsed.ok) { skipped.push({ relPath: host, reason: "exec failed" }); continue; }
          b64 = parsed.stdout ?? "";
        } catch {
          b64 = content;
        }
        // Remove whitespace from base64.
        b64 = b64.replace(/\s/g, "");
        if (!b64) { skipped.push({ relPath: host, reason: "empty content" }); continue; }

        // Write to server workspace.
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
