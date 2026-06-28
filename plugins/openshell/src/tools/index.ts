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

import path from "node:path";
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
// home dirs live under /sandbox/workspace/users/<userId>.
//
// sync_up / sync_down also operate inside the per-user home by
// default: the agent's `paths` are interpreted as relative to
// /sandbox/workspace/users/<userId>/ on the sandbox side AND to
// <hostWorkspaceDir>/users/<userId>/ on the host side. That keeps
// concurrent agents in the same tenant from clobbering each
// other's files (different userIds → different subtrees) without
// the agent having to manage prefixes by hand. An optional
// `scope: 'tenant'` arg drops the user prefix for the rare case
// where two agents intentionally share files.
const SANDBOX_WORKSPACE_PATH = "/sandbox/workspace";

function defaultUserWorkdir(userId: string): string {
  return `${SANDBOX_WORKSPACE_PATH}/users/${userId}`;
}

function userScopePrefix(userId: string): string {
  return `users/${userId}`;
}

function prefixPaths(
  paths: string[],
  scope: "user" | "tenant",
  userId: string,
): string[] {
  if (scope === "tenant") return paths;
  const prefix = userScopePrefix(userId);
  return paths.map((p) => {
    // Strip any leading slash and join with the user-scope prefix.
    // We don't try to detect "already prefixed" cases (e.g. the
    // agent passes 'users/alice/foo') — just always prepend so the
    // resolution is deterministic.
    const clean = p.replace(/^\/+/, "");
    return clean === "" || clean === "." ? prefix : `${prefix}/${clean}`;
  });
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
    opts?: { destBaseDir?: string },
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
host files visible to shell commands.

Paths are resolved relative to your USER HOME, both on host and inside the sandbox:
  - host  : <tenantWorkspace>/users/<userId>/<path>
  - guest : /sandbox/workspace/users/<userId>/<path>
The sandbox 'exec' tool's default cwd is the same user home, so an agent that runs
\`sync_up({paths:['src/']})\` followed by \`exec({command:'python3 src/hello.py'})\` Just
Works.

Directories are uploaded recursively. Idempotent: re-uploading overwrites the
sandbox-side copy.

Use this BEFORE 'exec' when the command depends on workspace files. Don't read file
content and paste it into the command; let the file move as a unit — it's faster
and avoids size limits.

Use 'scope: "tenant"' (rare) to share files across users in the same tenant; paths
then resolve to <tenantWorkspace>/<path> on host and /sandbox/workspace/<path> on
guest, with no user-id prefix.`,
      parameters: Type.Object({
        paths: Type.Array(
          Type.String({
            description:
              "Path relative to your user home (e.g. 'src/main.py' or 'data/').",
          }),
          {
            minItems: 1,
            description: "Files and / or directories to upload.",
          },
        ),
        scope: Type.Optional(
          Type.Union(
            [Type.Literal("user"), Type.Literal("tenant")],
            {
              description:
                "Where to anchor the paths. 'user' (default) scopes to /sandbox/workspace/users/<userId>/. 'tenant' targets the tenant root /sandbox/workspace/. Use 'tenant' only when intentionally sharing files between agents in the same tenant.",
            },
          ),
        ),
      }),
    },

    async execute(args, ctx: AgentToolContext) {
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
      const scope =
        (args as { scope?: unknown }).scope === "tenant" ? "tenant" : "user";
      const inputPaths = raw.map((p) => String(p));
      const scopedPaths = prefixPaths(inputPaths, scope, ctx.userId);
      try {
        const r = await sync.syncUp(scopedPaths);
        return {
          ok: r.skipped.length === 0,
          scope,
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
      description: `Pull files / directories from the OpenShell sandbox into this task's
result staging dir on the host.

This tool is task-scoped: it ONLY works inside a workboard task run (ctx.taskId
must be set by the host). Use it as the last step before task_complete to
deposit anything you want tianshu to surface to the user (logs, build outputs,
generated reports). Calling it from a chat session that isn't bound to a task
returns an error — by design, so we don't accidentally clobber files outside a
specific task's result tree.

Host path layout (NOT agent-controlled):
  <userHomeDir>/task-results/<taskId>/<sandboxRelPath>

The staging dir is a sibling of the tenant workspace tree, NOT inside the
workspace. Tianshu (or the user) is responsible for deciding which files to
promote into a project dir or /tmp; the agent should not assume these files
are durable beyond the task run.

Sandbox-side paths are resolved relative to your USER HOME
(/sandbox/workspace/users/<userId>/<path>), matching sync_up's scoping. So an
agent that ran sync_up({paths:['src/']}) and an exec that wrote ./dist/output,
can run sync_down({paths:['dist/']}) and the host gets the files at
<userHomeDir>/task-results/<taskId>/users/<userId>/dist/.

Directories are recursive. Re-running the same paths overwrites the staging
copy in place (idempotent within one task).

Use 'scope: "tenant"' (rare) to read from the tenant root rather than your
user home; the host staging layout is unchanged.

After sync_down lands a non-trivial result set, narrate what you staged in
your next assistant message so the user / tianshu's main session knows the
files are available and can decide what to do with them.`,
      parameters: Type.Object({
        paths: Type.Array(
          Type.String({
            description:
              "Path relative to your user home in the sandbox (e.g. 'dist/' or 'logs/build.log').",
          }),
          {
            minItems: 1,
            description: "Files and / or directories to download.",
          },
        ),
        scope: Type.Optional(
          Type.Union(
            [Type.Literal("user"), Type.Literal("tenant")],
            {
              description:
                "Where to anchor the SANDBOX paths. 'user' (default) scopes to /sandbox/workspace/users/<userId>/. 'tenant' reads from the tenant root.",
            },
          ),
        ),
      }),
    },

    async execute(args, ctx: AgentToolContext) {
      const sync = asSyncCapable(runner);
      if (!sync) {
        return {
          ok: false,
          error: "runner does not support sync_down (not an OpenShellRunner)",
        };
      }
      const taskId = typeof ctx.taskId === "string" ? ctx.taskId.trim() : "";
      if (!taskId) {
        // Refuse outside a task context. Host wires ctx.taskId from
        // the agent loop for workboard worker runs; chat sessions
        // bound to a task via TaskSandboxPool.bindSession also get
        // it via the sandbox-pool fallback. If neither path set it,
        // we don't have a stable place to put the files — fail
        // loudly so the agent doesn't think it succeeded.
        return {
          ok: false,
          error:
            "sync_down is task-scoped: ctx.taskId is required. Call this from a workboard task or a chat session bound to a task. To inspect files outside a task, exec `cat` / `ls` directly.",
        };
      }
      const raw = (args as { paths?: unknown }).paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: "paths must be a non-empty string array" };
      }
      const scope =
        (args as { scope?: unknown }).scope === "tenant" ? "tenant" : "user";
      const inputPaths = raw.map((p) => String(p));
      const scopedPaths = prefixPaths(inputPaths, scope, ctx.userId);
      const destBaseDir = taskResultsDirFor(ctx, taskId);
      try {
        const r = await sync.syncDown(scopedPaths, { destBaseDir });
        return {
          ok: r.skipped.length === 0,
          scope,
          taskId,
          destBaseDir,
          downloaded: r.downloaded,
          skipped: r.skipped,
          /** Hint surfaced verbatim to the agent. The expected next
           *  step is to narrate what got staged so tianshu's main
           *  session sees the files in the task transcript and can
           *  decide whether to copy any of them into a project /tmp
           *  dir before they get swept by a future task run. */
          notice:
            `Staged ${r.downloaded.length} item(s) at ${destBaseDir}. Mention this in your next message so tianshu can review them.`,
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

/**
 * Compute the host-side staging directory for sync_down. Always
 * <userHomeDir>/task-results/<taskId>/ — a sibling of the tenant
 * workspace tree, never inside it. Tianshu's host layer decides
 * whether to promote anything from staging into a permanent home
 * after the task transcript surfaces the files.
 *
 * Caller is responsible for verifying taskId is non-empty; this
 * helper just composes the path.
 */
function taskResultsDirFor(ctx: AgentToolContext, taskId: string): string {
  return path.join(ctx.userHomeDir, "task-results", taskId);
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
