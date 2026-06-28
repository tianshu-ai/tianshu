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

function defaultUserWorkdir(
  userId: string,
  projectSlug?: string,
): string {
  // Anchor under the project when the run context has one
  // (workboard tasks, chat sessions bound to a project). Without
  // a project, fall back to the bare user-home dir — used by
  // ad-hoc / scratch tool invocations.
  const home = `${SANDBOX_WORKSPACE_PATH}/users/${userId}`;
  return projectSlug ? `${home}/projects/${projectSlug}` : home;
}

/**
 * Compute the sandbox-side prefix for tool inputs. The agent's
 * paths are interpreted relative to the project working dir
 * inside the sandbox; we anchor them under
 *   users/<userId>/projects/<projectSlug>/
 * to match the per-tenant + per-user + per-project tree the
 * runner sets up. `projectSlug` is optional for the chat-session
 * / scratch case where the tool falls back to bare user scope.
 *
 * scope='tenant' opts out entirely (paths land at the sandbox
 * workspace root); used for cross-user shared work, rare.
 */
function sandboxPathPrefix(
  scope: "user" | "tenant",
  userId: string,
  projectSlug?: string,
): string {
  if (scope === "tenant") return "";
  const prefix = `users/${userId}`;
  return projectSlug ? `${prefix}/projects/${projectSlug}` : prefix;
}

function prefixPaths(
  paths: string[],
  scope: "user" | "tenant",
  userId: string,
  projectSlug?: string,
): string[] {
  const prefix = sandboxPathPrefix(scope, userId, projectSlug);
  if (!prefix) return paths;
  return paths.map((p) => stripRedundantPrefixes(p, userId, projectSlug, prefix));
}

/**
 * Normalise the agent's path input before joining it onto the
 * sandbox-side scope prefix. Agents sometimes "helpfully" pass
 * already-rooted paths like 'projects/<project>/chart.png' or
 * 'users/<user>/projects/<project>/chart.png'; without this we
 * would double the prefix and end up looking at
 *   /sandbox/workspace/users/dev/projects/foo/projects/foo/chart.png
 * which doesn't exist (and even if it did, downloads stage under
 * 'projects/<project>/' on the host side too, producing the
 * triple-nested .results layout Yu reported in 2026-06-28).
 *
 * We accept and strip three redundant prefixes:
 *   - leading slash(es)
 *   - 'users/<userId>/' (full or trailing-slash)
 *   - 'projects/<projectSlug>/'
 * Stripping is idempotent and order-tolerant; the result is
 * always a project-relative path that the prefix join can
 * cleanly stack onto.
 */
function stripRedundantPrefixes(
  raw: string,
  userId: string,
  projectSlug: string | undefined,
  prefix: string,
): string {
  const clean = normaliseRelativeInput(raw, userId, projectSlug);
  if (clean === "" || clean === ".") return prefix;
  return `${prefix}/${clean}`;
}

/**
 * Reduce an agent-supplied path to a project-relative form by
 * peeling off redundant layout segments. Idempotent. Used by both
 * sandbox-side scope joining and host-side staging so the two
 * sides of a sync agree on the layout.
 *
 * Accepts and removes (in this order, each at most once):
 *   - leading slash(es)
 *   - 'users/<userId>/'
 *   - 'projects/<projectSlug>/'
 *
 * The order matters because agents typically pass either bare
 * filenames, project-relative ('src/main.py'), or user-rooted
 * ('users/dev/projects/foo/main.py') paths. Tenant-rooted paths
 * (starting with 'projects/') are also normalised by passing the
 * projectSlug second; if no projectSlug is in scope (e.g. scope
 * 'tenant') we leave 'projects/...' alone since it might be a
 * legitimate cross-project reference.
 */
function normaliseRelativeInput(
  raw: string,
  userId: string,
  projectSlug: string | undefined,
): string {
  let clean = raw.replace(/^\/+/, "");
  const userPrefix = `users/${userId}/`;
  if (clean.startsWith(userPrefix)) {
    clean = clean.slice(userPrefix.length);
  }
  if (projectSlug) {
    const projectPrefix = `projects/${projectSlug}/`;
    if (clean.startsWith(projectPrefix)) {
      clean = clean.slice(projectPrefix.length);
    }
  }
  return clean;
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
          : defaultUserWorkdir(ctx.userId, ctx.projectSlug);
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
    paths:
      | string[]
      | { sandbox: string; host: string }[],
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

Paths are resolved relative to your PROJECT working dir, both on host and
inside the sandbox:
  - host  : <userHomeDir>/projects/<project>/<path>
  - guest : /sandbox/workspace/users/<userId>/projects/<project>/<path>
The sandbox 'exec' tool's default cwd is the same project dir, so
sync_up({paths:['src/']}) followed by exec({command:'python3 src/hello.py'})
Just Works.

For ad-hoc chat sessions with no project, the anchor falls back to the user
home (sandbox: /sandbox/workspace/users/<userId>/<path>); use
scope='tenant' (rare) to anchor at the workspace root.

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
              "PROJECT-RELATIVE path. Pass just 'main.py' or 'src/main.py' or 'data/', NOT 'projects/<project>/main.py'. The tool joins your input with the in-scope project + user automatically. If you do happen to pass a rooted form like 'projects/<project>/file' or 'users/<userId>/projects/<project>/file' the tool will quietly strip those leading segments, but the canonical convention is the bare relative path.",
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
      // Sandbox paths anchor under users/<userId>/projects/<project>/
      // when a project is in scope (chat session attached to a
      // project, or workboard task). Plain user scope (no
      // project) falls back to users/<userId>/, matching the
      // sandbox tree the runner sets up. Tenant scope skips both.
      const scopedPaths = prefixPaths(
        inputPaths,
        scope,
        ctx.userId,
        ctx.projectSlug,
      );
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
result dir on the host.

Task + project scoped. Args:
  - paths   : sandbox paths to pull (relative to your user home). Required.
  - project : the project slug this task belongs to. Optional inside a
              workboard task — the host fills it from task.projectSlug.
              Required for ad-hoc / chat-session calls.
  - task    : stable, human-meaningful task folder name. Optional inside
              a workboard task — the host fills it from
              '<taskId>[-<slugified taskTitle>]'. Required for ad-hoc /
              chat-session calls.

Inside a workboard task you almost never need to pass project / task by
hand; just call sync_down({paths:['dist/','out.txt']}). The host's task
context fills the rest in. Explicit args override the defaults if you
need to stage results under a different project (rare) or use a custom
folder name (e.g. one task producing multiple result sets).

Fixed host layout (NOT agent-controlled):
  <userHomeDir>/projects/<project>/.results/<task>/<sandboxRelPath>

That path is INSIDE the user's project tree so tianshu's main
session sees task outputs alongside the project's own source
tree, can diff them against the project, and can promote any
useful files into the project proper or copy them to /tmp.

Sandbox-side paths are resolved relative to your USER HOME
(/sandbox/workspace/users/<userId>/<path>), matching sync_up's
scoping. So sync_up({paths:['src/']}) → exec that writes
./dist/output → sync_down({paths:['dist/'], project:'foo',
task:'42-build'}) lands the dist tree at
users/<userId>/projects/foo/.results/42-build/users/<userId>/dist/.

Directories are recursive. Re-running the same paths within the
same project+task overwrites the result copy in place.

Use 'scope: "tenant"' (rare) to read from the tenant root rather
than your user home; the host result-folder layout is unchanged.

After sync_down lands a non-trivial result set, narrate what you
staged in your next assistant message so tianshu's main session
knows the files are available.`,
      parameters: Type.Object({
        paths: Type.Array(
          Type.String({
            description:
              "PROJECT-RELATIVE path inside the sandbox. Pass 'dist/' or 'logs/build.log', NOT 'projects/<project>/dist/'. The tool joins with the in-scope user + project + .results/<task>/ automatically; passing a rooted form is silently normalised but the canonical convention is the bare relative path.",
          }),
          {
            minItems: 1,
            description: "Files and / or directories to download.",
          },
        ),
        project: Type.Optional(
          Type.String({
            description:
              "Project slug this task belongs to. Optional inside a workboard task — the host fills it from task.projectSlug. Required for ad-hoc / chat-session calls. Lowercase letters / digits / hyphens, dot, or underscore.",
            minLength: 1,
          }),
        ),
        task: Type.Optional(
          Type.String({
            description:
              "Task folder name. INSIDE A WORKBOARD TASK this is host-controlled — the tool ignores whatever you pass and uses <taskId>[-<slugified taskTitle>] so every sync_down in the same task lands in the same folder. ONLY pass this for ad-hoc / chat-session calls where ctx.taskId isn't set; in that case it becomes the folder name verbatim (and is required).",
            minLength: 1,
          }),
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
      const raw = (args as { paths?: unknown }).paths;
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: "paths must be a non-empty string array" };
      }
      // Resolve project + task. Explicit arg wins; otherwise use
      // ctx fields the host populates from the workboard task row.
      // taskTitle is user-supplied text, so we slugify it before
      // joining onto taskId.
      const argProject =
        typeof (args as { project?: unknown }).project === "string"
          ? (args as { project: string }).project.trim()
          : "";
      const project = argProject || (ctx.projectSlug ?? "").trim();
      // Task folder name is HOST-controlled when ctx.taskId is
      // present (workboard task, bound chat session). We ignore
      // any agent-supplied `task` arg in that case so multiple
      // sync_down calls inside the same task always land in the
      // same folder. Yu 2026-06-28: "在一个 task 里生成的文件都
      // 应该放在一个文件夹里" — agents otherwise improvise
      // different names per call ('probe-run-1' vs 'probe-run-
      // single-binary') and each one gets its own .results dir.
      const ctxTask = deriveTaskFolderFromCtx(ctx);
      const argTask =
        typeof (args as { task?: unknown }).task === "string"
          ? (args as { task: string }).task.trim()
          : "";
      const task = ctxTask || argTask;
      const taskWasOverridden =
        Boolean(ctxTask) && Boolean(argTask) && argTask !== ctxTask;
      const projectErr = validateSlug(project, "project");
      if (projectErr) {
        return {
          ok: false,
          error: `${projectErr}. Pass 'project' explicitly, or call from a workboard task so ctx.projectSlug is populated.`,
        };
      }
      const taskErr = validateSlug(task, "task");
      if (taskErr) {
        return {
          ok: false,
          error: `${taskErr}. Call from a workboard task so ctx.taskId is populated, or pass 'task' explicitly when running outside a task.`,
        };
      }
      const scope =
        (args as { scope?: unknown }).scope === "tenant" ? "tenant" : "user";
      const inputPaths = raw.map((p) => String(p));
      // Normalise inputs: agents sometimes pass already-rooted
      // paths like 'projects/<project>/chart.png' or
      // 'users/<user>/projects/<project>/chart.png'. We accept
      // those forms and strip the redundant prefix so the agent
      // doesn't have to know our internal layout. After this both
      // host and sandbox sides see the SAME project-relative path
      // (e.g. 'chart.png'), and the host destBaseDir +
      // sandbox-scope prefix do all the anchoring.
      const projectScoped =
        scope === "user" ? project : undefined;
      const normalisedInputs = inputPaths.map((p) =>
        normaliseRelativeInput(p, ctx.userId, projectScoped),
      );
      // Sandbox paths anchor at users/<userId>/projects/<project>/
      // because that's where the agent's cwd lives.
      const sandboxPaths = prefixPaths(
        normalisedInputs,
        scope,
        ctx.userId,
        project,
      );
      // Host destination is already anchored at
      // <userHomeDir>/projects/<project>/.results/<task>/, so the
      // host side uses the *normalised* input verbatim — no
      // additional user/project segments.
      const items = normalisedInputs.map((host, i) => ({
        sandbox: sandboxPaths[i]!,
        host,
      }));
      const destBaseDir = projectTaskResultsDir(ctx, project, task);
      try {
        const r = await sync.syncDown(items, { destBaseDir });
        const noticeLines = [
          `Staged ${r.downloaded.length} item(s) at ${destBaseDir}.`,
          `Mention this in your next message so tianshu can review them.`,
        ];
        if (taskWasOverridden) {
          // Inform the agent we ignored its task arg — saves it
          // wondering why subsequent calls keep landing in the
          // same folder.
          noticeLines.push(
            `(Note: ignored task='${argTask}' — host-supplied taskId '${task}' wins so every call in this task lands in the same folder.)`,
          );
        }
        return {
          ok: r.skipped.length === 0,
          scope,
          project,
          task,
          destBaseDir,
          downloaded: r.downloaded,
          skipped: r.skipped,
          taskOverridden: taskWasOverridden,
          /** Hint surfaced verbatim to the agent. The expected next
           *  step is to narrate what got staged so tianshu's main
           *  session sees the files in the task transcript and can
           *  decide whether to promote any of them into the project
           *  proper. */
          notice: noticeLines.join(" "),
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
 * Compute the host-side result directory for sync_down. Always
 *   <userHomeDir>/projects/<project>/.results/<task>/
 * so tianshu's main session can browse task outputs next to the
 * project's source tree. Caller is responsible for validating
 * `project` and `task` are non-empty slugs (validateSlug() above).
 */
function projectTaskResultsDir(
  ctx: AgentToolContext,
  project: string,
  task: string,
): string {
  return path.join(
    ctx.userHomeDir,
    "projects",
    project,
    ".results",
    task,
  );
}

/**
 * Reject empty / traversal / path-separator inputs for the
 * `project` and `task` parameters. We only accept alphanumeric +
 * dot + underscore + hyphen so an agent can't escape the result
 * tree by passing `../../etc/passwd`. Length capped at 64.
 */
/**
 * Derive a deterministic task-folder name from ctx alone, used
 * when the agent didn't pass an explicit `task` arg. Workboard
 * tasks always have ctx.taskId; if taskTitle is also set we
 * suffix the id with a slugified title so the folder name is
 * recognisable on disk (e.g. "42-add-login-flow"). When the
 * title slug would collapse to empty (all-symbols title), fall
 * back to the bare id.
 */
function deriveTaskFolderFromCtx(ctx: AgentToolContext): string {
  const id = (ctx.taskId ?? "").trim();
  if (!id) return "";
  const title = (ctx.taskTitle ?? "").trim();
  if (!title) return id;
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug ? `${id}-${slug}` : id;
}

function validateSlug(value: string, label: string): string | null {
  if (!value) {
    return `${label} must be a non-empty string`;
  }
  if (value.length > 64) {
    return `${label} must be ≤ 64 chars`;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    return `${label} must match [A-Za-z0-9._-]+ (no slashes, no spaces)`;
  }
  if (value === "." || value === ".." || value.startsWith("-")) {
    return `${label} cannot be '${value}'`;
  }
  return null;
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
