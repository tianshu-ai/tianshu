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
  AgentLoopRunner,
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
  /** host.agentLoop — after opencode finishes, we run a short agent
   *  turn that reads opencode's transcript, judges whether the task
   *  actually succeeded, and calls task_complete. This replaces the
   *  old mechanical exitCode-based judgment (opencode exits 0 even
   *  when it gave up), and also unblocks the run the moment opencode
   *  exits. Optional: if absent, fall back to mechanical judgment. */
  runner?: AgentLoopRunner;
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

/** Sandbox-side workspace root the openshell runner uses. The
 *  opencode workdir (`opencode/<taskId>`) is relative to this;
 *  the judge needs the absolute path for its bash/ls. */
const SANDBOX_WORKSPACE_ROOT = "/sandbox/workspace";

/** Name of the collect-here directory the judge copies deliverables
 *  into (relative to the opencode workdir). The worker then syncs
 *  this whole dir to the host. Using a fixed collection dir means we
 *  don't depend on WHERE opencode originally wrote a file — the judge
 *  (which has bash) gathers them here first. */
const DELIVERABLES_DIR = ".deliverables";

/** Absolute sandbox path of the deliverables collection dir for a
 *  given absolute workdir. */
function DELIVERABLES_ABS(workdirAbs: string): string {
  return `${workdirAbs}/${DELIVERABLES_DIR}`;
}

/** Host-side per-task results folder name, HOST-DERIVED from the task
 *  row (never from the agent). Mirrors openshell SyncDownTool's
 *  deriveTaskFolderFromCtx: taskId, or a slugified title when present,
 *  so opencode + LLM-worker deliverables share one convention. */
function deriveTaskFolder(task: Task): string {
  const id = (task.id ?? "").trim();
  const title = (task.title ?? "").trim();
  if (!title) return id || "task";
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug || slug === "." || slug === ".." || slug.startsWith(".")) {
    return id || "task";
  }
  return slug;
}

/** Process/scaffolding files that must never be reported as task
 *  deliverables even if the judge lists them by mistake. These are
 *  the worker's own artifacts (config, prompt, captured output,
 *  transcript) plus the policy-advisor proposal scratch file. */
const EXCLUDED_DELIVERABLE = new Set<string>([
  "opencode.json",
  ".prompt.txt",
  "oc.out",
  "oc.err",
  "opencode-transcript.jsonl",
  "proposal.json",
]);

/**
 * opencode-native skill (SKILL.md, with the YAML frontmatter opencode
 * requires) that teaches opencode to use the OpenShell Policy Advisor
 * loop when the deny-by-default sandbox blocks a network request.
 *
 * Written into each task's `.oc-config/opencode/skills/` so opencode
 * discovers it as a global skill. The gateway must have the advisor
 * enabled (agent_policy_proposals_enabled=true) for proposals to be
 * accepted, and proposal_approval_mode=auto for prover-clean rules to
 * self-approve; otherwise the proposal lands in `pending` for a human.
 *
 * The proposal schema below is the one the sandbox's own advisor
 * (/etc/openshell/skills/policy_advisor.md) documents and that we
 * verified end-to-end: POST /v1/proposals with
 * {intent_summary, operations:[{addRule:{ruleName, rule:{name,
 * endpoints:[{host,port,protocol,enforcement,rules:[{allow:{method,
 * path}}]}], binaries:[{path}]}}}]}.
 *
 * Binary gating (critical): openshell authorizes egress by BOTH
 * host:port AND the requesting binary's absolute path. opencode's
 * own `webfetch` runs inside the opencode/bun runtime, NOT curl, so a
 * rule that only lists /usr/bin/curl will not unblock webfetch. The
 * skill therefore (a) lists every relevant binary and (b) tells
 * opencode to retry with `curl` (deterministic path) after approval.
 *
 * The binary paths below were verified against the OpenShell
 * community base image after `npm i -g opencode-ai`:
 *   /usr/bin/node                                   (node runtime)
 *   /usr/bin/curl                                   (retry path)
 *   /usr/bin/opencode                               (wrapper symlink)
 *   /usr/lib/node_modules/opencode-ai/bin/opencode  (js entry)
 *   /usr/lib/node_modules/opencode-ai/bin/.opencode (real ~158MB
 *     bun-compiled binary that actually opens the socket for
 *     webfetch — note the leading dot; this is the one the kernel
 *     sees, so it MUST be listed or webfetch stays blocked)
 */
const ADVISOR_SKILL_MD = `---
name: openshell-network-policy
description: >-
  Unblock a denied outbound network request in this deny-by-default
  OpenShell sandbox by proposing the narrowest egress rule via the
  local policy API (http://policy.local). Use on HTTP 403 "CONNECT
  tunnel failed" or any \`policy_denied\` response.
---

# OpenShell network policy (unblock denied egress)

This sandbox denies outbound network by default. A blocked request
shows up as \`curl: (56) CONNECT tunnel failed, response 403\`, an
HTTP 403, or a JSON body containing \`policy_denied\`. Do not give up
and do not report the host as "needs allowlisting" — propose the
rule yourself through the sandbox-local policy API, then retry.

## Procedure

1. See what was denied:
   \`curl -s http://policy.local/v1/denials?last=10\`
   Each line shows the binary, host, and port that were blocked.
2. Build the smallest proposal for exactly the host+port you need
   (see schema below). Prefer an L7 REST rule with a tight path.
   Write it to \`./proposal.json\` in the CURRENT working directory
   — do NOT use /tmp or any absolute path outside the workdir, or
   the write will be rejected.
3. Submit it (run from the same directory as proposal.json):
   \`\`\`sh
   curl -s -X POST http://policy.local/v1/proposals \\
     -H 'content-type: application/json' -d @./proposal.json
   \`\`\`
   The 202 response has \`accepted_chunk_ids\` (save the first id)
   and \`rejection_reasons\` (fix + resubmit if non-empty).
4. Wait for the decision (auto-approval returns in ~1s):
   \`curl -s "http://policy.local/v1/proposals/<chunk_id>/wait?timeout=60"\`
   - \`status:"approved"\` + \`policy_reloaded:true\` → retry the
     original request; it should now succeed.
   - \`status:"approved"\` + \`policy_reloaded:false\` → wait once
     more: \`.../wait?timeout=30\`, then retry.
   - \`status:"rejected"\` → read \`rejection_reason\` +
     \`validation_result\`, revise, resubmit. Do not loop blindly.
   - \`status:"pending"\` with \`timed_out:true\` → call \`/wait\`
     again. (Pending means a human must approve — the gateway is not
     in auto mode, or the prover flagged the rule.)

## Binary gating (important)

OpenShell allows egress only for the specific binaries you list. Your
\`webfetch\` tool runs inside the opencode/bun runtime, not curl, so
list ALL of these in every rule's \`binaries\`, and after approval
**retry the fetch with \`curl\`** (its path is deterministic):

- \`/usr/bin/curl\`
- \`/usr/bin/node\`
- \`/usr/bin/opencode\`
- \`/usr/lib/node_modules/opencode-ai/bin/opencode\`
- \`/usr/lib/node_modules/opencode-ai/bin/.opencode\`

(The last one — with the leading dot — is the real bun-compiled
binary that actually opens the network socket for \`webfetch\`. If
your \`webfetch\` still 403s after approval, it is almost always
because this path was omitted. When in doubt, just retry with
\`curl\`.)

## Proposal schema (write to ./proposal.json in the current dir)

Example: allow GET to https://example.com over HTTPS. Save this to
\`./proposal.json\` (relative to your working directory — never /tmp).

\`\`\`json
{
  "intent_summary": "Fetch example.com over HTTPS for the current task.",
  "operations": [
    {
      "addRule": {
        "ruleName": "example_com_get",
        "rule": {
          "name": "example_com_get",
          "endpoints": [
            {
              "host": "example.com",
              "port": 443,
              "protocol": "rest",
              "enforcement": "enforce",
              "rules": [{ "allow": { "method": "GET", "path": "/**" } }]
            }
          ],
          "binaries": [
            { "path": "/usr/bin/curl" },
            { "path": "/usr/bin/node" },
            { "path": "/usr/bin/opencode" },
            { "path": "/usr/lib/node_modules/opencode-ai/bin/opencode" },
            { "path": "/usr/lib/node_modules/opencode-ai/bin/.opencode" }
          ]
        }
      }
    }
  ]
}
\`\`\`

Rules of thumb: one rule per host you actually need; keep \`path\`
as narrow as the task allows (\`/**\` only if you truly browse the
whole site); use \`protocol:"tcp"\` with an L4 endpoint (no \`rules\`)
only for opaque protocols (ssh, git-over-ssh). Credentialed hosts and
capability-expanding rules will NOT auto-approve — they go to a human.
`;

export class OpenCodeWorker implements WorkerHandle {
  readonly kind = "opencode";
  readonly agentId: string;
  readonly name: string;
  /** Worker session for the current run's transcript. Created once
   *  by ensureSession(), reused by the poller + the final write. */
  private sessionId: string | null = null;

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
        // Headless: never pause for approval. opencode is
        // interactive by default and, run non-interactively, a tool
        // that needs approval is auto-rejected ("user rejected
        // permission") and the run stalls. Allow EVERY tool via the
        // catch-all, then keep the explicit keys as documentation.
        //
        // Two footguns this closes:
        //   - `write`/`patch` are separate tools from `edit`; the
        //     catch-all covers them so a policy-advisor proposal file
        //     write isn't auto-rejected (the failure we hit before).
        //   - `external_directory`: any tool touching a path OUTSIDE
        //     the run's cwd (e.g. opencode writing /tmp/proposal.json,
        //     or the policy skill's curl reading it) is denied by
        //     default even when the tool itself is allowed. Whitelist
        //     the sandbox workspace + /tmp so those go through.
        permission: {
          "*": "allow" as const,
          edit: "allow" as const,
          bash: "allow" as const,
          webfetch: "allow" as const,
          external_directory: {
            "/tmp/**": "allow" as const,
            "/sandbox/**": "allow" as const,
          },
        },
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

      // On a deny-by-default sandbox (openshell exposes allowEgress),
      // drop an opencode-native skill that teaches opencode to use
      // the OpenShell Policy Advisor loop when a network request is
      // denied (403 CONNECT tunnel failed / policy_denied), instead
      // of giving up. opencode discovers global skills under
      // $XDG_CONFIG_HOME/opencode/skills/<name>/SKILL.md; the run
      // sets XDG_CONFIG_HOME=$PWD/.oc-config, so we write it there.
      // Harmless when the gateway's advisor is off/manual — opencode
      // just won't get an auto-approval (same as today). No-op on
      // open-network runtimes (allowEgress undefined) where the skill
      // would be misleading.
      if (this.deps.shell.allowEgress) {
        await this.deps.shell
          .writeFile(
            `${workdir}/.oc-config/opencode/skills/openshell-network-policy/SKILL.md`,
            ADVISOR_SKILL_MD,
          )
          .catch((err) => {
            this.deps.log.warn?.(
              "opencode-worker: failed to write advisor skill (continuing)",
              { err: err instanceof Error ? err.message : String(err) },
            );
          });
      }

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
      const prompt = buildPrompt(task, {
        networkPolicyAdvisor: Boolean(this.deps.shell.allowEgress),
      });
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

      // Near-real-time transcript: while opencode runs (sh() blocks
      // until it exits), poll the oc.out NDJSON file from the sandbox
      // every few seconds, parse what's there so far, and rewrite the
      // session history. Lets the Execution tab show progress
      // mid-run instead of only at the end. Best-effort; any poll
      // error is ignored. Cleared in finally.
      this.ensureSession(task);
      const pollWorkdir = workdir;
      let polling = true;
      const pollTimer = setInterval(() => {
        void (async () => {
          if (!polling) return;
          try {
            const out = await this.deps.shell.readFile(
              `${pollWorkdir}/oc.out`,
            );
            if (!out) return;
            const p = parseOpencodeEvents(out);
            this.writeHistory(task, p, {}, false);
          } catch {
            /* file not there yet / read raced — ignore */
          }
        })();
      }, 4000);

      let res: Awaited<ReturnType<typeof this.sh>>;
      try {
        res = await this.sh(cmd, task, signal, this.deps.timeoutMs);
      } finally {
        polling = false;
        clearInterval(pollTimer);
      }
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
      const sessionId = this.writeHistory(task, parsed, res, true);
      await this.deps.shell
        .writeFile(`${workdir}/opencode-transcript.jsonl`, res.stdout ?? "")
        .catch(() => undefined);

      // Infra-level failures the LLM judge can't help with: return
      // straight away.
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

      // Collect file artifacts opencode wrote under the task workdir.
      const files = await this.listArtifacts(workdir, task, signal);

      // JUDGMENT: opencode exits 0 even when it gave up ("I can't
      // install Rust, let me ask the user"), so exitCode is not a
      // reliable success signal. Hand opencode's transcript to a
      // short agent turn (host.agentLoop) that reads what happened,
      // decides whether the task's acceptance criteria were actually
      // met, and calls task_complete. Its result becomes this
      // worker's outcome. Falls back to mechanical judgment if no
      // runner is wired or the judge itself errors.
      if (this.deps.runner) {
        try {
          const judged = await this.judge(task, parsed, files, signal, workdir);
          if (judged) return { ...judged, sessionId };
        } catch (err) {
          this.deps.log.warn?.(
            "opencode-worker: judge failed, falling back to mechanical",
            { err: err instanceof Error ? err.message : String(err) },
          );
        }
      }

      // Mechanical fallback (no judge available).
      if (parsed.error) {
        return {
          status: "stalled",
          resultSummary: `OpenCode error: ${parsed.error}`,
          resultFiles: files,
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
          resultFiles: files,
          sessionId,
        };
      }
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
  /**
   * Post-run judgment: run a short agent turn that reads opencode's
   * transcript + the files it produced, decides whether the task's
   * acceptance criteria were actually met, and calls task_complete
   * (or leaves it incomplete). Returns the mapped TerminalUpdate, or
   * null to fall back to mechanical judgment.
   *
   * The agent shares this task's sandbox (taskId), so it can inspect
   * artifacts / re-run checks itself before deciding. It's given
   * read + task_complete tools only (it judges, it doesn't redo the
   * work).
   */
  private async judge(
    task: Task,
    parsed: { text: string; error?: string; tools: OpencodeToolEvent[] },
    files: string[],
    signal: AbortSignal,
    workdir: string,
  ): Promise<TerminalUpdate | null> {
    const runner = this.deps.runner;
    if (!runner) return null;
    // Absolute sandbox path of the opencode workdir, for the judge's
    // bash/ls. The openshell runner roots the workspace at
    // /sandbox/workspace; workdir is `opencode/<taskId>`.
    const workdirAbs = `${SANDBOX_WORKSPACE_ROOT}/${workdir}`;

    const toolLines = parsed.tools
      .slice(0, 60)
      .map(
        (t) =>
          `- ${t.tool}(${t.detail || ""})${
            t.status ? ` -> ${t.status}` : ""
          }`,
      )
      .join("\n");
    const fileLines = files.length
      ? files.map((f) => `- ${f}`).join("\n")
      : "(none reported)";

    const initialUserMessage = [
      `A headless OpenCode agent was asked to do this task:`,
      ``,
      `--- TASK ---`,
      `${task.title}`,
      task.description ? `\n${task.description}` : ``,
      `--- END TASK ---`,
      ``,
      `OpenCode finished. Here is what it did.`,
      ``,
      `Its final message:`,
      parsed.text ? parsed.text.slice(0, 6000) : "(no final text)",
      ``,
      `Tool calls it made:`,
      toolLines || "(none)",
      ``,
      `Files it produced under the task workdir:`,
      fileLines,
      ``,
      `The OpenCode run happened in this sandbox working directory:`,
      `  ${workdirAbs}`,
      `You can inspect it with bash, e.g. \`ls -la ${workdirAbs}\` or`,
      `\`cat ${workdirAbs}/<file>\`.`,
      ``,
      `⚠ CRITICAL: \`task_complete\` is TERMINAL. The moment you call`,
      `it, you exit and CANNOT run any more tools. So you MUST do all`,
      `inspection and file collection FIRST, and call task_complete`,
      `only as your VERY LAST action. Do NOT call task_complete as a`,
      `first "let me start" step — that throws away the whole run.`,
      ``,
      `Your job has THREE parts, IN THIS ORDER:`,
      ``,
      `1) JUDGE whether the task's acceptance criteria were ACTUALLY`,
      `   met. OpenCode often exits "successfully" even when it gave`,
      `   up (couldn't install a toolchain, hit a blocked network`,
      `   request, or asked the user how to proceed). Verify with bash`,
      `   before deciding.`,
      ``,
      `2) COLLECT the deliverables into this exact directory (create`,
      `   it, then copy with bash — do this BEFORE task_complete):`,
      `     ${DELIVERABLES_ABS(workdirAbs)}`,
      `   a) FILES: the outputs may have been written ANYWHERE (the`,
      `      workdir, /tmp, a home dir, an absolute path). Find them`,
      `      (bash: ls, find, grep) and copy each into the dir:`,
      `        mkdir -p ${DELIVERABLES_ABS(workdirAbs)}`,
      `        cp <wherever-the-file-is> ${DELIVERABLES_ABS(workdirAbs)}/report.md`,
      `   b) INLINE OUTPUT: if the real deliverable is text OpenCode`,
      `      printed in its final message (a report/summary/answer)`,
      `      rather than a file — common for research/aggregation`,
      `      tasks — WRITE that content to a file in the dir yourself,`,
      `      e.g. save the full report to`,
      `      ${DELIVERABLES_ABS(workdirAbs)}/result.md using a bash`,
      `      heredoc or by cat-ing OpenCode's output file. The user`,
      `      must end up with a FILE, never just chat text.`,
      `   Include ONLY real outputs. Do NOT copy process/scaffolding:`,
      `   opencode.json, .prompt.txt, oc.out, oc.err,`,
      `   opencode-transcript.jsonl, proposal.json, or anything under`,
      `   .oc-config/ or .oc-data/.`,
      `   If there is genuinely no deliverable, leave the dir empty.`,
      ``,
      `3) REPORT via task_complete:`,
      `   - completed=true with a concise \`summary\` and a \`files\``,
      `     array listing the filenames you copied into the`,
      `     deliverables dir (just the names, e.g. ["report.md"]),`,
      `     if the work genuinely satisfies the task;`,
      `   - completed=false with a clear \`reason\` (what's missing /`,
      `     why it failed) if it does not. If it failed but produced`,
      `     partial output worth keeping, still copy it into the`,
      `     deliverables dir and list it.`,
      `Do not redo the work yourself — only judge, collect, and report.`,
    ]
      .filter((l) => l !== undefined)
      .join("\n");

    const result = await runner.run({
      userId: this.deps.ownerUserId ?? task.ownerUserId,
      signal,
      initialUserMessage,
      modelId: this.deps.defaultModel,
      // Judge-only toolset: task_complete to record the verdict,
      // read/bash to inspect artifacts. No write/edit — it judges,
      // it doesn't redo the work.
      toolsAllow: ["task_complete", "bash", "read", "list", "grep"],
      sessionTitle: `Judge: ${task.title}`.slice(0, 200),
      workerRole: this.kind,
      workerSlug: this.agentId,
      taskId: task.id,
      projectSlug: task.projectSlug,
      taskTitle: task.title || null,
    });

    // Map the agent-loop result to our TerminalUpdate. The agent's
    // task_complete call drives status; if it finished without
    // completing, treat as stalled with its reason.
    const status: TerminalUpdate["status"] =
      result.status === "done" ? "done" : "stalled";

    // DETERMINISTIC deliverable collection (do NOT trust the judge to
    // cp the right files). Before staging, the worker itself scans
    // the opencode workdir for real output files opencode wrote and
    // copies any that aren't already in .deliverables/ into it. This
    // guarantees a file opencode genuinely produced (e.g. notes.md)
    // is delivered even when the judge collected the wrong thing or
    // nothing. The judge's own cp still counts (union); scaffolding
    // is excluded.
    await this.autoCollectDeliverables(workdir, task);

    // Stage the .deliverables/ dir to the host so kanban file links
    // resolve (files plugin serves from userHomeDir; a sandbox-only
    // path 404s). Layout matches the LLM worker's SyncDownTool.
    let hostFiles = await this.stageDeliverables(workdir, task);

    // Last-resort safety net for pure "inline output" tasks (opencode
    // printed a report as its final message and wrote NO file at
    // all). If still nothing staged but there's substantial final
    // text, write it to result.md so the user gets a readable file
    // instead of a black box.
    if (hostFiles.length === 0) {
      const finalText = (parsed.text ?? "").trim();
      if (finalText.length >= 40) {
        hostFiles = await this.stageInlineFallback(workdir, task, finalText);
      }
    }

    return {
      status,
      resultSummary:
        result.summary ??
        result.reason ??
        (status === "done" ? "Task completed." : "Task not completed."),
      resultFiles: hostFiles,
    };
  }

  /**
   * DETERMINISTIC deliverable collection — program-driven, does NOT
   * trust the judge. Scan the opencode workdir for real output files
   * opencode wrote (recursively, excluding scaffolding + the
   * .deliverables dir itself) and copy any missing ones INTO
   * .deliverables/. Runs before stageDeliverables so a file opencode
   * genuinely produced is delivered even if the judge cp'd the wrong
   * thing or nothing. Union with whatever the judge already put
   * there. Best-effort; never throws into the run.
   *
   * Uses a single `find ... -exec cp` so it's one sandbox exec (no
   * newline-in-argv issues, no per-file round-trips).
   */
  private async autoCollectDeliverables(
    workdir: string,
    task: Task,
  ): Promise<void> {
    const wd = `${SANDBOX_WORKSPACE_ROOT}/${workdir}`;
    const dd = `${wd}/${DELIVERABLES_DIR}`;
    // Prune scaffolding dirs; skip scaffolding files by name; copy
    // every remaining regular file into .deliverables/, preserving
    // relative sub-path. `cp --parents` keeps out/foo.csv layout.
    // -newer guard not needed: overwrite is fine (idempotent).
    const excludeNames = [...EXCLUDED_DELIVERABLE]
      .map((n) => `! -name ${shq(n)}`)
      .join(" ");
    const cmd =
      `mkdir -p ${shq(dd)} && cd ${shq(wd)} && ` +
      `find . -type d \\( -name .deliverables -o -name .oc-config ` +
      `-o -name .oc-data \\) -prune -o ` +
      `-type f ${excludeNames} -print0 2>/dev/null | ` +
      // copy each (relative) file into .deliverables/, keeping subdirs
      `while IFS= read -r -d '' f; do ` +
      `  d=${shq(dd)}/"$(dirname "$f")"; mkdir -p "$d"; ` +
      `  cp -f "$f" "$d/"; ` +
      `done; echo AUTO_COLLECT_DONE`;
    try {
      const r = await this.deps.shell.exec({
        command: cmd,
        userId: this.deps.ownerUserId ?? task.ownerUserId,
        taskId: task.id,
        timeoutMs: 30_000,
      });
      this.deps.log.info?.("opencode-worker: auto-collected deliverables", {
        taskId: task.id,
        ok: /AUTO_COLLECT_DONE/.test(r.stdout),
      });
    } catch (err) {
      this.deps.log.warn?.(
        "opencode-worker: autoCollectDeliverables failed (non-fatal)",
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  /**
   * Sync the judge-collected deliverables directory
   * (`<workdir>/.deliverables/`) from the sandbox to the host tenant
   * workspace under `projects/<slug>/`, returning the host-relative
   * paths of the files that actually landed (for `resultFiles`).
   *
   * Why a whole directory instead of per-file paths: opencode (an
   * LLM) may write output ANYWHERE, and the judge (also an LLM) may
   * report paths in any shape. The judge's prompt instead has it
   * COPY real deliverables into a fixed collection dir with bash;
   * we then sync that one dir. This decouples "where the file ended
   * up" from "what we deliver", killing the earlier class of
   * silent-skip bugs.
   *
   * Returns [] when the dir is missing/empty. On a runtime without
   * syncDown (bind-mounted microsandbox) the files are already on
   * the host, so we just enumerate + report them.
   */
  private async stageDeliverables(
    workdir: string,
    task: Task,
  ): Promise<string[]> {
    const slug = task.projectSlug || "inbox";
    const userId = this.deps.ownerUserId ?? task.ownerUserId;
    const sandboxDir = `${workdir}/${DELIVERABLES_DIR}`;
    const guestDirAbs = `${SANDBOX_WORKSPACE_ROOT}/${sandboxDir}`;
    // Host destination is fully HOST-DERIVED from context (tenant is
    // implicit in the runner's workspaceDir; user + project + task
    // come from the task row) — the LLM never specifies it. Mirror
    // exactly the layout openshell's SyncDownTool uses for
    // LLM-worker deliverables so the files plugin + main agent read
    // it identically:
    //   <workspace>/users/<userId>/projects/<slug>/.results/<task>/
    // (files plugin roots reads at ctx.userHomeDir(userId) =
    // <workspace>/users/<userId>/; the .results/<task>/ layer keeps
    // each task's outputs together, same as sync_down.)
    const taskFolder = deriveTaskFolder(task);
    // TWO different path bases (this distinction is the fix for the
    // dead file link):
    //   - hostBase: where the file physically lands, relative to the
    //     runner's workspaceDir. Includes users/<userId>/ because the
    //     workspace root holds all users.
    //   - reportBase: what we put in result_files, which the kanban
    //     UI hands to the files plugin's /api/p/files/raw. That
    //     endpoint roots at ctx.userHomeDir(userId) = <workspace>/
    //     users/<userId>/, so the reported path must be RELATIVE to
    //     the user home — i.e. WITHOUT the users/<userId>/ prefix.
    //     Including it would resolve to users/<uid>/users/<uid>/...
    //     → 404 (the dead-link bug).
    const hostBase = `users/${userId}/projects/${slug}/.results/${taskFolder}`;
    const reportBase = `projects/${slug}/.results/${taskFolder}`;

    // Enumerate files the judge collected (relative to the
    // deliverables dir). No newlines-in-argv worries: this is one
    // find command. Missing dir → empty list.
    let files: string[] = [];
    try {
      const listed = await this.deps.shell.exec({
        command: `cd ${shq(guestDirAbs)} 2>/dev/null && find . -type f -printf '%P\\n' 2>/dev/null | head -200 || true`,
        userId: this.deps.ownerUserId ?? task.ownerUserId,
        taskId: task.id,
        timeoutMs: 20_000,
      });
      files = listed.stdout
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter((l: string) => Boolean(l))
        .filter(
          (f: string) => !f.includes("..") && !EXCLUDED_DELIVERABLE.has(f),
        );
    } catch (err) {
      this.deps.log.warn?.(
        "opencode-worker: could not list deliverables dir",
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      );
      return [];
    }
    if (files.length === 0) {
      this.deps.log.info?.("opencode-worker: no deliverables collected", {
        taskId: task.id,
        dir: guestDirAbs,
      });
      return [];
    }

    const hostRel = files.map((f) => `${hostBase}/${f}`);
    const reportRel = files.map((f) => `${reportBase}/${f}`);
    const syncDown = this.deps.shell.syncDown;
    if (!syncDown) {
      // Bind-mounted runtime: files already visible on the host.
      // Report user-home-relative paths (files-plugin root).
      return reportRel;
    }
    try {
      // Sync each collected file individually (sandbox path under
      // the collection dir → host projects/<slug>/<relative>). One
      // pair per file keeps the host layout flat under the project
      // (drops the .deliverables/ level) and lets us report exactly
      // what landed.
      const pairs = files.map((f, i) => ({
        sandbox: `${sandboxDir}/${f}`,
        host: hostRel[i],
      }));
      this.deps.log.info?.("opencode-worker: staging deliverables", {
        taskId: task.id,
        pairs,
      });
      const res = await syncDown.call(this.deps.shell, pairs);
      if (res.skipped?.length) {
        this.deps.log.warn?.(
          "opencode-worker: some deliverables failed to sync to host",
          { taskId: task.id, skipped: res.skipped },
        );
      }
      this.deps.log.info?.("opencode-worker: syncDown result", {
        taskId: task.id,
        downloaded: res.downloaded,
      });
      const downloaded = res.downloaded ?? [];
      // Report ONLY files that actually landed, and report them as
      // user-home-relative paths (reportRel) — NOT the disk-relative
      // hostRel — so the files plugin (rooted at userHomeDir)
      // resolves them. Match landed files by their hostRel suffix.
      const landedIdx = hostRel
        .map((h, i) => ({ h, i }))
        .filter(({ h }) =>
          downloaded.some((abs) => abs === h || abs.endsWith(`/${h}`)),
        )
        .map(({ i }) => i);
      return landedIdx.map((i) => reportRel[i]);
    } catch (err) {
      this.deps.log.warn?.(
        "opencode-worker: stageDeliverables syncDown failed",
        {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        },
      );
      return [];
    }
  }

  /**
   * Deterministic fallback for tasks whose real deliverable is the
   * text OpenCode printed (research/aggregation "inline" tasks), or
   * when the judge misfired and collected nothing. Writes the final
   * text to `<workdir>/.deliverables/result.md` in the sandbox
   * (via writeFile so newlines are safe — sandbox exec rejects
   * newline-in-argv), then stages the dir like any other deliverable.
   * Returns the host paths that landed. Program-driven; does not
   * depend on the judge.
   */
  private async stageInlineFallback(
    workdir: string,
    task: Task,
    finalText: string,
  ): Promise<string[]> {
    try {
      const rel = `${workdir}/${DELIVERABLES_DIR}/result.md`;
      await this.deps.shell.writeFile(rel, finalText);
      this.deps.log.info?.(
        "opencode-worker: no files collected; wrote inline final text to result.md",
        { taskId: task.id, bytes: finalText.length },
      );
      return await this.stageDeliverables(workdir, task);
    } catch (err) {
      this.deps.log.warn?.(
        "opencode-worker: inline fallback (result.md) failed",
        {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        },
      );
      return [];
    }
  }

  /** Ensure the worker session + owner user row exist once. Returns
   *  the session id (stable for the whole run so the poller and the
   *  final write target the same session). */
  private ensureSession(task: Task): string | null {
    if (this.sessionId) return this.sessionId;
    try {
      const db = this.deps.db;
      const now = Date.now();
      const sessionId = `ocs_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const userId = this.deps.ownerUserId ?? task.ownerUserId;
      // sessions.user_id FK -> users(id); dev/virtual users may not
      // be persisted, so ensure the row exists first (idempotent).
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
      // Stamp the task row's session_id NOW (run start), not at the
      // end. The Execution tab's GET /tasks/:id/history reads
      // tasks.session_id; the pool set it to the claim/agent-loop
      // session, which the opencode poller does NOT write to. Until
      // this repoint, mid-run writeHistory() lands in our ocs_
      // session but the endpoint reads the wrong one — so the tab
      // stays empty until the terminal update finally repoints it.
      // Repointing here makes the 3s frontend poll + 4s worker poll
      // actually show live progress.
      try {
        db.prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`).run(
          sessionId,
          task.id,
        );
      } catch (err) {
        this.deps.log.warn?.(
          "opencode-worker: failed to stamp task.session_id at start",
          { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
        );
      }
      this.sessionId = sessionId;
      return sessionId;
    } catch (err) {
      this.deps.log.warn?.("opencode-worker: ensureSession failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * (Re)write the session's transcript from the current parsed state.
   * Called repeatedly during the run (poller) and once at the end.
   * Idempotent: clears the session's messages and reinserts, so the
   * Execution tab reflects the latest progress. Emits, in order:
   *   - user      : the prompt
   *   - assistant : the text-so-far + tool_use parts (real args)
   *   - tool      : one tool_result per completed/errored tool so
   *                 the chips resolve (done/failed) instead of
   *                 spinning forever
   *   - system    : outcome footer (only when `final`)
   * Best-effort; never throws into the run.
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
    final: boolean,
  ): string | null {
    const sessionId = this.ensureSession(task);
    if (!sessionId) return null;
    try {
      const db = this.deps.db;
      const now = Date.now();
      db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
      const insertMsg = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      let seq = 0;
      const mk = (role: string, content: unknown) =>
        insertMsg.run(
          `ocm_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          sessionId,
          role,
          JSON.stringify({ content }),
          now + seq++,
        );

      // 1) prompt
      mk("user", buildPrompt(task));

      // 2) assistant: text + tool_use parts (real args). callId ties
      //    each tool_use to its tool_result below.
      const assistantText =
        parsed.text ||
        (parsed.tools.length
          ? `(running — ${parsed.tools.length} tool call(s) so far)`
          : final
            ? "(no output)"
            : "(running…)");
      const parts: Array<Record<string, unknown>> = [
        { type: "text", text: assistantText },
        ...parsed.tools.map((t, i) => ({
          type: "tool_use",
          id: `oc_${i}`,
          name: t.tool,
          input: t.input ?? {},
        })),
      ];
      mk("assistant", parts);

      // 3) one tool_result per finished tool (completed/error) so the
      //    UI chip resolves. Reader recognises role=tool +
      //    {role:"toolResult", toolCallId, toolName, content, isError}.
      parsed.tools.forEach((t, i) => {
        if (!t.status) return; // still running -> leave chip spinning
        insertMsg.run(
          `ocm_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          sessionId,
          "tool",
          JSON.stringify({
            role: "toolResult",
            toolCallId: `oc_${i}`,
            toolName: t.tool,
            isError: t.status === "error",
            content: t.output ?? (t.status === "error" ? "(error)" : "(done)"),
          }),
          now + seq++,
        );
      });

      // 4) outcome footer only on the final write
      if (final) {
        const outcome = res.aborted
          ? "aborted"
          : res.timedOut
            ? "timed out"
            : parsed.error
              ? `error: ${parsed.error}`
              : res.exitCode !== 0
                ? `exited ${res.exitCode ?? "?"}${res.stderr ? `: ${res.stderr.slice(0, 300)}` : ""}`
                : "completed";
        mk("system", `OpenCode run ${outcome}.`);
      }
      return sessionId;
    } catch (err) {
      this.deps.log.warn?.("opencode-worker: writeHistory failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return sessionId;
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

/** Compose the prompt handed to `opencode run` from the task.
 *
 *  When the sandbox is deny-by-default (openshell), append a short
 *  trigger telling opencode to use the `openshell-network-policy`
 *  skill on a network denial. The skill file carries the full
 *  procedure; this one-liner is what makes opencode actually reach
 *  for it (a skill is only loaded on demand). */
export function buildPrompt(
  task: Task,
  opts: { networkPolicyAdvisor?: boolean } = {},
): string {
  const parts = [task.title];
  if (task.description && task.description.trim()) {
    parts.push("", task.description.trim());
  }
  // Delivery convention: tell opencode where to put its real output
  // and to keep it separate from scratch/process files. A post-run
  // judge picks the deliverables from here and stages them to the
  // host, so files that land elsewhere (/tmp, home) won't be
  // delivered or openable by the user.
  parts.push(
    "",
    "---",
    "Deliverables: write every file the user should receive into the " +
      "CURRENT working directory (your task workdir). Use clear, final " +
      "filenames (e.g. report.md, summary.html) — not scratch names. Put " +
      "throwaway/scratch files in /tmp so they are not mistaken for " +
      "output. When you finish, end with a short note listing exactly " +
      "which files in the working directory are the deliverables.",
  );
  if (opts.networkPolicyAdvisor) {
    parts.push(
      "",
      "---",
      "Network note: this sandbox denies outbound network by default. " +
        "If a request is blocked (HTTP 403 \"CONNECT tunnel failed\", or a " +
        "`policy_denied` response), do NOT give up or report the domain as " +
        "un-allowlisted. Load the `openshell-network-policy` skill and follow " +
        "it to propose the needed egress via http://policy.local, then retry.",
    );
  }
  return parts.join("\n");
}

/** Parse OpenCode's `--format json` NDJSON stream. Collects the
 *  assistant text parts and surfaces the first session error.
 *  Each line is `{type, timestamp, sessionID, ...data}`. */
export interface OpencodeToolEvent {
  tool: string;
  /** Best-effort short arg summary (for logs). */
  detail: string;
  /** The tool's input object, when opencode reported one — used to
   *  render real args in the transcript. */
  input?: unknown;
  /** "completed" | "error" | undefined (still running). Drives the
   *  tool-result chip so the UI shows done vs. failed vs. spinner. */
  status?: string;
  /** The tool's output/result text (completed) or error (error). */
  output?: string;
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
      // opencode's ToolPart carries the args under `state.input`
      // (completed tool part). Fall back to the older/simpler spots.
      const state = (part.state ?? {}) as Record<string, unknown>;
      const input =
        state.input ?? part.input ?? part.args ?? part.arguments;
      const status =
        typeof state.status === "string" ? state.status : undefined;
      // opencode's completed tool part carries the result under
      // state.output (string) and errors under state.error.
      const outRaw =
        (typeof state.output === "string" && state.output) ||
        (typeof state.error === "string" && state.error) ||
        "";
      const output = outRaw ? outRaw.slice(0, 4000) : undefined;
      let detail = "";
      try {
        detail = input ? JSON.stringify(input).slice(0, 200) : "";
      } catch {
        detail = "";
      }
      // de-dupe: opencode emits a tool_use per state change; merge a
      // later (completed) event into an earlier arg-less one.
      const prev = tools[tools.length - 1];
      if (prev && prev.tool === tool && !prev.input && input) {
        prev.input = input;
        prev.detail = detail;
        prev.status = status ?? prev.status;
        prev.output = output ?? prev.output;
      } else {
        tools.push({ tool, detail, input, status, output });
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
  return { text: texts.join("\n\n"), error, tools };
}

/** Minimal shell single-quote escaping for embedding a string in a
 *  bash command. Wraps in single quotes; escapes embedded quotes. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
