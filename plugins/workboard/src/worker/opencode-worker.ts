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
/** Hosts opencode's `skill` tool needs to auto-download ripgrep
 *  (from GitHub releases) on first use. Opened UNCONDITIONALLY when
 *  the sandbox is deny-by-default, because without rg the skill tool
 *  errors (RipgrepDownloadFailedError) and NO skill can load. */
const RIPGREP_DL_EGRESS: Array<{ host: string; port: number }> = [
  { host: "github.com", port: 443 },
  { host: "objects.githubusercontent.com", port: 443 },
];

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

/** oh-my-openagent version, pinned to an EXACT version (never
 *  "latest"). This is critical: opencode resolves an unpinned/`@latest`
 *  plugin against the npm registry on EVERY startup (an Arborist
 *  reify + lock under ~/.cache/opencode), and in the openshell sandbox
 *  that npm resolve goes through the L7 egress proxy, which stalls it
 *  — opencode then hangs during plugin-load, before omo's code even
 *  runs (the "frozen after loading config" symptom). Pinning to an
 *  exact version that's already warmed into the sandbox image lets
 *  opencode see the cached package and SKIP the npm resolve entirely.
 *  Verified 2026-07-07: `oh-my-openagent@latest` hangs; the pinned
 *  exact version reaches the model. Keep in sync with OMO_PACKAGE in
 *  plugins/openshell/sandbox-image/Dockerfile + the warmed cache. */
const OMO_VERSION = "4.15.1";
const OMO_PLUGIN = `oh-my-openagent@${OMO_VERSION}`;

/** Absolute binary paths that may open network sockets on opencode's
 *  behalf. openshell gates egress by BOTH host:port AND the calling
 *  binary, so every egress grant must list these. Covers: the base
 *  image's root install (/usr/lib, /usr/bin, /usr/local/bin), node,
 *  npm, and — critically — our user-prefix install under the sandbox
 *  user's HOME (glob, since HOME varies: /home/sandbox, /sandbox,
 *  /root...). The `**` glob is supported by openshell binary
 *  matchers (see the community base policy). */
const OPENCODE_BINARIES = [
  // opencode 1.17.x ships a COMPILED native binary named
  // `opencode.exe` (167MB ELF); /usr/bin/opencode is a symlink to
  // it. The process that opens sockets is opencode.exe, so BOTH the
  // symlink (the exec path) and the resolved .exe MUST be
  // authorized. openshell symlink-resolves each policy binary
  // against /proc/<pid>/root; listing paths that DON'T exist in the
  // image (e.g. /usr/local/bin/opencode, .opencode,
  // /usr/bin/opencode.exe) makes it log "Cannot access container
  // filesystem for symlink resolution" WARNs and match literally,
  // which is noise and can mask the real binary. List ONLY paths
  // that actually exist in the sandbox image:
  //   /usr/bin/opencode -> ../lib/node_modules/opencode-ai/bin/opencode.exe
  "/usr/bin/opencode",
  "/usr/lib/node_modules/opencode-ai/bin/opencode.exe",
  "/usr/lib/node_modules/opencode-ai/**",
  "/usr/bin/node",
  "/usr/bin/npm",
  // user-prefix install ($HOME/.oc-npm) — HOME varies, so glob (the
  // ** also covers the nested opencode.exe there):
  "/home/*/.oc-npm/**",
  "/root/.oc-npm/**",
  "/sandbox/.oc-npm/**",
];

/** All oh-my-openagent agent names (from its config schema's
 *  `agents` keys). Every one gets pinned to our single model. */
const OMO_AGENTS = [
  "build",
  "plan",
  "sisyphus",
  "hephaestus",
  "sisyphus-junior",
  "OpenCode-Builder",
  "prometheus",
  "metis",
  "momus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "atlas",
];

/** omo delegation categories (from its orchestration docs). Pinned
 *  too, since task(category=...) routing resolves a model per
 *  category. */
const OMO_CATEGORIES = [
  "visual-engineering",
  "artistry",
  "ultrabrain",
  "deep",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
  "quick-rust",
  "quick-zig",
  "git",
];

/** Build an oh-my-opencode.jsonc that forces every omo agent +
 *  category onto a single model (our proxied tianshu model), and
 *  turns off omo's runtime model fallback (there is only one model,
 *  so a fallback chain to unavailable providers would just error).
 *  Team mode is left off (default). */
function buildOmoConfig(model: string): string {
  const agents: Record<string, { model: string }> = {};
  for (const a of OMO_AGENTS) agents[a] = { model };
  const categories: Record<string, { model: string }> = {};
  for (const c of OMO_CATEGORIES) categories[c] = { model };
  return JSON.stringify(
    {
      $schema:
        "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-opencode.schema.json",
      // one model everywhere
      agents,
      categories,
      // Only one model is reachable (single proxy provider), so
      // disable the multi-provider fallback machinery.
      model_fallback: false,
      runtime_fallback: false,
      telemetry: false,
      // THE fix for the omo "hangs after loading config" in the
      // openshell sandbox (root-caused 2026-07-07, from Yu's on-box
      // diagnostic + local repro): omo spawns an `lsp-daemon` MCP
      // subprocess (packages/lsp-daemon/dist/cli.js mcp) at startup
      // that opens a connection through the openshell L7 proxy
      // (10.200.0.1:3128) and BLOCKS waiting on it; opencode awaits
      // that MCP's startup and never reaches the main loop. Disabling
      // just the `lsp` MCP lets omo initialise and reach the model.
      // Verified locally: with disabled_mcps:["lsp"] the run logs
      // "all LSPs are disabled", Sisyphus starts, and the model
      // streams (rc=0). We keep the disabled list MINIMAL — only the
      // one MCP that deadlocks — rather than the broad disabled_*
      // block tried earlier (which didn't help and risked conflicting
      // with the plugin's agent/category init).
      disabled_mcps: ["lsp"],
    },
    null,
    2,
  );
}

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
  /** Worker session id PER TASK for the run's transcript. A single
   *  OpenCodeWorker instance is reused by the pool across many tasks
   *  (and can run several concurrently), so this MUST be keyed by
   *  task id — a shared instance field would make every task reuse
   *  the first task's session, collapsing all transcripts into one
   *  stale session (the poller + stamp would target the wrong one).
   *  Created by ensureSession(task), reused by the poller + final
   *  write for the SAME task. */
  private readonly sessionIds = new Map<string, string>();

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
        // oh-my-openagent: batteries-included opencode plugin
        // (multi-model orchestration, background agents, LSP/AST
        // tools). opencode auto-installs npm plugins via Bun at
        // startup into ~/.cache/opencode/node_modules — needs egress
        // to registry.npmjs.org, provided by the policy-advisor loop
        // (opencode self-proposes) when policyAdvisor is on.
        // oh-my-openagent is on by default. Set OPENCODE_DISABLE_OMO=1
        // to run bare opencode (no plugin) — useful to isolate whether
        // an init hang is omo's doing, and as an escape hatch.
        ...(process.env.OPENCODE_DISABLE_OMO === "1"
          ? {}
          : { plugin: [OMO_PLUGIN] }),
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
              // Rewrite host.docker.internal -> its IPv4 literal.
              // ROOT CAUSE (2026-07-07, trace-confirmed): the
              // openshell sandbox's /etc/hosts maps
              // host.docker.internal to BOTH IPv4 (192.168.65.254)
              // and IPv6 (fdc4:...::254). Bun/opencode resolve the
              // IPv6 first, but openshell only permits the first
              // /etc/hosts entry (IPv4) and REJECTS other IPs — so
              // opencode's model call never connects and the proxy
              // never even receives it ("Cannot connect to API",
              // zero opencode-proxy logs). NODE_OPTIONS=
              // --dns-result-order=ipv4first does NOT help (Node
              // flag; opencode is a Bun native binary that ignores
              // it — verified: env set, getent still returns IPv6).
              // Pinning the baseURL to the IPv4 literal avoids the
              // name resolution entirely. Docker-desktop's host
              // gateway is a stable 192.168.65.254; override via
              // OPENCODE_PROXY_HOST_IP for other setups.
              baseURL: grant.baseUrl.replace(
                "host.docker.internal",
                process.env.OPENCODE_PROXY_HOST_IP || "192.168.65.254",
              ),
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
      //
      // Version pinning matters: the openshell community base image
      // PREINSTALLS an old opencode (observed 1.2.18) that lacks the
      // websearch tool + OPENCODE_ENABLE_PARALLEL flag. A bare
      // `command -v opencode || install` would keep that stale
      // binary forever. So we install our pinned version unless the
      // installed one already matches it (idempotent, but upgrades
      // the stale preinstall).
      // Install into a USER-writable npm prefix ($HOME/.oc-npm), not
      // the root-owned global /usr/lib/node_modules (the base image's
      // preinstalled opencode lives there and the sandbox user can't
      // overwrite it -> EACCES). We then put $HOME/.oc-npm/bin first
      // on PATH in the run command so our pinned version wins over
      // the stale preinstall. Skip the install if our prefix already
      // has the right version.
      const OC_PREFIX = "$HOME/.oc-npm";
      const ocBin = `${OC_PREFIX}/bin/opencode`;

      // Installing opencode (+ later its oh-my-openagent plugin)
      // needs egress to the npm registry, and it's `npm`/`node`
      // doing the fetch, not opencode — so opencode's policy-advisor
      // self-proposal can't cover it. Pre-grant npm egress for the
      // node/npm binaries before installing. No-op on open-network
      // runtimes.
      if (this.deps.shell.allowEgress) {
        // registry.npmjs.org: npm install of opencode/plugins.
        // models.dev: opencode 1.17.13 fetches its model catalog
        //   (https://models.dev/api.json) at STARTUP; if blocked it
        //   errors before running (the model call never happens) and
        //   the run produces nothing. It's opencode itself fetching
        //   pre-run, so the policy-advisor self-proposal can't cover
        //   it — pre-grant it.
        // registry.npmjs.org: npm install. models.dev: opencode's
        // startup model-catalog fetch. mcp.*: oh-my-openagent's
        // always-on remote MCP servers (context7 docs, grep.app code
        // search, exa web search) — without egress they log
        // "server unavailable" and omo loses those capabilities.
        // NOTE: granting the mcp.* egress lets omo's always-on
        // remote MCPs CONNECT over the openshell L7 proxy — and the
        // SSE/long-poll streams those MCPs open appear to STALL
        // through the proxy MITM, hanging omo's init before it
        // reaches the model call. When they're NOT granted, the
        // MCPs fast-fail ("server unavailable") and omo proceeds
        // (verified: bare `docker run` with no MCP egress inits in
        // ~28s). So the MCP grants are gated OFF by default; set
        // OPENCODE_GRANT_OMO_MCPS=1 to re-enable them.
        const egressHosts = ["registry.npmjs.org", "models.dev"];
        if (process.env.OPENCODE_GRANT_OMO_MCPS === "1") {
          egressHosts.push(
            "mcp.context7.com",
            "mcp.grep.app",
            "mcp.exa.ai",
            "mcp.tavily.com",
          );
        }
        for (const host of egressHosts) {
          await this.deps.shell
            .allowEgress({
              host,
              port: 443,
              protocol: "https",
              binaries: [
                ...OPENCODE_BINARIES,
                "/usr/lib/node_modules/npm/bin/npm-cli.js",
              ],
            })
            .catch((err) =>
              this.deps.log.warn?.(
                "opencode-worker: npm egress grant failed (install may 403)",
                { err: err instanceof Error ? err.message : String(err) },
              ),
            );
        }
      }

      // Skip install entirely when a matching opencode is ALREADY on
      // PATH at the right version — this is the fast path for the
      // prebuilt tianshu/opencode-sandbox image, which bakes
      // opencode ${OPENCODE_VERSION} + a warmed omo plugin cache. Only
      // fall back to the user-prefix install on a bare base image
      // (where PATH's opencode is the stale preinstall).
      const ensure = await this.sh(
        `test "$(opencode --version 2>/dev/null | head -1)" = "${OPENCODE_VERSION}" || ` +
          `test "$(${ocBin} --version 2>/dev/null | head -1)" = "${OPENCODE_VERSION}" || ` +
          `npm i -g --prefix ${OC_PREFIX} opencode-ai@${OPENCODE_VERSION}`,
        task,
        signal,
        5 * 60_000,
      );
      if (ensure.exitCode !== 0 && !ensure.aborted) {
        return {
          status: "stalled",
          resultSummary:
            `FAILED [SETUP]: could not install opencode in the sandbox ` +
            `(exit ${ensure.exitCode})— opencode never ran. Likely a ` +
            `sandbox/network/npm issue, not a task problem.` +
            (ensure.stderr
              ? `\n\nstderr: ${ensure.stderr.slice(0, 500)}`
              : ""),
        };
      }
      if (ensure.aborted) {
        return {
          status: "aborted",
          resultSummary:
            "FAILED [ABORTED]: cancelled during opencode install (signal).",
        };
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

      // oh-my-openagent config: pin EVERY omo agent + category to our
      // single proxied model. omo's built-in fallback chains list
      // provider names like anthropic/openai/google — none of which
      // is our "tianshu" proxy provider, so out of the box omo can't
      // resolve any model and its agents don't work. Writing an
      // oh-my-opencode config that sets model=tianshu/<model> on all
      // agents + categories forces everything onto the one model we
      // expose (Yu: "first configure them all to the same one").
      // omo reads `.opencode/oh-my-opencode.jsonc`; with
      // OPENCODE_CONFIG=./opencode.json + XDG_CONFIG_HOME=./.oc-config
      // we cover both the project-relative and XDG locations.
      if (process.env.OPENCODE_DISABLE_OMO !== "1") {
        const omoModel = `tianshu/${nativeModelId}`;
        const omoConfigJson = buildOmoConfig(omoModel);
        for (const rel of [
          `${workdir}/.opencode/oh-my-opencode.jsonc`,
          `${workdir}/.oc-config/opencode/oh-my-opencode.jsonc`,
        ]) {
          await this.deps.shell
            .writeFile(rel, omoConfigJson)
            .catch(() => undefined);
        }
      }

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
          // Grant egress for the SAME host opencode actually dials.
          // We rewrite host.docker.internal -> its IPv4 literal in
          // the provider baseURL (see the provider block above: the
          // sandbox resolves the name to IPv6 which openshell
          // rejects), so the egress endpoint must be granted for
          // that IPv4 too — otherwise the endpoint is authorized for
          // the name while opencode connects to the IP and gets
          // policy_denied. Keep them in sync.
          const egressHost =
            u.hostname === "host.docker.internal"
              ? process.env.OPENCODE_PROXY_HOST_IP || "192.168.65.254"
              : u.hostname;
          // openshell gates egress by BOTH host:port AND the
          // requesting binary, so authorize opencode + its node
          // runtime. Without these the endpoint registers but every
          // request is denied (403 policy_denied).
          await this.deps.shell.allowEgress({
            host: egressHost,
            port,
            protocol: u.protocol === "https:" ? "https" : "http",
            binaries: OPENCODE_BINARIES,
          });
        } catch (err) {
          this.deps.log.warn?.(
            "opencode-worker: allowEgress failed (continuing; run may 403)",
            { err: err instanceof Error ? err.message : String(err) },
          );
        }

        // opencode's `skill` tool needs ripgrep, which it
        // auto-downloads from GitHub releases on first use. On a
        // deny-by-default sandbox that download is blocked ->
        // RipgrepDownloadFailedError -> the skill tool ERRORS (it
        // can't load ANY skill, incl. our openshell-network-policy
        // one — opencode then falls back to reading the file, but the
        // skill tool itself is broken). Open egress to the ripgrep
        // download hosts unconditionally (not just under enableLsp)
        // so skills work. opencode/bun opens the socket, so authorize
        // those binaries too (incl. the real .opencode bun binary).
        for (const ep of RIPGREP_DL_EGRESS) {
          try {
            await this.deps.shell.allowEgress({
              host: ep.host,
              port: ep.port,
              protocol: "https",
              binaries: [
                "/usr/bin/node",
                "/usr/lib/node_modules/opencode-ai/bin/opencode",
                "/usr/lib/node_modules/opencode-ai/bin/.opencode",
                "/usr/bin/opencode",
              ],
            });
          } catch (err) {
            this.deps.log.warn?.(
              "opencode-worker: ripgrep egress grant failed (skill tool may fail)",
              { err: err instanceof Error ? err.message : String(err) },
            );
          }
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
      // Resume awareness: on a re-claim after task_continue
      // (attempts>0) the workdir is REUSED (same taskId, mkdir -p not
      // rm -rf), so a prior attempt's partial files are still here.
      // opencode gets a fresh prompt though, so unless we tell it,
      // it has no idea prior work exists and may restart from
      // scratch. List the surviving non-scaffolding files and hand
      // them to the prompt so opencode continues instead of redoing.
      let priorFiles: string[] = [];
      if ((task.attempts ?? 0) > 0) {
        priorFiles = await this.listPriorWorkdirFiles(workdir, task);
      }
      const prompt = buildPrompt(task, {
        networkPolicyAdvisor: Boolean(this.deps.shell.allowEgress),
        priorFiles,
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
        // Clear stale opencode/omo lock dirs before each run. Harmless
        // hygiene (SIGKILL'd prior runs can leave lock files), though
        // NOTE (2026-07-06): clearing these does NOT fix the omo
        // init-hang in the openshell sandbox — that hang is an omo
        // init busy-loop spawning `sh -c` ~1/s (only inside the
        // openshell-supervised container; a bare `docker run` of the
        // same image runs fine). Still under investigation.
        `rm -rf .oc-data/opencode/locks ` +
        `"$HOME/.local/state/opencode/locks" ` +
        `"$HOME/.omo"/*/locks ` +
        `/sandbox/.local/state/opencode/locks ` +
        `/sandbox/.omo/*/locks 2>/dev/null; ` +
        // Put our user-prefix opencode first so it wins over the
        // base image's stale root-installed one.
        `export PATH="$HOME/.oc-npm/bin:$PATH" && ` +
        `XDG_CONFIG_HOME="$PWD/.oc-config" ` +
        `XDG_DATA_HOME="$PWD/.oc-data" ` +
        // Block LSP auto-download unless the worker enabled LSP (and
        // opened the egress for it above).
        (this.deps.enableLsp ? `` : `OPENCODE_DISABLE_LSP_DOWNLOAD=1 `) +
        // Enable opencode's built-in web_search tool. Without a flag
        // it's filtered OUT of the toolset unless the model provider
        // is opencode's own (registry.ts webSearchEnabled: providerID
        // === opencode || flags.exa || flags.parallel). Our provider
        // is "tianshu", so web_search would be absent (the observed
        // "web_search not available"). Parallel is key-free (same
        // backend tianshu's web-search plugin uses), so enable it;
        // egress to search.parallel.ai is handled by the policy
        // advisor loop (opencode self-proposes on first denial) when
        // policyAdvisor is on.
        `OPENCODE_ENABLE_PARALLEL=1 ` +
        // Disable oh-my-openagent's anonymous PostHog telemetry. In
        // the locked sandbox the telemetry POST to us.i.posthog.com
        // is egress-denied (policy_denied 403), which spams the run
        // output with PostHogFetchHttpError stack traces (harmless
        // but noisy). omo only sends telemetry when this is exactly
        // "yes"; any other value disables it.
        `OMO_SEND_ANONYMOUS_TELEMETRY=no ` +
        // ROOT-CAUSE FIX for the omo "hang after loading config" in
        // the openshell sandbox (2026-07-06): opencode 1.17.x fetches
        // https://models.dev/api.json at startup for its (optional)
        // model catalog. Egress to models.dev IS granted, but the
        // CONNECT is made THROUGH the openshell L7 proxy, and in the
        // gRPC-exec-tunnelled run that proxied connection STALLS
        // (never completes, never errors) — opencode's plugin init
        // blocks on it forever, right after "loading opencode.jsonc",
        // before the model call. (Isolation: the identical run via a
        // direct `docker exec` completes; only the tunnelled path
        // hangs; the single stuck socket is to models.dev's fakeip.)
        // We don't need models.dev at all — the model + its metadata
        // come from our tianshu provider config — so disable the
        // startup fetch. Verified: with this set the sandbox log
        // shows ZERO models.dev references and omo reaches the model.
        `OPENCODE_DISABLE_MODELS_FETCH=1 ` +
        `OPENCODE_CONFIG=./opencode.json ` +
        // Widen NO_PROXY to include 0.0.0.0 (opencode's embedded
        // server binds 0.0.0.0:<port>); harmless hygiene so any
        // loopback fetch stays direct. NOTE: this alone does NOT fix
        // the omo hang — root cause is the openshell gRPC exec
        // tunnel (see the detached-launch handling below), not the
        // proxy env (verified: identical proxy env via `docker exec`
        // inits fine; only the tunnelled foreground exec hangs).
        // UNSET all proxy env for opencode (root-cause fix,
        // 2026-07-07). The openshell sandbox injects
        // NODE_USE_ENV_PROXY=1 + HTTP(S)_PROXY=10.200.0.1:3128 so
        // guest tools egress through the L7 policy proxy. But once
        // models.dev fetch is disabled and omo's lsp MCP is off,
        // opencode makes NO outbound egress that needs the proxy —
        // it only talks to the tianshu model proxy at
        // host.docker.internal:3303 and its own embedded server on
        // localhost, both of which must be DIRECT. Under
        // NODE_USE_ENV_PROXY, Bun routes even those through the L7
        // proxy (NO_PROXY isn't honoured for host.docker.internal /
        // the random-port loopback URL), the proxy can't reach the
        // docker host gateway, and opencode reports "Cannot connect
        // to API" — even though a direct curl to the same URL from
        // the sandbox works. Clearing the proxy env makes opencode
        // connect directly. Verified: with the proxy env unset the
        // run reaches the model and returns (rc=0). (Real egress
        // like the npm/omo warmup already happened at image build
        // time, so nothing at task-run time needs the proxy.)
        `NODE_USE_ENV_PROXY= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= GRPC_PROXY= ` +
        `http_proxy= https_proxy= all_proxy= grpc_proxy= ` +
        `NO_PROXY=127.0.0.1,localhost,::1,0.0.0.0,host.docker.internal ` +
        `no_proxy=127.0.0.1,localhost,::1,0.0.0.0,host.docker.internal ` +
        // Force IPv4 DNS resolution (root-cause fix for "Cannot
        // connect to API", 2026-07-07, from `openshell logs` trace).
        // The sandbox's /etc/hosts maps host.docker.internal to BOTH
        // an IPv4 (192.168.65.254) and an IPv6 (fdc4:...::254)
        // address. Node/Bun default to resolving the IPv6 one first,
        // but openshell's supervisor only allows the FIRST /etc/hosts
        // entry (IPv4) and REJECTS connections to any other IP
        // (logged: "host.openshell.internal has 2 distinct IPs ...
        // Connections resolving to any other IP will be rejected").
        // So opencode's model call to the tianshu proxy resolves to
        // IPv6 -> openshell rejects it -> "Cannot connect to API"
        // (while a curl that happens to pick IPv4 works). Pinning DNS
        // to ipv4first makes opencode use the allowed IPv4 address.
        `NODE_OPTIONS=--dns-result-order=ipv4first ` +
        `timeout -s KILL ${capS} ` +
        // --auto: auto-approve any permission that isn't explicitly
        // denied. Headless runs have nobody to answer an interactive
        // permission prompt; omo requests some permissions as `ask`
        // (doom_loop / external_directory), and an unanswered `ask`
        // hangs the run forever. --auto answers them automatically.
        `opencode run --auto --model tianshu/${nativeModelId} --format json ` +
        // No --agent: oh-my-openagent already registers its Sisyphus
        // orchestrator as the DEFAULT primary agent, so a plain
        // headless `run` uses Sisyphus automatically (verified: the
        // agent self-reports as "Sisyphus"). Passing --agent sisyphus
        // is wrong — that's not a valid --agent id (opencode logs
        // 'agent not found, falling back to default') and only
        // pollutes stderr.
        // TRUE resume: opencode persists its session (conversation +
        // tool history) in .oc-data/opencode (opencode.db + storage/),
        // which lives under the reused per-task workdir and survives
        // across attempts. On a re-claim (attempts>0) pass
        // `--continue` so opencode restores the LAST session and
        // continues the actual conversation — not just the files.
        // First attempt: no `--continue`, fresh session. (.oc-data is
        // per-task, so `--continue`=last session is unambiguous.)
        ((task.attempts ?? 0) > 0 ? `--continue ` : ``) +
        `< .prompt.txt > oc.out 2> oc.err ; ` +
        // Capture opencode's REAL exit code before the trailing
        // `cat` so the failure classifier sees a killed/OOM/timed-out
        // run instead of cat's always-0 exit.
        `rc=$? ; cat oc.out ; exit $rc`;

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

      // DIAG (2026-07-08): log the FULL command the worker hands to
      // openshell, so we can diff it against a manual
      // `openshell sandbox exec ... opencode run` that works.
      this.deps.log.info?.("opencode-worker: RUN cmd", { workdir, cmd });
      let res: Awaited<ReturnType<typeof this.sh>>;
      const runStartedAt = Date.now();
      try {
        res = await this.sh(cmd, task, signal, this.deps.timeoutMs);
      } finally {
        polling = false;
        clearInterval(pollTimer);
      }
      const runElapsedMs = Date.now() - runStartedAt;
      // Sandbox-side hard cap (the `timeout -s KILL ${capS}` wrapper).
      const sandboxCapMs = capS * 1000;
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
      // straight away, with a CLEAR labeled reason so the operator
      // can tell WHY a task died (timeout vs OOM vs signal vs crash)
      // instead of a bare exit code.
      if (res.aborted) {
        return {
          status: "aborted",
          resultSummary:
            "FAILED [ABORTED]: the run was cancelled by a signal " +
            "(host abort / pool stop / watchdog)." +
            failureEvidence(res, runElapsedMs, sandboxCapMs),
          sessionId,
        };
      }
      if (res.timedOut) {
        return {
          status: "stalled",
          resultSummary:
            `FAILED [TIMEOUT — host budget]: exceeded the worker's ` +
            `${this.deps.timeoutMs ?? 20 * 60_000}ms budget and was ` +
            `killed host-side.` +
            failureEvidence(res, runElapsedMs, sandboxCapMs),
          sessionId,
        };
      }
      // Hard infra failure the judge CANNOT salvage: opencode was
      // killed by a signal (137 SIGKILL / 139 SIGSEGV / 143 SIGTERM)
      // or exited non-zero having produced essentially nothing. Give
      // the clear labeled reason (timeout-cap vs OOM/kill vs crash)
      // and return BEFORE the judge — running the judge on a
      // killed/empty run just produces a vague "no output" verdict
      // that hides the real cause (the whole point: 任务退出要有明显原因).
      const killedSignal =
        res.exitCode === 137 ||
        res.exitCode === 139 ||
        res.exitCode === 143;
      const producedNothing = (res.stdout ?? "").trim().length === 0;
      if (res.exitCode !== 0 && (killedSignal || producedNothing)) {
        return {
          status: "stalled",
          resultSummary:
            classifyOpencodeExit(res, runElapsedMs, sandboxCapMs) +
            (res.stderr ? `\n\nstderr: ${res.stderr.slice(0, 500)}` : ""),
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
          resultSummary: `FAILED [OPENCODE ERROR]: ${parsed.error}`,
          resultFiles: files,
          sessionId,
        };
      }
      if (res.exitCode !== 0) {
        return {
          status: "stalled",
          resultSummary:
            classifyOpencodeExit(res, runElapsedMs, sandboxCapMs) +
            (parsed.text ? `\n\n${parsed.text.slice(0, 400)}` : "") +
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
      // Drop the per-task session cache entry so the Map doesn't grow
      // unbounded over a long-lived worker instance's lifetime.
      this.sessionIds.delete(task.id);
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
      `You are the JUDGE. Your ONLY job is to decide whether the task`,
      `above was actually accomplished, then record that verdict with`,
      `ONE call to task_complete. (Deliverable files are collected`,
      `automatically by the system — you do NOT need to copy any
      files.)`,
      ``,
      `You already have strong evidence above: OpenCode's final`,
      `message, its tool calls, and the files it produced. In most`,
      `cases that is enough to judge directly — so judge and record`,
      `your verdict NOW.`,
      ``,
      `Optional: you have read-only tools (bash/read/ls/grep) if you`,
      `want to spot-check a produced file before deciding. Use them`,
      `ONLY if the evidence above is genuinely insufficient.`,
      ``,
      `⚠ HOW TO FINISH — read carefully:`,
      `• task_complete is a TERMINAL VERDICT, not a "let me start"`,
      `  action. Calling it ends you immediately.`,
      `• Its \`summary\` must BE the verdict itself — e.g.`,
      `  "Created hello.txt with the required line; task met." or`,
      `  "Failed: OpenCode hit a 403 and produced no report."`,
      `• NEVER pass a process phrase like "inspecting...", "let me`,
      `  check first", or "need to use bash" as the summary — that is`,
      `  not a verdict and wastes the run.`,
      `• If you want to inspect first, call bash/read FIRST, then`,
      `  task_complete once. If you don't need to inspect, just call`,
      `  task_complete with your verdict now.`,
      ``,
      `Record the verdict:`,
      `  - completed=true  + a concise \`summary\` stating WHAT was`,
      `    delivered and that it meets the task, when the work`,
      `    genuinely satisfies it;`,
      `  - completed=false + a \`summary\`/\`reason\` naming exactly`,
      `    what's missing or why it failed, when it does not.`,
      `Do not redo the work yourself — only judge and record.`,
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

    // Merge the judge's own transcript into the opencode session so
    // ONE task log shows both: opencode's work, then the judge's
    // verdict process. The judge runs in its own `Judge:` session
    // (result.sessionId); copy its messages into the opencode ocs_
    // session (which tasks.session_id points at) behind a divider.
    this.appendJudgeTranscript(task, result.sessionId);

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
   * List the non-scaffolding files already present in the reused
   * workdir (a prior attempt's partial work). Used to tell opencode
   * on resume that prior output exists so it continues rather than
   * restarting. Best-effort; returns [] on any error or empty dir.
   */
  private async listPriorWorkdirFiles(
    workdir: string,
    task: Task,
  ): Promise<string[]> {
    try {
      const abs = `${SANDBOX_WORKSPACE_ROOT}/${workdir}`;
      const listed = await this.deps.shell.exec({
        command:
          `cd ${shq(abs)} 2>/dev/null && find . -type d \\( ` +
          `-name .deliverables -o -name .oc-config -o -name .oc-data ` +
          `-o -name __pycache__ -o -name .pytest_cache -o -name .git ` +
          `-o -name node_modules \\) -prune -o -type f -printf '%P\\n' ` +
          `2>/dev/null | head -100 || true`,
        userId: this.deps.ownerUserId ?? task.ownerUserId,
        taskId: task.id,
        timeoutMs: 15_000,
      });
      return listed.stdout
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter(
          (f: string) =>
            Boolean(f) &&
            !f.includes("..") &&
            !EXCLUDED_DELIVERABLE.has(f) &&
            !f.endsWith(".pyc"),
        );
    } catch {
      return [];
    }
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
    // Prune scaffolding + build/cache dirs (they're not deliverables
    // and pollute the result set — observed __pycache__/.pytest_cache
    // sweeping in). Skip scaffolding files by name + junk file
    // patterns (*.pyc etc). Copy every remaining regular file into
    // .deliverables/, preserving relative sub-path.
    const pruneDirNames = [
      DELIVERABLES_DIR,
      ".oc-config",
      ".oc-data",
      "__pycache__",
      ".pytest_cache",
      ".mypy_cache",
      ".ruff_cache",
      ".git",
      "node_modules",
      ".venv",
      "venv",
      ".tox",
      "dist",
      "build",
      "target",
      ".next",
      ".cache",
    ];
    const pruneExpr = pruneDirNames
      .map((n) => `-name ${shq(n)}`)
      .join(" -o ");
    const excludeNames = [
      ...[...EXCLUDED_DELIVERABLE].map((n) => `! -name ${shq(n)}`),
      "! -name '*.pyc'",
      "! -name '*.pyo'",
      "! -name '*.class'",
      "! -name '.DS_Store'",
    ].join(" ");
    const cmd =
      `mkdir -p ${shq(dd)} && cd ${shq(wd)} && ` +
      `find . -type d \\( ${pruneExpr} \\) -prune -o ` +
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
    const cached = this.sessionIds.get(task.id);
    if (cached) return cached;
    try {
      const db = this.deps.db;
      const now = Date.now();
      // NOTE on resume: each opencode attempt is a genuinely fresh
      // `opencode run` process (opencode can't resume its own LLM
      // context from our DB), so we mint a NEW transcript session per
      // attempt rather than reuse task.sessionId. Reusing it would be
      // wrong here because writeHistory() DELETEs+rewrites the session
      // from the CURRENT run's oc.out — which doesn't contain the
      // prior attempt — so reuse would erase attempt N-1's log. The
      // real cross-attempt continuity for opencode is the REUSED
      // WORKDIR (opencode/<taskId>, same id across attempts) whose
      // prior files survive; the continuation hint in the prompt
      // tells opencode to build on them.
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
      this.sessionIds.set(task.id, sessionId);
      return sessionId;
    } catch (err) {
      this.deps.log.warn?.("opencode-worker: ensureSession failed", {
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Append the judge's transcript into the opencode session so the
   * task's Execution tab shows ONE stream: opencode's work, a
   * divider, then the judge's verdict process (its reasoning +
   * inspect tool calls + the final task_complete). The judge ran in
   * its own `Judge:` session (judgeSessionId); we copy those rows
   * into the opencode ocs_ session (the one tasks.session_id points
   * at). Best-effort; never throws into the run.
   */
  private appendJudgeTranscript(
    task: Task,
    judgeSessionId: string | undefined,
  ): void {
    if (!judgeSessionId) return;
    const ocsId = this.sessionIds.get(task.id);
    if (!ocsId || ocsId === judgeSessionId) return;
    try {
      const db = this.deps.db;
      const rows = db
        .prepare(
          `SELECT role, content FROM messages
             WHERE session_id = ? AND role != 'user'
             ORDER BY created_at`,
        )
        .all(judgeSessionId) as { role: string; content: string }[];
      if (!rows.length) return;
      const base = Date.now();
      let seq = 0;
      const insert = db.prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      // Divider so the tab visibly separates work from verdict.
      insert.run(
        `ocm_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        ocsId,
        "system",
        JSON.stringify({ content: "── Judge (verdict) ──" }),
        base + seq++,
      );
      // Skip the judge's giant initial prompt (role=user, excluded
      // by the query) — it's the whole opencode transcript re-fed to
      // the judge, redundant here. Copy the judge's assistant/tool
      // rows verbatim so tool chips + reasoning render the same way.
      for (const r of rows) {
        insert.run(
          `ocm_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          ocsId,
          r.role,
          r.content,
          base + seq++,
        );
      }
      this.deps.log.info?.("opencode-worker: appended judge transcript", {
        taskId: task.id,
        judgeRows: rows.length,
      });
    } catch (err) {
      this.deps.log.warn?.(
        "opencode-worker: appendJudgeTranscript failed (non-fatal)",
        { taskId: task.id, err: err instanceof Error ? err.message : String(err) },
      );
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
    parsed: {
      text: string;
      error?: string;
      tools: OpencodeToolEvent[];
      timeline?: OpencodeTimelineNode[];
    },
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

      // 2+3) Walk the STREAM-ORDER timeline so text and tool calls
      //    render interleaved (say → call → result → say → call …),
      //    the way opencode actually produced them — NOT "one big
      //    text block then a wall of tool chips" (the old grouped
      //    layout). Each text node -> an assistant text message.
      //    Each tool node -> an assistant message carrying that one
      //    tool_use, immediately followed by its tool_result so the
      //    chip resolves next to where it was called.
      const timeline = parsed.timeline ?? [];
      const mkToolResult = (t: OpencodeToolEvent, id: string) => {
        if (!t.status) return; // still running -> leave chip spinning
        insertMsg.run(
          `ocm_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          sessionId,
          "tool",
          JSON.stringify({
            role: "toolResult",
            toolCallId: id,
            toolName: t.tool,
            isError: t.status === "error",
            content:
              t.output ?? (t.status === "error" ? "(error)" : "(done)"),
          }),
          now + seq++,
        );
      };
      if (timeline.length === 0) {
        // No structured events yet (very start of run, or parse
        // produced nothing): show a placeholder so the tab isn't
        // blank.
        mk("assistant", [
          {
            type: "text",
            text: parsed.text || (final ? "(no output)" : "(running…)"),
          },
        ]);
      } else {
        for (const node of timeline) {
          if (node.kind === "text") {
            mk("assistant", [{ type: "text", text: node.text }]);
          } else {
            const id = `oc_${node.index}`;
            mk("assistant", [
              {
                type: "tool_use",
                id,
                name: node.tool.tool,
                input: node.tool.input ?? {},
              },
            ]);
            mkToolResult(node.tool, id);
          }
        }
      }

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
  opts: { networkPolicyAdvisor?: boolean; priorFiles?: string[] } = {},
): string {
  const parts = [task.title];
  if (task.description && task.description.trim()) {
    parts.push("", task.description.trim());
  }
  // Resume: a prior attempt left partial work in this same working
  // directory. Tell opencode it exists so it CONTINUES from it
  // instead of starting over (it gets a fresh conversation each
  // attempt and would otherwise not know).
  if (opts.priorFiles && opts.priorFiles.length) {
    parts.push(
      "",
      "---",
      "Resuming a previous attempt. Files from your earlier work are " +
        "ALREADY in the current working directory — inspect and BUILD ON " +
        "them rather than starting from scratch:",
      ...opts.priorFiles.slice(0, 50).map((f) => `- ${f}`),
      "Read what's there first (e.g. `ls -la`, `cat <file>`), keep what's " +
        "correct, and only redo what's missing or wrong.",
    );
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

/** One node in the assistant's turn timeline, in STREAM ORDER, so the
 *  transcript renders text and tool calls interleaved the way
 *  opencode actually produced them (say → call → say → call) rather
 *  than "all text, then all tools". */
export type OpencodeTimelineNode =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: OpencodeToolEvent; index: number };

export function parseOpencodeEvents(stdout: string): {
  text: string;
  error?: string;
  /** Tool calls opencode made, in order — for the history view. */
  tools: OpencodeToolEvent[];
  /** Text + tool events in original stream order (interleaved). */
  timeline: OpencodeTimelineNode[];
} {
  const texts: string[] = [];
  const tools: OpencodeToolEvent[] = [];
  const timeline: OpencodeTimelineNode[] = [];
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
        const t = part.text.trim();
        texts.push(t);
        // Merge consecutive text nodes (opencode streams a text part
        // in deltas) so we don't fragment one message into many.
        const last = timeline[timeline.length - 1];
        if (last && last.kind === "text") last.text += `\n\n${t}`;
        else timeline.push({ kind: "text", text: t });
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
        // prev is already the last tool node in the timeline; the
        // merge above updated it in place (same object reference).
      } else {
        const ev2: OpencodeToolEvent = { tool, detail, input, status, output };
        tools.push(ev2);
        timeline.push({ kind: "tool", tool: ev2, index: tools.length - 1 });
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
  return { text: texts.join("\n\n"), error, tools, timeline };
}

/** Minimal shell single-quote escaping for embedding a string in a
 *  bash command. Wraps in single quotes; escapes embedded quotes. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface OcExitInfo {
  exitCode: number;
  stderr?: string;
}

/** Compact evidence line appended to every failure summary so the
 *  operator can see the raw signals behind the label. */
function failureEvidence(
  res: OcExitInfo,
  elapsedMs: number,
  capMs: number,
): string {
  return (
    `\n\n[evidence] exit=${res.exitCode} ` +
    `elapsed=${Math.round(elapsedMs / 1000)}s ` +
    `sandboxCap=${Math.round(capMs / 1000)}s`
  );
}

/**
 * Turn a non-zero opencode exit into a CLEAR, LABELED failure reason
 * so the operator knows WHY a task died. Distinguishes:
 *   [TIMEOUT — sandbox cap]  exit 137 (SIGKILL), elapsed ≈ the
 *                           in-sandbox `timeout -s KILL Ns` cap.
 *   [OUT OF MEMORY / KILLED] exit 137 killed WELL BEFORE the cap →
 *                           kernel OOM-killer / external kill (we
 *                           can't read the sandbox cgroup
 *                           memory.events — denied inside — so we
 *                           infer from timing + stderr).
 *   [CRASH SIGSEGV] 139, [TERMINATED SIGTERM] 143, [TIMEOUT] 124,
 *   [exited N] otherwise. stderr is scanned for explicit OOM strings
 *   first, which upgrades the guess to a certainty.
 */
export function classifyOpencodeExit(
  res: OcExitInfo,
  elapsedMs: number,
  capMs: number,
): string {
  const err = (res.stderr ?? "").toLowerCase();
  const oomStr =
    /out of memory|oom|cannot allocate memory|killed process|std::bad_alloc|javascript heap out of memory/.test(
      err,
    );
  const ev = failureEvidence(res, elapsedMs, capMs);
  if (res.exitCode === 137) {
    if (oomStr) {
      return `FAILED [OUT OF MEMORY]: opencode was OOM-killed (SIGKILL; stderr names it).${ev}`;
    }
    if (capMs > 0 && elapsedMs >= capMs - 15_000) {
      return `FAILED [TIMEOUT — sandbox cap]: opencode ran past the ${Math.round(
        capMs / 1000,
      )}s in-sandbox cap and was killed (SIGKILL).${ev}`;
    }
    return `FAILED [OUT OF MEMORY / KILLED]: opencode was SIGKILLed ${Math.round(
      elapsedMs / 1000,
    )}s in — well before the ${Math.round(
      capMs / 1000,
    )}s timeout cap, so the likely cause is the OOM-killer (or an external kill), not a timeout.${ev}`;
  }
  if (oomStr) {
    return `FAILED [OUT OF MEMORY]: stderr indicates an out-of-memory condition.${ev}`;
  }
  if (res.exitCode === 139) {
    return `FAILED [CRASH — SIGSEGV]: opencode segfaulted (exit 139).${ev}`;
  }
  if (res.exitCode === 143) {
    return `FAILED [TERMINATED — SIGTERM]: opencode was terminated (exit 143).${ev}`;
  }
  if (res.exitCode === 124) {
    return `FAILED [TIMEOUT]: the timeout wrapper expired (exit 124).${ev}`;
  }
  return `FAILED [exited ${res.exitCode}]: opencode exited non-zero.${ev}`;
}
