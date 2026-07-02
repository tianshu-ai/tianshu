// OpenCodeWorker — drives the headless OpenCode CLI inside the
// tenant's shell sandbox to complete a workboard task.
//
// The model comes from tianshu's own model list, reached through the
// host `host.opencodeProxy` capability: the worker mints a per-task,
// single-model token, writes an opencode.json that points OpenCode
// at the proxy (token as apiKey, proxy address as baseURL), runs
// `opencode run ... --format json`, parses the NDJSON event stream,
// and revokes the token when done. The real LLM key / baseUrl never
// enter the sandbox.
//
// Sandbox model (openshell): one long-lived container per tenant, no
// per-task VM. We isolate each task under its own working directory
// `opencode/<taskId>/` inside the sandbox so concurrent tasks don't
// clobber each other's cwd / opencode.json / file artifacts.

import type {
  ExecRequest,
  OpenCodeProxyCapability,
  OpenCodeProxyGrant,
  PluginLogger,
  SandboxRunner,
} from "@tianshu-ai/plugin-sdk";
import type { Task } from "../db/tasks.js";
import type { WorkerHandle, TerminalUpdate } from "./pool.js";

/** Map a tianshu model's `api` to the OpenCode provider npm package
 *  + whether the model id sits in the request body (openai/anthropic)
 *  or the URL path (google). Used to shape opencode.json. */
export function providerNpmForApi(api: string): string {
  switch (api) {
    case "anthropic-messages":
      return "@ai-sdk/anthropic";
    case "google-generative-ai":
      return "@ai-sdk/google";
    case "openai-completions":
    case "openai-responses":
    default:
      // openai-compatible works for the SAP-proxy openai endpoint and
      // any other openai-completions provider.
      return "@ai-sdk/openai-compatible";
  }
}

/** Per-task model override rides on a label `opencode-model:<id>`
 *  so no task schema change is needed. Falls back to the worker's
 *  configured default. */
export function resolveTaskModel(task: Task, defaultModel: string): string {
  const label = (task.labels ?? []).find((l) =>
    l.startsWith("opencode-model:"),
  );
  if (label) {
    const id = label.slice("opencode-model:".length).trim();
    if (id) return id;
  }
  return defaultModel;
}

export interface OpenCodeWorkerDeps {
  agentId: string;
  name: string;
  /** Worker's default model id, e.g. "anthropic/claude-opus-4-7".
   *  A task label `opencode-model:<id>` overrides it per task. */
  defaultModel: string;
  tenantId: string;
  shell: SandboxRunner;
  proxy: OpenCodeProxyCapability;
  log: PluginLogger;
  /** Per-run timeout (ms). Default 20 min. */
  timeoutMs?: number;
}

/** opencode-ai version the worker installs into the sandbox. Pinned
 *  so a task run is reproducible and a bad upstream release can't
 *  silently break every worker. Bump deliberately. */
const OPENCODE_VERSION = "1.17.13";

export class OpenCodeWorker implements WorkerHandle {
  readonly kind = "opencode";
  readonly agentId: string;
  readonly name: string;

  constructor(private readonly deps: OpenCodeWorkerDeps) {
    this.agentId = deps.agentId;
    this.name = deps.name;
  }

  async run(task: Task, signal: AbortSignal): Promise<TerminalUpdate> {
    const modelId = resolveTaskModel(task, this.deps.defaultModel);

    let grant: OpenCodeProxyGrant | null = null;
    const workdir = `opencode/${task.id}`;

    try {
      grant = this.deps.proxy.grant(this.deps.tenantId, modelId);
      this.deps.log.info?.("opencode-worker: starting task", {
        taskId: task.id,
        model: modelId,
        api: grant.api,
      });

      // opencode.json: point the "tianshu" provider at the proxy.
      // The token is the apiKey; the proxy baseUrl already carries
      // the token path segment. OpenCode appends the protocol tail.
      // The grant tells us the model's wire protocol → provider npm.
      const providerNpm = providerNpmForApi(grant.api);
      const nativeModelId = modelId.includes("/")
        ? modelId.slice(modelId.indexOf("/") + 1)
        : modelId;
      const opencodeConfig = {
        $schema: "https://opencode.ai/config.json",
        provider: {
          tianshu: {
            npm: providerNpm,
            name: "Tianshu (proxied)",
            options: {
              baseURL: grant.baseUrl,
              apiKey: grant.token,
            },
            models: { [nativeModelId]: { name: nativeModelId } },
          },
        },
      };

      // Write config + prompt into the task's isolated workdir.
      // Ensure opencode is available in the sandbox. openshell's base
      // image ships node but not opencode; install once (idempotent —
      // subsequent tasks in the same long-lived container skip it).
      // Generous timeout: first install pulls the platform binary.
      const ensure = await this.sh(
        `command -v opencode >/dev/null 2>&1 || npm i -g opencode-ai@${OPENCODE_VERSION}`,
        task,
        signal,
        5 * 60_000,
      );
      if (ensure.exitCode !== 0 && !ensure.aborted) {
        return {
          status: "stalled",
          resultSummary:
            `Failed to install opencode in the sandbox (exit ${ensure.exitCode}).` +
            (ensure.stderr
              ? `\n\nstderr: ${ensure.stderr.slice(0, 500)}`
              : ""),
        };
      }
      if (ensure.aborted) {
        return { status: "aborted", resultSummary: "Aborted during opencode install." };
      }

      await this.sh(
        `mkdir -p ${shq(workdir)}`,
        task,
        signal,
      );
      await this.deps.shell.writeFile(
        `${workdir}/opencode.json`,
        JSON.stringify(opencodeConfig, null, 2),
      );

      // Grant the sandbox egress to the proxy. openshell is
      // deny-by-default for network, so without this the in-sandbox
      // opencode gets a 403 policy_denied reaching the proxy. Derive
      // host:port from the grant's baseUrl. No-op on runtimes with
      // open network (allowEgress undefined).
      if (this.deps.shell.allowEgress) {
        try {
          const u = new URL(grant.baseUrl);
          const port = u.port
            ? Number(u.port)
            : u.protocol === "https:"
              ? 443
              : 80;
          // openshell gates egress by BOTH host:port AND the
          // requesting binary, so authorize opencode + its node
          // runtime. Without these the endpoint registers but every
          // request is denied (403 policy_denied). Cover both the
          // real (node_modules) path and the /usr/bin symlink.
          await this.deps.shell.allowEgress({
            host: u.hostname,
            port,
            protocol: u.protocol === "https:" ? "https" : "http",
            binaries: [
              "/usr/lib/node_modules/opencode-ai/bin/opencode",
              "/usr/bin/opencode",
              "/usr/local/bin/opencode",
              "/usr/bin/node",
              "/usr/local/bin/node",
            ],
          });
        } catch (err) {
          this.deps.log.warn?.(
            "opencode-worker: allowEgress failed (continuing; run may 403)",
            { err: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      // Write the prompt to a file and pipe it via stdin rather than
      // passing it as a command-line argument. The sandbox exec
      // transport (openshell) rejects any argv element containing a
      // newline ("command argument N contains newline"), so a
      // multi-line task description would break a positional-arg
      // call. opencode reads a piped prompt from stdin
      // (Bun.stdin.text()), so `... run --format json < .prompt.txt`
      // keeps the command line newline-free while still delivering
      // the full multi-line prompt.
      const prompt = buildPrompt(task);
      await this.deps.shell.writeFile(`${workdir}/.prompt.txt`, prompt);

      // OPENCODE_CONFIG points opencode at our config; run from the
      // task workdir so file artifacts land there. Prompt via stdin.
      const cmd =
        `cd ${shq(workdir)} && ` +
        `OPENCODE_CONFIG=./opencode.json ` +
        `opencode run --model tianshu/${nativeModelId} --format json ` +
        `< .prompt.txt`;

      const res = await this.sh(cmd, task, signal, this.deps.timeoutMs);
      this.deps.log.info?.("opencode-worker: run finished", {
        taskId: task.id,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        aborted: res.aborted,
        stderrHead: res.stderr ? res.stderr.slice(0, 200) : "",
      });

      if (res.aborted) {
        return {
          status: "aborted",
          resultSummary: "OpenCode run aborted (signal).",
        };
      }
      if (res.timedOut) {
        return {
          status: "stalled",
          resultSummary: `OpenCode run timed out after ${
            this.deps.timeoutMs ?? 20 * 60_000
          }ms.`,
        };
      }

      const parsed = parseOpencodeEvents(res.stdout);
      if (parsed.error) {
        return {
          status: "stalled",
          resultSummary: `OpenCode error: ${parsed.error}`,
        };
      }
      if (res.exitCode !== 0) {
        return {
          status: "stalled",
          resultSummary:
            `OpenCode exited ${res.exitCode}.` +
            (parsed.text ? `\n\n${parsed.text}` : "") +
            (res.stderr ? `\n\nstderr: ${res.stderr.slice(0, 500)}` : ""),
        };
      }

      // Collect file artifacts opencode may have written under the
      // task workdir (best-effort — non-fatal if the listing fails).
      const files = await this.listArtifacts(workdir, task, signal);

      return {
        status: "done",
        resultSummary: parsed.text || "(OpenCode produced no text output.)",
        resultFiles: files,
      };
    } catch (err) {
      return {
        status: "stalled",
        resultSummary: `OpenCodeWorker failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    } finally {
      if (grant) {
        try {
          this.deps.proxy.revoke(grant.token);
        } catch (err) {
          this.deps.log.warn?.("opencode-worker: proxy.revoke failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private sh(
    command: string,
    task: Task,
    signal: AbortSignal,
    timeoutMs?: number,
  ): ReturnType<SandboxRunner["exec"]> {
    const req: ExecRequest = {
      command,
      userId: task.ownerUserId,
      taskId: task.id,
      signal,
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    return this.deps.shell.exec(req);
  }

  /** Best-effort list of files opencode wrote under the workdir,
   *  returned as workspace-relative paths for TerminalUpdate. */
  private async listArtifacts(
    workdir: string,
    task: Task,
    signal: AbortSignal,
  ): Promise<string[]> {
    try {
      const res = await this.sh(
        // list files (skip our scaffolding), newline-separated, relative
        `cd ${shq(workdir)} && find . -type f ! -name opencode.json ! -name .prompt.txt -printf '%P\\n' 2>/dev/null | head -100`,
        task,
        signal,
      );
      if (res.exitCode !== 0) return [];
      return res.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((rel) => `${workdir}/${rel}`);
    } catch {
      return [];
    }
  }
}

/** Compose the prompt handed to `opencode run` from the task. */
function buildPrompt(task: Task): string {
  const parts = [task.title];
  if (task.description && task.description.trim()) {
    parts.push("", task.description.trim());
  }
  return parts.join("\n");
}

/** Parse OpenCode's `--format json` NDJSON stream. Collects the
 *  assistant text parts and surfaces the first session error.
 *  Each line is `{type, timestamp, sessionID, ...data}`. */
export function parseOpencodeEvents(stdout: string): {
  text: string;
  error?: string;
} {
  const texts: string[] = [];
  let error: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s[0] !== "{") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(s) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = ev.type;
    if (type === "text") {
      const part = ev.part as { text?: unknown } | undefined;
      if (part && typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    } else if (type === "session.error" || type === "error") {
      // opencode error shape (observed): {type,error:{name,data:{
      // message,statusCode,responseBody,...}}} — sometimes nested
      // under `properties`. Dig for the useful bits: name +
      // statusCode + message + a snippet of the upstream body, so a
      // proxy/upstream 4xx/5xx is diagnosable instead of just
      // "APIError".
      if (!error) {
        const props = (ev.properties ?? ev) as Record<string, unknown>;
        const e = (props.error ?? props) as Record<string, unknown>;
        const data = (e.data ?? {}) as Record<string, unknown>;
        const name =
          typeof e.name === "string" ? e.name : "error";
        const status =
          typeof data.statusCode === "number"
            ? ` (status ${data.statusCode})`
            : "";
        const msg =
          (typeof data.message === "string" && data.message) ||
          (typeof e.message === "string" && e.message) ||
          "";
        const bodyRaw =
          (typeof data.responseBody === "string" && data.responseBody) ||
          (typeof data.body === "string" && data.body) ||
          "";
        const body = bodyRaw
          ? ` — body: ${bodyRaw.replace(/\s+/g, " ").slice(0, 300)}`
          : "";
        error =
          `${name}${status}${msg ? `: ${msg}` : ""}${body}` ||
          JSON.stringify(e).slice(0, 400);
      }
    }
  }
  return { text: texts.join("\n\n"), error };
}

/** Minimal shell single-quote escaping for embedding a string in a
 *  bash command. Wraps in single quotes; escapes embedded quotes. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
