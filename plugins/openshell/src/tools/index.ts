// Agent tools the openshell plugin contributes.
//
// Three tools, MVP scope:
//   exec                — run a shell command in the sandbox.
//   reset_sandbox       — wipe and re-create the sandbox container.
//   get_sandbox_status  — read state / uptime / last error.
//
// Designed to drop in as a substitute for the microsandbox-named
// tools of the same name. The host registers them under the same
// `exec` / `reset_sandbox` / `get_sandbox_status` schema names, so
// agents written against microsandbox just work when the sandbox
// backend switches.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
  SandboxRunner,
} from "@tianshu-ai/plugin-sdk";

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60_000;
const STDOUT_LINE_CAP = 200;
const STDOUT_BYTE_CAP = 8_000;

function defaultUserWorkdir(userId: string): string {
  return `/workspace/users/${userId}`;
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_EXEC_TIMEOUT_MS);
}

function truncate(text: string): { value: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length > STDOUT_LINE_CAP) {
    const head = lines.slice(0, STDOUT_LINE_CAP).join("\n");
    return {
      value: `${head}\n... (${lines.length - STDOUT_LINE_CAP} more lines truncated)`,
      truncated: true,
    };
  }
  if (text.length > STDOUT_BYTE_CAP) {
    return {
      value: `${text.slice(0, STDOUT_BYTE_CAP)}\n... (${text.length - STDOUT_BYTE_CAP} more bytes truncated)`,
      truncated: true,
    };
  }
  return { value: text, truncated: false };
}

// ─── ExecTool ─────────────────────────────────────────────────────

export function ExecTool(runner: SandboxRunner): AgentTool {
  return {
    schema: {
      name: "exec",
      description: `Run a shell command inside the per-tenant OpenShell sandbox (Docker container).
The sandbox is brought up on plugin activate, so calls are warm by the time \
the agent runs.

Default timeout: ${DEFAULT_EXEC_TIMEOUT_MS / 1000}s. Raise \`timeout_ms\` for long-running tasks; cap is ${MAX_EXEC_TIMEOUT_MS / 1000}s.

Outputs are truncated at ${STDOUT_LINE_CAP} lines / ${STDOUT_BYTE_CAP} bytes per stream. Pipe to a \
file (\`> out.log\`) and \`read_file\` if you need the full output.

Default working dir is the active user's home (\`/workspace/users/<userId>\`). \
Pass an absolute \`workdir\` to step outside.`,
      parameters: Type.Object({
        command: Type.String({
          description:
            "Shell command. Equivalent to `bash -c <command>` inside the sandbox.",
        }),
        workdir: Type.Optional(
          Type.String({
            description:
              "Working dir inside the guest. Defaults to /workspace/users/<userId>.",
          }),
        ),
        timeout_ms: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: MAX_EXEC_TIMEOUT_MS,
            description: `Override per-call timeout. Hard cap ${MAX_EXEC_TIMEOUT_MS}ms.`,
          }),
        ),
      }),
    },

    async available() {
      try {
        const status = await runner.status();
        return status.state !== "error";
      } catch {
        return false;
      }
    },

    async execute(args, ctx: AgentToolContext) {
      const command = String((args as { command?: unknown }).command ?? "");
      if (!command) {
        return {
          ok: false,
          exit_code: -1,
          stdout: "",
          stderr: "command is required",
          truncated: false,
          duration_ms: 0,
          timed_out: false,
        };
      }
      const workdir =
        typeof (args as { workdir?: unknown }).workdir === "string"
          ? (args as { workdir: string }).workdir
          : defaultUserWorkdir(ctx.userId);
      const timeoutMs = clampTimeout(
        (args as { timeout_ms?: unknown }).timeout_ms,
      );
      // Outer watchdog mirrors microsandbox: belt-and-braces guard
      // against the runner promise itself hanging (CLI process never
      // returns, gateway socket dead, etc.). The runner's own
      // timeout is the primary path; this gives it +5s slack and
      // then fails the tool call so the agent can move on.
      const watchdogMs = timeoutMs + 5_000;
      const execP = runner.exec({
        command,
        workdir,
        timeoutMs,
        userId: ctx.userId,
        taskId: ctx.taskId,
        sessionId: ctx.sessionId,
        signal: ctx.signal,
      });
      const WATCHDOG = Symbol("exec-watchdog");
      const watchdogP = new Promise<typeof WATCHDOG>((resolve) =>
        setTimeout(() => resolve(WATCHDOG), watchdogMs),
      );
      const winner = await Promise.race([execP, watchdogP]);
      if (winner === WATCHDOG) {
        return {
          ok: false,
          exit_code: -1,
          stdout: "",
          stderr:
            `[openshell] exec watchdog fired after ${watchdogMs}ms — ` +
            `the gateway CLI did not return. If this repeats, try ` +
            `\`reset_sandbox\`.`,
          truncated: false,
          duration_ms: watchdogMs,
          timed_out: true,
        };
      }
      const result = winner;
      const so = truncate(result.stdout);
      const se = truncate(result.stderr);
      return {
        ok: result.exitCode === 0,
        exit_code: result.exitCode,
        stdout: so.value,
        stderr: se.value,
        truncated: so.truncated || se.truncated,
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
        aborted: result.aborted,
      };
    },
  };
}

// ─── ResetSandboxTool ─────────────────────────────────────────────

export function ResetSandboxTool(runner: SandboxRunner): AgentTool {
  return {
    schema: {
      name: "reset_sandbox",
      description:
        "Tear down and re-create the sandbox container. Workspace files (under /workspace) persist; everything else (installs, /tmp, …) is wiped. Use when the sandbox feels stuck or after upgrading the base image.",
      parameters: Type.Object({}),
    },

    async execute() {
      try {
        await runner.reset();
        return { ok: true, message: "sandbox reset complete" };
      } catch (err) {
        return {
          ok: false,
          message: `reset failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

// ─── GetSandboxStatusTool ─────────────────────────────────────────

export function GetSandboxStatusTool(runner: SandboxRunner): AgentTool {
  return {
    schema: {
      name: "get_sandbox_status",
      description:
        "Return the current state of the OpenShell sandbox (starting / ready / running / error / stopped) plus uptime and last error.",
      parameters: Type.Object({}),
    },

    async execute() {
      const status = await runner.status();
      return {
        ok: true,
        state: status.state,
        uptime_ms: status.uptimeMs,
        last_error: status.lastError ?? null,
        meta: status.meta ?? {},
      };
    },
  };
}
