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

import { randomUUID } from "node:crypto";
import type {
  ExecRequest,
  OpenCodeProxyCapability,
  OpenCodeProxyGrant,
  PluginLogger,
  SandboxRunner,
  TenantDbHandle,
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
  /** DB handle — used to write the opencode run transcript into a
   *  worker session so the task's Execution tab can render it. */
  db: TenantDbHandle;
  /** Owner user id for the session row (FK). */
  ownerUserId?: string;
  log: PluginLogger;
  /** Per-run timeout (ms). Default 20 min. */
  timeoutMs?: number;
  /**
   * Enable opencode's LSP + formatters. OFF by default: opencode
   * auto-installs a language server for the edited file (npm/go/gem),
   * but the sandbox egress is normally locked to just the model
   * proxy, so that install hangs forever. When true, the worker (a)
   * keeps lsp/formatter enabled in opencode.json, (b) does NOT set
   * OPENCODE_DISABLE_LSP_DOWNLOAD, and (c) opens sandbox egress to
   * the package registries opencode needs (npm + GitHub) so the
   * install can succeed. This widens the sandbox's network surface
   * — only enable it when you want richer code intelligence and
   * accept the reduced isolation.
   */
  enableLsp?: boolean;
}

/** Hosts opencode needs to reach to auto-install LSP servers /
 *  formatters when enableLsp is on. Kept tight (npm + GitHub
 *  release assets) rather than opening all public egress. */
const LSP_INSTALL_EGRESS: Array<{ host: string; port: number }> = [
  { host: "registry.npmjs.org", port: 443 },
  { host: "github.com", port: 443 },
  { host: "objects.githubusercontent.com", port: 443 },
  { host: "raw.githubusercontent.com", port: 443 },
  { host: "codeload.github.com", port: 443 },
];

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
        // Disable services that keep the process alive / phone home:
        // snapshot spins up an internal git watcher, autoupdate
        // reaches the network.
        snapshot: false,
        autoupdate: false,
        // LSP + formatters: OFF unless the worker enabled them.
        // opencode auto-installs a language server for the edited
        // file (e.g. bash-language-server via npm); with the default
        // proxy-only egress that install hangs forever before the
        // model is even called. When enableLsp is on we keep them
        // enabled AND open egress to npm/GitHub (below) so the
        // install can complete.
        ...(this.deps.enableLsp
          ? {}
          : { lsp: false as const, formatter: false as const }),
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

        // When LSP is enabled, also open egress to the package
        // registries opencode installs language servers / formatters
        // from (npm + GitHub). Authorize node/npm binaries. Without
        // this the LSP auto-install has no network and hangs.
        if (this.deps.enableLsp) {
          for (const ep of LSP_INSTALL_EGRESS) {
            try {
              await this.deps.shell.allowEgress({
                host: ep.host,
                port: ep.port,
                protocol: "https",
                binaries: [
                  "/usr/bin/node",
                  "/usr/local/bin/node",
                  "/usr/bin/npm",
                  "/usr/local/bin/npm",
                  "/usr/lib/node_modules/opencode-ai/bin/opencode",
                ],
              });
            } catch (err) {
              this.deps.log.warn?.(
                "opencode-worker: LSP-install egress grant failed",
                {
                  host: ep.host,
                  err: err instanceof Error ? err.message : String(err),
                },
              );
            }
          }
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

      // Run opencode with ISOLATED XDG dirs so it doesn't pick up
      // the container's global opencode config/plugins. Without this
      // opencode loads ~/.config/opencode (e.g. an
      // opencode-anthropic-auth plugin) which fights the tianshu
      // provider we inject and leaves it spinning on auth/init
      // without producing task output. Pointing XDG_CONFIG_HOME +
      // XDG_DATA_HOME at per-task dirs gives opencode a clean slate;
      // OPENCODE_CONFIG still supplies our provider. Prompt via stdin
      // (avoids the openshell newline-in-argv rejection).
      // opencode `run` emits its NDJSON result to stdout, then does
      // NOT exit — its embedded server (file.watcher, LSP, the slow
      // formatter sweep) keeps the process alive indefinitely, so we
      // can't wait for a clean exit. Idle-watchdog: run opencode in
      // the background with a plain stdout redirect to oc.out; poll
      // oc.out's mtime, and once it's been idle for idleS seconds
      // (opencode finished emitting and is just idling in its server
      // loop) kill opencode + its children and return. `cat oc.out`
      // yields the captured NDJSON. A hard cap (from the run budget)
      // bounds the whole thing if opencode never produces output.
      const budgetMs = this.deps.timeoutMs ?? 20 * 60_000;
      // Watchdog note: openshell wraps the command in its own
      // `bash -c`, which can re-exec, making `$!` unreliable for
      // tracking the opencode pid. So we DON'T track a pid — we poll
      // oc.out's mtime, and when it's non-empty and idle for idleS
      // seconds (opencode done emitting, or stuck) we pkill every
      // opencode process and return oc.out. A hard cap bounds the
      // case where opencode never emits anything.
      // Run opencode in the FOREGROUND with a stdout redirect, capped
      // by `timeout`. Notes learned the hard way:
      //   - Backgrounding with `&` breaks the `> oc.out` redirect
      //     (opencode's re-exec'd child doesn't inherit the fd), so
      //     the file ends up empty/absent. Foreground redirect works.
      //   - OPENCODE_DISABLE_LSP_DOWNLOAD=1 stops opencode from
      //     auto-installing a language server (e.g.
      //     bash-language-server via npm) for the edited file — that
      //     install has no network in the egress-locked sandbox and
      //     hangs forever BEFORE opencode calls the model. This is
      //     the real fix for the "stuck, proxy never hit" symptom.
      //   - opencode `run`'s embedded server may still not exit
      //     cleanly, so `timeout -s KILL` bounds it; the NDJSON
      //     result is already in oc.out by then. cap = run budget
      //     minus a margin, floor 120s.
      const capS = Math.max(120, Math.floor(budgetMs / 1000) - 15);
      const cmd =
        `cd ${shq(workdir)} && ` +
        `mkdir -p .oc-config .oc-data && ` +
        `XDG_CONFIG_HOME="$PWD/.oc-config" ` +
        `XDG_DATA_HOME="$PWD/.oc-data" ` +
        // Block LSP auto-download unless the worker enabled LSP (and
        // opened the egress for it above).
        (this.deps.enableLsp ? `` : `OPENCODE_DISABLE_LSP_DOWNLOAD=1 `) +
        `OPENCODE_CONFIG=./opencode.json ` +
        `timeout -s KILL ${capS} ` +
        `opencode run --model tianshu/${nativeModelId} --format json ` +
        `< .prompt.txt > oc.out 2> oc.err ; ` +
        `cat oc.out`;

      const res = await this.sh(cmd, task, signal, this.deps.timeoutMs);
      this.deps.log.info?.("opencode-worker: run finished", {
        taskId: task.id,
        exitCode: res.exitCode,
        timedOut: res.timedOut,
        aborted: res.aborted,
        stderrHead: res.stderr ? res.stderr.slice(0, 200) : "",
      });

      const parsed = parseOpencodeEvents(res.stdout);

      // Write the run's transcript into a worker session so the
      // task's Execution tab can show what opencode did (prompt +
      // assistant text + tool calls). Best-effort; failure to write
      // history never fails the task. Also drop the raw NDJSON into
      // the workdir as a downloadable artifact.
      const sessionId = this.writeHistory(task, parsed, res);
      await this.deps.shell
        .writeFile(`${workdir}/opencode-transcript.jsonl`, res.stdout ?? "")
        .catch(() => undefined);

      if (res.aborted) {
        return {
          status: "aborted",
          resultSummary: "OpenCode run aborted (signal).",
          sessionId,
        };
      }
      if (res.timedOut) {
        return {
          status: "stalled",
          resultSummary: `OpenCode run timed out after ${
            this.deps.timeoutMs ?? 20 * 60_000
          }ms.`,
          sessionId,
        };
      }
      if (parsed.error) {
        return {
          status: "stalled",
          resultSummary: `OpenCode error: ${parsed.error}`,
          sessionId,
        };
      }
      if (res.exitCode !== 0) {
        return {
          status: "stalled",
          resultSummary:
            `OpenCode exited ${res.exitCode}.` +
            (parsed.text ? `\n\n${parsed.text}` : "") +
            (res.stderr ? `\n\nstderr: ${res.stderr.slice(0, 500)}` : ""),
          sessionId,
        };
      }

      // Collect file artifacts opencode may have written under the
      // task workdir (best-effort — non-fatal if the listing fails).
      const files = await this.listArtifacts(workdir, task, signal);

      return {
        status: "done",
        resultSummary: parsed.text || "(OpenCode produced no text output.)",
        resultFiles: files,
        sessionId,
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

  /**
   * Persist the opencode run as a worker session + messages so the
   * task's Execution tab (GET /tasks/:id/history) can render it:
   *   - user   : the prompt we sent
   *   - assistant: opencode's text output, with its tool calls
   *                attached as toolCalls (rendered by the history
   *                reader)
   *   - system : a short outcome footer (exit code / error / timeout)
   * Best-effort: any failure is swallowed (returns null) so history
   * writing never breaks the task. Returns the session id to stamp
   * onto the task.
   */
  private writeHistory(
    task: Task,
    parsed: { text: string; error?: string; tools: OpencodeToolEvent[] },
    res: {
      exitCode?: number;
      timedOut?: boolean;
      aborted?: boolean;
      stderr?: string;
    },
  ): string | null {
    try {
      const db = this.deps.db;
      const now = Date.now();
      const sessionId = `ocs_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const userId = this.deps.ownerUserId ?? task.ownerUserId;

      // sessions.user_id has a NOT NULL FK to users(id). The task's
      // owner is normally already a user, but dev-tenant / virtual
      // users may not be persisted — ensure the row exists so the
      // session insert doesn't hit a FOREIGN KEY constraint. Idempotent.
      db.prepare(
        `INSERT OR IGNORE INTO users (id, external_id, provider, display_name, created_at)
         VALUES (?, ?, 'opencode-worker', ?, ?)`,
      ).run(userId, userId, userId, now);

      db.prepare(
        `INSERT INTO sessions (id, user_id, status, kind, worker_role, title, project_slug, created_at)
         VALUES (?, ?, 'active', 'worker', ?, ?, ?, ?)`,
      ).run(
        sessionId,
        userId,
        `opencode:${this.agentId}`,
        `OpenCode: ${task.title}`.slice(0, 200),
        task.projectSlug,
        now,
      );

      const insertMsg = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const mkId = () => `ocm_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

      // 1) the prompt we sent (user)
      insertMsg.run(
        mkId(),
        sessionId,
        "user",
        JSON.stringify({ text: buildPrompt(task) }),
        now,
      );

      // 2) assistant text + tool calls. Store in the shape the
      //    history reader understands: content with text + a
      //    toolCalls array.
      const toolCalls = parsed.tools.map((t, i) => ({
        callId: `oc_${i}`,
        toolName: t.tool,
        argsJson: t.detail,
      }));
      const assistantText =
        parsed.text ||
        (parsed.tools.length
          ? `(ran ${parsed.tools.length} tool call(s), no final text)`
          : "(no output)");
      insertMsg.run(
        mkId(),
        sessionId,
        "assistant",
        JSON.stringify({ text: assistantText, toolCalls }),
        now + 1,
      );

      // 3) outcome footer (system)
      const outcome = res.aborted
        ? "aborted"
        : res.timedOut
          ? "timed out"
          : parsed.error
            ? `error: ${parsed.error}`
            : res.exitCode !== 0
              ? `exited ${res.exitCode ?? "?"}${res.stderr ? `: ${res.stderr.slice(0, 300)}` : ""}`
              : "completed";
      insertMsg.run(
        mkId(),
        sessionId,
        "system",
        JSON.stringify({ text: `OpenCode run ${outcome}.` }),
        now + 2,
      );

      return sessionId;
    } catch (err) {
      this.deps.log.warn?.("opencode-worker: writeHistory failed", {
        err: err instanceof Error ? err.message : String(err),
        userId: this.deps.ownerUserId ?? task.ownerUserId,
        ownerUserId: task.ownerUserId,
      });
      return null;
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
        `cd ${shq(workdir)} && find . -type f ! -path './.oc-config/*' ! -path './.oc-data/*' ! -name opencode.json ! -name .prompt.txt ! -name oc.out ! -name oc.err -printf '%P\\n' 2>/dev/null | head -100`,
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
export interface OpencodeToolEvent {
  tool: string;
  /** Best-effort short arg summary. */
  detail: string;
}

export function parseOpencodeEvents(stdout: string): {
  text: string;
  error?: string;
  /** Tool calls opencode made, in order — for the history view. */
  tools: OpencodeToolEvent[];
} {
  const texts: string[] = [];
  const tools: OpencodeToolEvent[] = [];
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
    } else if (type === "tool_use" || type === "tool") {
      const part = (ev.part ?? ev) as Record<string, unknown>;
      const tool =
        (typeof part.tool === "string" && part.tool) ||
        (typeof part.name === "string" && part.name) ||
        "tool";
      const input = part.input ?? part.args ?? part.arguments;
      let detail = "";
      try {
        detail = input ? JSON.stringify(input).slice(0, 200) : "";
      } catch {
        detail = "";
      }
      tools.push({ tool, detail });
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
  return { text: texts.join("\n\n"), error, tools };
}

/** Minimal shell single-quote escaping for embedding a string in a
 *  bash command. Wraps in single quotes; escapes embedded quotes. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
