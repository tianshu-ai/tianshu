// Agent tools the microsandbox plugin contributes.
//
// Each tool is a self-contained `AgentTool` (schema + execute +
// optional available()). The plugin's server.ts wires them into
// `exports.tools` keyed by manifest's `contributes.tools[].module`.
//
// `available()` only matters for `exec`: ADR-0004 §10 says we
// should NOT advertise exec to the model when the runner is in
// `state: error` (e.g. nullable runner). The other three tools
// (reset_sandbox / get_sandbox_status / update_sandbox_config)
// stay visible because they're exactly how the agent recovers.

import { Type } from "typebox";
import type {
  AgentTool,
  AgentToolContext,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu/plugin-sdk";
export {
  BuildSandboxTool,
  ListSandboxBuildsTool,
  UseSandboxBuildTool,
} from "./build.js";
export { makeBrowserToolset } from "./browser.js";

const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_EXEC_TIMEOUT_MS = 30 * 60_000;
const STDOUT_LINE_CAP = 200;
const STDOUT_BYTE_CAP = 8_000;

function getRunner(ctx: AgentToolContext): SandboxRunner | undefined {
  return ctx.capabilities.get<SandboxRunner>("sandbox.shell");
}

// ─── exec ──────────────────────────────────────────────────────────

// Path inside the sandbox guest where the active user's host home
// is bind-mounted to. Mirrors the ./users/<userId>/ layout that the
// host workspace uses (per ADR-0001 §2) so a relative path means
// the same file on both sides.
function defaultUserWorkdir(userId: string): string {
  return `/workspace/users/${userId}`;
}

export const ExecTool: AgentTool = {
  schema: {
    name: "exec",
    description: `Run a shell command inside the per-tenant sandbox. The sandbox boots \
on first call (cold start ~10s), so subsequent calls in the same conversation are fast.

Default timeout: ${DEFAULT_EXEC_TIMEOUT_MS / 1000}s. Raise \`timeout_ms\` for long-running tasks; cap is ${MAX_EXEC_TIMEOUT_MS / 1000}s.

Outputs are truncated at ${STDOUT_LINE_CAP} lines / ${STDOUT_BYTE_CAP} bytes per stream. \
Pipe to a file (\`> out.log\`) if you need the full output, then read it with \
\`read_file\`.

Default working dir is your user's home inside the sandbox — the same dir \
\`write_file\`/\`read_file\` operate on. So \`write_file("/foo.py")\` followed by \
\`exec("python3 foo.py")\` Just Works. Pass an absolute path in \`workdir\` to step outside (e.g. \
to poke at \`/etc\` or \`/usr\`).

Files written under your user dir persist on the host; everything else (installs, /tmp, …) \
is wiped when you call \`reset_sandbox\`.`,
    parameters: Type.Object({
      command: Type.String({
        description:
          "Shell command. Equivalent to `bash -c <command>` inside the sandbox. Multi-line scripts are fine.",
      }),
      workdir: Type.Optional(
        Type.String({
          description:
            "Working dir inside the guest. Defaults to the user's home (= the same dir read_file/write_file see). Pass an absolute path to override.",
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

  // Hide `exec` from the model when the runner is in error (nullable
  // runner, failed VM start). Recovery tools stay visible — the
  // agent uses them to fix things.
  async available(ctx: AgentToolContext) {
    const runner = getRunner(ctx);
    if (!runner) return false;
    try {
      const status = await runner.status();
      return status.state !== "error";
    } catch {
      return false;
    }
  },

  async execute(args, ctx) {
    const runner = getRunner(ctx);
    if (!runner) {
      return errorResult("sandbox.shell capability not registered");
    }
    const command = String((args as { command?: unknown }).command ?? "");
    if (!command) return errorResult("command is required");
    const workdir =
      typeof (args as { workdir?: unknown }).workdir === "string"
        ? ((args as { workdir: string }).workdir as string)
        : defaultUserWorkdir(ctx.userId);
    const timeoutMs = clampTimeout((args as { timeout_ms?: unknown }).timeout_ms);
    try {
      const result = await runner.exec({ command, workdir, timeoutMs });
      const stdout = truncate(result.stdout);
      const stderr = truncate(result.stderr);
      return {
        ok: result.exitCode === 0 && !result.timedOut,
        exit_code: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        duration_ms: result.durationMs,
        timed_out: result.timedOut,
      };
    } catch (err) {
      return errorResult(
        `exec failed before reaching the sandbox: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};

function errorResult(message: string) {
  return {
    ok: false,
    exit_code: -1,
    stdout: "",
    stderr: message,
    truncated: false,
    duration_ms: 0,
    timed_out: false,
  };
}

function clampTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_EXEC_TIMEOUT_MS;
  }
  return Math.min(raw, MAX_EXEC_TIMEOUT_MS);
}

interface Truncated {
  text: string;
  truncated: boolean;
}

function truncate(s: string): Truncated {
  if (s.length === 0) return { text: s, truncated: false };
  let truncated = false;
  let out = s;
  if (Buffer.byteLength(out, "utf8") > STDOUT_BYTE_CAP) {
    const buf = Buffer.from(out, "utf8");
    out = buf.subarray(0, STDOUT_BYTE_CAP).toString("utf8");
    truncated = true;
  }
  const lines = out.split("\n");
  if (lines.length > STDOUT_LINE_CAP) {
    out = lines.slice(0, STDOUT_LINE_CAP).join("\n");
    truncated = true;
  }
  if (truncated) {
    out += `\n[output truncated at ${STDOUT_LINE_CAP} lines / ${STDOUT_BYTE_CAP} bytes]`;
  }
  return { text: out, truncated };
}

// ─── reset_sandbox ─────────────────────────────────────────────────

export const ResetSandboxTool: AgentTool = {
  schema: {
    name: "reset_sandbox",
    description: `Tear down the sandbox VM and re-create it from scratch. Use this when \
\`exec\` keeps failing due to a stuck process, corrupted state, OOM, or runaway services. \
Files under /workspace survive (they live on the host); installed packages, running daemons, \
/tmp, and any in-VM state do not.

Idempotent: safe to call even if the sandbox isn't running.`,
    parameters: Type.Object({}),
  },

  async execute(_args, ctx) {
    const runner = getRunner(ctx);
    if (!runner) {
      return {
        ok: false,
        message: "sandbox.shell capability not registered",
        status: { state: "error", uptimeMs: 0 } satisfies SandboxStatus,
      };
    }
    try {
      await runner.reset();
      const status = await runner.status();
      return {
        ok: true,
        message: "sandbox reset; next exec will start a fresh VM",
        status,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `reset failed: ${message}`,
        status: { state: "error", uptimeMs: 0, lastError: message } satisfies SandboxStatus,
      };
    }
  },
};

// ─── get_sandbox_status ────────────────────────────────────────────

export const GetSandboxStatusTool: AgentTool = {
  schema: {
    name: "get_sandbox_status",
    description: `Return the sandbox's current liveness snapshot: state, uptime, last error \
(if any), and provider-specific metadata (image, cpus, memory, last exec time, …). Use this \
when an \`exec\` call returned a confusing error and you want a structured signal before \
deciding to \`reset_sandbox\`.`,
    parameters: Type.Object({}),
  },

  async execute(_args, ctx) {
    const runner = getRunner(ctx);
    if (!runner) {
      return {
        ok: false,
        state: "error",
        message: "sandbox.shell capability not registered",
      };
    }
    const s = await runner.status();
    return {
      ok: true,
      state: s.state,
      uptime_ms: s.uptimeMs,
      last_error: s.lastError ?? null,
      meta: s.meta ?? {},
    };
  },
};

// ─── update_sandbox_config ────────────────────────────────────────

const CONFIGURABLE_KEYS = [
  "image",
  "cpus",
  "memoryMib",
  "sandboxName",
  "idleShutdownMs",
  "execTimeoutMs",
] as const;
type ConfigurableKey = (typeof CONFIGURABLE_KEYS)[number];

export const UpdateSandboxConfigTool: AgentTool = {
  schema: {
    name: "update_sandbox_config",
    description: `Edit this tenant's sandbox config (image / cpus / memory / …). \
Persists to the tenant config file; the change takes effect for new requests. \
The currently-running sandbox VM is **not** restarted automatically — call \
\`reset_sandbox\` after this if you want the new settings to apply right now.

Configurable fields:
- \`image\` (string): OCI image for the sandbox VM. Default \`python:3.12-slim\`.
- \`cpus\` (integer): vCPU count.
- \`memory_mib\` (integer): memory in MiB.
- \`sandbox_name\` (string): sandbox name; rarely needs changing.
- \`idle_shutdown_ms\` (integer): idle ms before the VM is paused. 0 disables.
- \`exec_timeout_ms\` (integer): default per-exec timeout in ms.

Only the fields you pass are touched; omitted fields keep their current value.`,
    parameters: Type.Object({
      image: Type.Optional(Type.String()),
      cpus: Type.Optional(Type.Integer({ minimum: 1 })),
      memory_mib: Type.Optional(Type.Integer({ minimum: 64 })),
      sandbox_name: Type.Optional(Type.String()),
      idle_shutdown_ms: Type.Optional(Type.Integer({ minimum: 0 })),
      exec_timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },

  async execute(args, ctx) {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const mapped: Partial<Record<ConfigurableKey, unknown>> = {};
    const a = args as Record<string, unknown>;
    if (typeof a.image === "string") mapped.image = a.image;
    if (typeof a.cpus === "number") mapped.cpus = Math.floor(a.cpus);
    if (typeof a.memory_mib === "number") mapped.memoryMib = Math.floor(a.memory_mib);
    if (typeof a.sandbox_name === "string") mapped.sandboxName = a.sandbox_name;
    if (typeof a.idle_shutdown_ms === "number") {
      mapped.idleShutdownMs = Math.floor(a.idle_shutdown_ms);
    }
    if (typeof a.exec_timeout_ms === "number") {
      mapped.execTimeoutMs = Math.floor(a.exec_timeout_ms);
    }

    const changedKeys = Object.keys(mapped);
    if (changedKeys.length === 0) {
      return { ok: false, changed: {}, reset_required: false, message: "no config keys provided" };
    }

    // Tenant config path: <tenantHomeDir>/tenants/<id>/config.json.
    // We round-trip through JSON.parse/stringify rather than
    // calling the host's loadTenantConfig() helper to keep this
    // plugin self-contained.
    const cfgPath = path.join(
      ctx.tenantHomeDir,
      "tenants",
      ctx.tenantId,
      "config.json",
    );
    try {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") throw err;
      }
      const plugins = (cfg.plugins ?? {}) as Record<string, Record<string, unknown>>;
      const current = plugins.microsandbox ?? {};
      const currentConfig =
        (current as { config?: Record<string, unknown> }).config ?? {};
      const nextConfig = { ...currentConfig, ...mapped };
      plugins.microsandbox = { ...current, config: nextConfig };
      cfg.plugins = plugins;
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      return {
        ok: true,
        changed: mapped,
        reset_required: requiresReset(mapped),
        message:
          "sandbox config updated; call reset_sandbox to apply to the running VM",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        changed: {},
        reset_required: false,
        message: `failed to write tenant config: ${message}`,
      };
    }
  },
};

function requiresReset(changes: Partial<Record<ConfigurableKey, unknown>>): boolean {
  return Object.keys(changes).some(
    (k) => k === "image" || k === "cpus" || k === "memoryMib" || k === "sandboxName",
  );
}
