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

// Default working dir inside the OpenShell sandbox.
//
// Microsandbox bind-mounts the host tenant tree at /workspace and
// gives each user a home at /workspace/users/<userId>. OpenShell
// has no bind mount (Landlock fights the fakeowner wrapper) — the
// sandbox keeps its own filesystem rooted at /sandbox. Per-user
// home dirs live under /sandbox/workspace/users/<userId> instead.
//
// The agent doesn't see this difference: it asks for files by
// relative path through sync_up / sync_down (or sync_workspace_up
// / sync_workspace_down), and the runner deposits / collects them
// under /sandbox/workspace/. So the user-home shape matches
// microsandbox's conventions; only the root path differs.
const SANDBOX_WORKSPACE_PATH = "/sandbox/workspace";

function defaultUserWorkdir(userId: string): string {
  return `${SANDBOX_WORKSPACE_PATH}/users/${userId}`;
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

Default working dir is the active user's home (\`/sandbox/workspace/users/<userId>\`). \
The sandbox does NOT bind-mount the host workspace; use \`sync_up\` / \`sync_down\` to \
move files between host and sandbox before / after running commands. \
Pass an absolute \`workdir\` to step outside the user's home dir.`,
      parameters: Type.Object({
        command: Type.String({
          description:
            "Shell command. Equivalent to `bash -c <command>` inside the sandbox.",
        }),
        workdir: Type.Optional(
          Type.String({
            description:
              "Working dir inside the guest. Defaults to /sandbox/workspace/users/<userId>. Use absolute sandbox paths (e.g. /sandbox/workspace/foo).",
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

// ─── SyncUpTool / SyncDownTool ───────────────────────────

interface SyncCapableRunner extends SandboxRunner {
  syncUp(
    hostRelPaths: string[],
  ): Promise<{ uploaded: string[]; skipped: { relPath: string; reason: string }[] }>;
  syncDown(
    sandboxRelPaths: string[],
  ): Promise<{ downloaded: string[]; skipped: { relPath: string; reason: string }[] }>;
}

/** Duck-type the runner so the tool factories stay generic over
 *  the SDK contract but bail out cleanly if some future runner
 *  doesn't implement OpenShell-specific sync. */
function asSyncCapable(runner: SandboxRunner): SyncCapableRunner | null {
  const r = runner as Partial<SyncCapableRunner>;
  if (typeof r.syncUp === "function" && typeof r.syncDown === "function") {
    return runner as SyncCapableRunner;
  }
  return null;
}

export function SyncUpTool(runner: SandboxRunner): AgentTool {
  return {
    schema: {
      name: "sync_up",
      description: `Upload host workspace files / directories into the OpenShell sandbox.
The OpenShell sandbox does NOT bind-mount the host workspace; use this tool to make \
host files visible to shell commands. Inputs are paths relative to the tenant \
workspace; each is uploaded to /sandbox/workspace/<rel>. Directories are uploaded \
recursively. Idempotent: re-uploading overwrites the sandbox-side copy.

Call this BEFORE \`exec\` when the command depends on workspace files. Don't read \
file content with \`read_file\` and paste it into the command; let the file move \
as a unit — it's faster and avoids size limits.

After the command finishes, use \`sync_down\` to pull any outputs back into the \
host workspace (only if you want the host to keep them; transient build artefacts \
can be ignored).`,
      parameters: Type.Object({
        paths: Type.Array(
          Type.String({
            description:
              "Path relative to the tenant workspace dir (e.g. 'src/main.py' or 'data/').",
          }),
          {
            minItems: 1,
            description: "Files and / or directories to upload.",
          },
        ),
      }),
    },

    async execute(args) {
      const sync = asSyncCapable(runner);
      if (!sync) {
        return {
          ok: false,
          error: "runner does not support sync_up (not an OpenShellRunner)",
        };
      }
      const raw = (args as { paths?: unknown }).paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: "paths must be a non-empty string array" };
      }
      const paths = raw.map((p) => String(p));
      try {
        const r = await sync.syncUp(paths);
        return {
          ok: r.skipped.length === 0,
          uploaded: r.uploaded,
          skipped: r.skipped,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function SyncDownTool(runner: SandboxRunner): AgentTool {
  return {
    schema: {
      name: "sync_down",
      description: `Download files / directories from /sandbox/workspace/ back to the host \
tenant workspace. Inputs are paths relative to /sandbox/workspace/, output lands \
at <hostWorkspaceDir>/<rel>. Directories are recursive. Idempotent: re-downloading \
overwrites the host-side copy.

Use this AFTER an exec produces files you want to keep on the host (build outputs, \
logs, generated reports). For transient artefacts (intermediate builds, npm cache), \
skip this — the sandbox keeps them and the next exec sees them anyway, but the host \
workspace stays clean.`,
      parameters: Type.Object({
        paths: Type.Array(
          Type.String({
            description:
              "Path inside /sandbox/workspace/, given as a relative path (e.g. 'dist/' or 'logs/build.log').",
          }),
          {
            minItems: 1,
            description: "Files and / or directories to download.",
          },
        ),
      }),
    },

    async execute(args) {
      const sync = asSyncCapable(runner);
      if (!sync) {
        return {
          ok: false,
          error: "runner does not support sync_down (not an OpenShellRunner)",
        };
      }
      const raw = (args as { paths?: unknown }).paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: "paths must be a non-empty string array" };
      }
      const paths = raw.map((p) => String(p));
      try {
        const r = await sync.syncDown(paths);
        return {
          ok: r.skipped.length === 0,
          downloaded: r.downloaded,
          skipped: r.skipped,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ─── GetSandboxStatusTool ─────────────────────────────────

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
