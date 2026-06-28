// OpenShell SandboxRunner.
//
// Backed by NVIDIA OpenShell (Apache-2.0, https://github.com/NVIDIA/OpenShell).
// Owns one Docker-container sandbox per tenant ("tianshu-<tenant>").
//
// The plugin spins up its own openshell-gateway child process so the
// install footprint is "drop the binaries on PATH" rather than "set
// up a system service". GatewayManager handles cert generation +
// gateway.toml + sandbox supervisor's mTLS chain. This file only
// cares about the SandboxRunner contract: exec, file IO, lifecycle,
// status.
//
// Authentication wiring:
//   - The plugin generates an mTLS PKI on first start (CA + server +
//     client + JWT signing key) under <stateDir>/certs/.
//   - The gateway listens on https://0.0.0.0:<port> with the server
//     cert + client CA, gates incoming RPCs on the client cert.
//   - The CLI talks to the gateway over loopback https; we point
//     `OPENSHELL_GATEWAY_*` env at it for every CLI invocation so
//     we don't depend on `openshell gateway add` having been run.
//   - The sandbox supervisor inside the container talks back over
//     https://host.openshell.internal:<port> using the same CA +
//     a sibling client cert injected by the docker driver via the
//     `guest_tls_*` config keys (set by GatewayManager).
//
// Workspace:
//   - We do NOT bind-mount the tenant workspace into the
//     container. We tried (mount at /workspace and at
//     /sandbox/workspace, with default policy and a custom
//     policy that listed the target under `read_write`); in
//     every case OpenShell's Landlock layer denies sandbox-uid
//     access through the fakeowner mount that wraps host bind
//     mounts. The policy's `read_write` list is matched against
//     the in-sandbox filesystem entries the supervisor sets up,
//     not arbitrary kernel mounts the docker driver attaches.
//   - Instead, writeFile / readFile go through `openshell
//     sandbox upload` / `download`, targeting `/sandbox/<path>`
//     inside the container. /sandbox is the policy's blessed
//     read-write workdir; uploads land there with sandbox:sandbox
//     ownership and the supervisor enforces tenant isolation
//     (each tenant has its own sandbox container).
//   - This costs us a CLI round-trip per readFile/writeFile vs.
//     a direct host fs poke, but the savings are negligible at
//     human-scale tool calls (< 200ms incl. CLI cold start), and
//     we keep OpenShell's policy story intact — no custom
//     policy YAML required, no fakeowner-Landlock fights.

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  ExecRequest,
  ExecResult,
  PluginContext,
  SandboxRunner,
  SandboxStatus,
} from "@tianshu-ai/plugin-sdk";
import {
  GatewayManager,
  type GatewayHandle,
} from "./gateway-manager.js";

export interface OpenShellRunnerOpts {
  /** Tenant id; used to derive sandbox name + state dir. */
  tenantId: string;
  /** Host-side absolute path to this tenant's workspace dir. Bind-
   *  mounted into the container at /workspace. */
  workspaceDir: string;
  /** Per-plugin state directory (cert dir, gateway.toml, sqlite db,
   *  gateway log). Survives plugin reloads; safe to `rm -rf` on
   *  uninstall. */
  stateDir: string;
  /** Loopback port the embedded gateway listens on. Default 17670
   *  (matches openshell upstream); can be overridden via plugin
   *  config when two installs share a host. */
  port?: number;
  /** Override the `openshell` binary path. Default: $PATH. */
  openshellBin?: string;
  /** Override the `openshell-gateway` binary path. Default: $PATH. */
  gatewayBin?: string;
  /** Sandbox `--from` source. Defaults to OpenShell Community's
   *  `base` image (python + node + git + standard CLI). */
  fromImage?: string;
  log: PluginContext["log"];
}

type RunnerState = "starting" | "ready" | "running" | "error" | "stopped";

/** Path inside the sandbox container where tenant files live.
 *  `/sandbox` is OpenShell's policy-blessed read-write workdir;
 *  sub-paths inherit `read_write` so uploads/downloads to
 *  /sandbox/<x> work under the default policy without extra
 *  rules. We pick a `workspace/` sub-dir to keep the tenant
 *  tree visually separated from sandbox-supervisor artefacts
 *  (`.agents`, `.claude`, `.venv`, etc. all live at /sandbox/). */
const SANDBOX_WORKSPACE_PATH = "/sandbox/workspace";

export class OpenShellRunner implements SandboxRunner {
  readonly id = "openshell.main";
  readonly kind = "shell" as const;

  private state: RunnerState = "stopped";
  private lastError: string | undefined;
  private startedAt: number = 0;
  private readonly sandboxName: string;
  private readonly opts: OpenShellRunnerOpts & { port: number };
  private readonly gateway: GatewayManager;
  private gatewayHandle: GatewayHandle | null = null;

  constructor(opts: OpenShellRunnerOpts) {
    this.opts = {
      ...opts,
      port: opts.port ?? 17670,
    };
    // Sandbox names use the same alphabet OpenShell accepts (alnum +
    // dash, ≤ 64 chars). Tenant ids already obey that on the tianshu
    // side; this just defends against future loosening.
    this.sandboxName = `tianshu-${opts.tenantId}`
      .replace(/[^A-Za-z0-9_-]/g, "-")
      .slice(0, 64);
    this.gateway = new GatewayManager({
      gatewayBin: opts.gatewayBin,
      stateDir: opts.stateDir,
      port: this.opts.port,
      log: opts.log,
    });
  }

  // ─── lifecycle ───────────────────────────────────────────────────

  /**
   * First-call setup: start the gateway (idempotent), then ensure the
   * tenant sandbox exists and is in `Ready`. Called from activate(),
   * but also from exec() as a lazy fallback so a transient gateway
   * crash doesn't poison the whole tenant.
   */
  async ensureSandbox(): Promise<void> {
    this.state = "starting";
    this.startedAt = Date.now();
    try {
      this.gatewayHandle = await this.gateway.ensureRunning();
      // After the gateway is up + certs exist we can lay down the
      // plugin-local CLI config. Synchronous so the first CLI call
      // below sees a valid cert dir.
      await this.ensureCliConfig();
      const existing = await this.findSandbox(this.sandboxName);
      if (!existing) {
        await this.createSandbox();
      } else if (
        existing.phase === "failed" ||
        existing.phase === "error" ||
        existing.phase === "errored"
      ) {
        // Terminal-failure phases ("Failed" / "Error" / "Errored" —
        // OpenShell's enum has drifted across releases) are stuck
        // and need a fresh create. Any other non-ready phase
        // (Provisioning, etc.) is a healthy in-flight state —
        // just wait it out below.
        this.opts.log.warn(
          `openshell: sandbox ${this.sandboxName} phase=${existing.phase}, recreating`,
        );
        await this.cli(["sandbox", "delete", this.sandboxName]).catch(
          () => undefined,
        );
        await this.createSandbox();
      } else if (existing.phase !== "ready") {
        this.opts.log.info(
          `openshell: sandbox ${this.sandboxName} phase=${existing.phase}, waiting for Ready`,
        );
      }
      // Wait for Ready. Cold image pull is slow; subsequent creates
      // are fast because the docker image is cached.
      await this.waitForReady();
      this.state = "ready";
      this.lastError = undefined;
    } catch (err) {
      this.state = "error";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // ─── SandboxRunner contract ──────────────────────────────────────

  async exec(req: ExecRequest): Promise<ExecResult> {
    if (this.state !== "ready" && this.state !== "running") {
      await this.ensureSandbox();
    }
    const prev = this.state;
    this.state = "running";
    const startedAt = Date.now();
    try {
      // Native sandbox exec flags (verified 0.0.72-dev.8 CLI):
      //   --name --workdir --timeout --env --no-tty -- <command>
      const args: string[] = [
        "sandbox",
        "exec",
        "--name",
        this.sandboxName,
        "--no-tty",
      ];
      if (req.workdir && req.workdir !== "/") {
        args.push("--workdir", req.workdir);
      }
      if (req.timeoutMs && req.timeoutMs > 0) {
        // OpenShell --timeout is in whole seconds; round up so we
        // never give the guest less time than the caller asked.
        args.push("--timeout", String(Math.ceil(req.timeoutMs / 1000)));
      }
      if (req.userId) {
        args.push("--env", `TIANSHU_USER_ID=${req.userId}`);
      }
      // `bash -c` wraps the command so pipes / redirections / `&&`
      // are honoured exactly like the SDK contract promises.
      args.push("--", "bash", "-c", req.command);
      const { exitCode, stdout, stderr, timedOut, aborted } =
        await this.spawnCli(args, {
          // Host-side budget is gateway timeout + 2s slack so we can
          // observe a structured timeout error from the gateway
          // before our own SIGKILL fires.
          timeoutMs: req.timeoutMs ? req.timeoutMs + 2_000 : undefined,
          signal: req.signal,
        });
      return {
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
      };
    } finally {
      this.state = prev === "running" ? "running" : "ready";
    }
  }

  async readFile(relPath: string): Promise<string> {
    // Always go through the sandbox: the host workspace tree is a
    // staging area, but the source of truth for guest tools is
    // the sandbox's view at /sandbox/workspace/<relPath>. Download
    // to a temp host path, read, then unlink.
    const safeRel = this.assertRelativePath(relPath);
    const guestPath = `${SANDBOX_WORKSPACE_PATH}/${safeRel}`;
    const tmpHost = path.join(
      this.opts.stateDir,
      "io-scratch",
      `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    await fs.mkdir(path.dirname(tmpHost), { recursive: true });
    try {
      const { exitCode, stderr } = await this.spawnCli(
        ["sandbox", "download", this.sandboxName, guestPath, tmpHost],
        {},
      );
      if (exitCode !== 0) {
        throw new Error(
          `openshell sandbox download ${guestPath} failed (exit ${exitCode}): ${stderr}`,
        );
      }
      return await fs.readFile(tmpHost, "utf8");
    } finally {
      await fs.unlink(tmpHost).catch(() => undefined);
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    // Stage the bytes to a host temp file, upload to the sandbox at
    // /sandbox/workspace/<relPath>, then unlink the temp. The host
    // workspaceDir is also updated so tools that inspect the host
    // side of the tenant tree (e.g. tianshu's own SOUL.md scanner)
    // see the same content; this dual-write is acceptable because
    // the guest is the authoritative copy.
    const safeRel = this.assertRelativePath(relPath);
    const guestPath = `${SANDBOX_WORKSPACE_PATH}/${safeRel}`;
    const hostAbs = this.resolveSafe(relPath);
    await fs.mkdir(path.dirname(hostAbs), { recursive: true });
    await fs.writeFile(hostAbs, content, "utf8");
    // Ensure intermediate dirs exist guest-side. `sandbox upload`
    // auto-creates the immediate parent of the destination so we
    // do not need a separate mkdir CLI call.
    const tmpHost = path.join(
      this.opts.stateDir,
      "io-scratch",
      `w-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    await fs.mkdir(path.dirname(tmpHost), { recursive: true });
    await fs.writeFile(tmpHost, content, "utf8");
    try {
      const { exitCode, stderr } = await this.spawnCli(
        [
          "sandbox",
          "upload",
          "--no-git-ignore",
          this.sandboxName,
          tmpHost,
          guestPath,
        ],
        {},
      );
      if (exitCode !== 0) {
        throw new Error(
          `openshell sandbox upload ${guestPath} failed (exit ${exitCode}): ${stderr}`,
        );
      }
    } finally {
      await fs.unlink(tmpHost).catch(() => undefined);
    }
  }

  /** Reject absolute paths, .. traversal, and NUL bytes before they
   *  become a CLI arg. Returns the cleaned relative path. */
  private assertRelativePath(p: string): string {
    if (!p || typeof p !== "string") {
      throw new Error("openshell: path must be a non-empty string");
    }
    if (p.includes("\0")) {
      throw new Error("openshell: path must not contain NUL bytes");
    }
    if (p.startsWith("/")) {
      throw new Error("openshell: path must be relative");
    }
    const norm = path.posix.normalize(p);
    if (norm.startsWith("..") || norm === ".") {
      throw new Error("openshell: path escapes the workspace root");
    }
    return norm;
  }

  workspacePath(): string {
    return this.opts.workspaceDir;
  }

  async reset(): Promise<void> {
    this.opts.log.info("openshell: reset() begin");
    try {
      await this.cli(["sandbox", "delete", this.sandboxName]).catch(
        () => undefined,
      );
    } finally {
      this.state = "stopped";
    }
    await this.ensureSandbox();
    this.opts.log.info("openshell: reset() done");
  }

  async shutdown(): Promise<void> {
    this.opts.log.info("openshell: shutdown() begin");
    try {
      // Leave the sandbox container in place so a re-activate picks
      // up where we left off (apt installs, /tmp survived a stop +
      // start cycle as long as the container row isn't deleted).
      // Stopping isn't necessary because OpenShell keeps the container
      // running across `delete` only — there's no `stop` verb in 0.0.72.
    } catch (err) {
      this.opts.log.warn(
        `openshell: shutdown sandbox cleanup error (ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await this.gateway.stop().catch((err) => {
      this.opts.log.warn(
        `openshell: gateway stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    this.gatewayHandle = null;
    this.state = "stopped";
  }

  async status(): Promise<SandboxStatus> {
    return {
      state: this.state,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lastError: this.lastError,
      meta: {
        backend: "openshell",
        sandboxName: this.sandboxName,
        fromImage: this.opts.fromImage ?? "(default: community/base)",
        gatewayPid: this.gatewayHandle?.pid ?? null,
        port: this.opts.port,
        sandboxWorkspacePath: SANDBOX_WORKSPACE_PATH,
      },
    };
  }

  // ─── internals ───────────────────────────────────────────────────

  private resolveSafe(relPath: string): string {
    const root = path.resolve(this.opts.workspaceDir);
    const resolved = path.resolve(root, relPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(
        `openshell: path "${relPath}" resolves outside workspace`,
      );
    }
    return resolved;
  }

  /**
   * Create the tenant sandbox. We deliberately do NOT request a
   * bind mount; see the file header for the rationale. Tenant
   * files reach the sandbox via `sandbox upload`/`download`
   * inside writeFile/readFile. After create we mkdir
   * /sandbox/workspace inside the sandbox so the first writeFile
   * doesn't have to create the parent.
   *
   * Without a trailing command, `sandbox create` defaults to
   * launching an interactive SSH shell and blocking on it forever
   * (verified against 0.0.72-dev.8). Passing `-- true` keeps the
   * create non-interactive; the sandbox stays alive because we
   * did not pass --no-keep.
   */
  private async createSandbox(): Promise<void> {
    await fs.mkdir(this.opts.workspaceDir, { recursive: true });
    const args = [
      "sandbox",
      "create",
      "--name",
      this.sandboxName,
      "--no-tty",
      "--no-auto-providers",
    ];
    if (this.opts.fromImage) {
      args.push("--from", this.opts.fromImage);
    }
    args.push("--", "true");
    await this.cli(args);
    // mkdir the workspace root inside the sandbox so the first
    // writeFile doesn't 404. Done after create rather than via
    // an image-build hook so this plugin works against any
    // base image the operator picks.
    await this
      .spawnCli(
        [
          "sandbox",
          "exec",
          "--name",
          this.sandboxName,
          "--no-tty",
          "--",
          "mkdir",
          "-p",
          SANDBOX_WORKSPACE_PATH,
        ],
        {},
      )
      .catch(() => undefined);
    this.opts.log.info(
      `openshell: sandbox created name=${this.sandboxName} workspace=${this.opts.workspaceDir} guest=${SANDBOX_WORKSPACE_PATH}`,
    );
  }

  /** Poll `sandbox get` until Phase == Ready. Throws on Failed or
   *  on a per-call deadline (2 minutes — first-ever start has to
   *  pull the base image). */
  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const info = await this.findSandbox(this.sandboxName);
      if (!info) {
        throw new Error(
          `openshell: sandbox ${this.sandboxName} disappeared while waiting for Ready`,
        );
      }
      if (info.phase === "ready") return;
      if (
        info.phase === "failed" ||
        info.phase === "error" ||
        info.phase === "errored"
      ) {
        throw new Error(
          `openshell: sandbox ${this.sandboxName} entered phase=${info.phase}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `openshell: sandbox ${this.sandboxName} did not reach Ready within 2 minutes`,
    );
  }

  private async findSandbox(
    name: string,
  ): Promise<{ name: string; phase: string } | null> {
    // `sandbox get` prints a key-value block with Phase on its own
    // line. ANSI escape codes are stripped before matching so the
    // CLI's colour-formatted output doesn't trip us up.
    //
    // Failure modes we have to distinguish:
    //   - sandbox does not exist        → stderr "sandbox not found",
    //                                     and CLI may still exit 0
    //                                     (verified 0.0.72-dev.8)
    //   - gateway unreachable / TLS error → stderr "transport error"
    //                                       or exit !=0
    // Both map to `null` so the caller treats them uniformly as
    // "need to create". Real Phase parsing only proceeds when the
    // stdout actually contains a Phase line.
    try {
      const res = await this.spawnCli(["sandbox", "get", name], {});
      const stderr = this.stripAnsi(res.stderr);
      if (
        /not\s+found/i.test(stderr) ||
        /sandbox\s+'?[A-Za-z0-9_-]+'?\s+not\s+found/i.test(stderr)
      ) {
        return null;
      }
      const stdoutClean = this.stripAnsi(res.stdout);
      const phaseLine = stdoutClean
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("Phase:") || /\bPhase:/.test(l));
      if (!phaseLine) {
        // No Phase line + no obvious not-found error — likely a
        // transport / auth problem. Treat as transient and return
        // null so the caller surfaces it through waitForReady's
        // own timeout rather than us silently spinning here.
        return null;
      }
      const phase =
        phaseLine.replace(/^.*Phase:\s*/, "").trim().toLowerCase() ||
        "unknown";
      return { name, phase };
    } catch {
      return null;
    }
  }

  private stripAnsi(s: string): string {
    // Lightweight ANSI strip. openshell CLI uses CSI sequences only.
    return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  }

  private async cli(args: string[]): Promise<{ stdout: string }> {
    const res = await this.spawnCli(args, {});
    if (res.exitCode !== 0) {
      throw new Error(
        `openshell ${args.join(" ")} failed (exit ${res.exitCode}): ${res.stderr || res.stdout}`,
      );
    }
    return { stdout: res.stdout };
  }

  /**
   * Spawn the CLI with the gateway endpoint pinned via env. We don't
   * rely on `openshell gateway add` because the plugin is supposed to
   * be self-contained — first install shouldn't require side commands.
   * The CLI honours `OPENSHELL_GATEWAY_ENDPOINT` and reads its mTLS
   * client cert from the cert dir we pass via XDG.
   */
  private spawnCli(
    args: string[],
    opts: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
  }> {
    return new Promise((resolve) => {
      const bin = this.opts.openshellBin ?? "openshell";
      const gatewayUrl = this.gatewayHandle
        ? `https://127.0.0.1:${this.opts.port}`
        : undefined;
      const env = {
        ...process.env,
        ...(gatewayUrl
          ? { OPENSHELL_GATEWAY_ENDPOINT: gatewayUrl }
          : {}),
        // Point the CLI at our own cert dir layout. The CLI's mTLS
        // loader looks under $XDG_CONFIG_HOME/openshell/gateways/<name>/
        // for a `tls.crt`+`tls.key`+`ca.crt`; we don't want to share
        // the user's home so we use a plugin-owned XDG root.
        XDG_CONFIG_HOME: this.gatewayHandle
          ? path.join(this.opts.stateDir, "cli-xdg")
          : process.env.XDG_CONFIG_HOME,
      };
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let aborted = false;
      const timeout = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, opts.timeoutMs)
        : undefined;
      const onAbort = () => {
        aborted = true;
        child.kill("SIGKILL");
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (c) => {
        stdout += c.toString("utf8");
      });
      child.stderr.on("data", (c) => {
        stderr += c.toString("utf8");
      });
      child.on("close", (code) => {
        if (timeout) clearTimeout(timeout);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: code ?? -1,
          stdout,
          stderr,
          timedOut,
          aborted,
        });
      });
      child.on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + `\nspawn failed: ${err.message}`,
          timedOut,
          aborted,
        });
      });
    });
  }

  /**
   * Provision the plugin-local CLI config the spawned `openshell`
   * processes will read. Called once from ensureSandbox() after the
   * gateway is up and certs exist.
   *
   * Two layouts coexist in upstream CLI:
   *   1. `gateways/<name>/mtls/...` — used when CLI was bootstrapped
   *      via `openshell gateway add <url> --name <name>`.
   *   2. `gateways/<endpoint-derived-name>/mtls/...` — used when CLI
   *      connects to an explicit `--gateway-endpoint <url>` (or via
   *      $OPENSHELL_GATEWAY_ENDPOINT) without a stored registration.
   *      The endpoint is slugified: "https://127.0.0.1:17671" →
   *      "https___127.0.0.1_17671".
   *
   * We populate both so either codepath works. Idempotent.
   */
  private async ensureCliConfig(): Promise<void> {
    if (!this.gatewayHandle) return;
    const xdgRoot = path.join(this.opts.stateDir, "cli-xdg");
    const certs = this.gatewayHandle.certsDir;
    const endpoint = `https://127.0.0.1:${this.opts.port}`;
    const endpointSlug = endpoint.replace(/[^A-Za-z0-9]/g, "_");
    for (const name of ["openshell", endpointSlug]) {
      const gatewayDir = path.join(
        xdgRoot,
        "openshell",
        "gateways",
        name,
      );
      const mtlsDir = path.join(gatewayDir, "mtls");
      const metaPath = path.join(gatewayDir, "metadata.json");
      await fs.mkdir(mtlsDir, { recursive: true });
      await fs.copyFile(
        path.join(certs, "ca.crt"),
        path.join(mtlsDir, "ca.crt"),
      );
      await fs.copyFile(
        path.join(certs, "client/tls.crt"),
        path.join(mtlsDir, "tls.crt"),
      );
      await fs.copyFile(
        path.join(certs, "client/tls.key"),
        path.join(mtlsDir, "tls.key"),
      );
      await fs.chmod(path.join(mtlsDir, "tls.key"), 0o600);
      await fs.writeFile(
        metaPath,
        JSON.stringify(
          {
            name,
            gateway_endpoint: endpoint,
            is_remote: false,
            gateway_port: 0,
            auth_mode: "mtls",
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(xdgRoot, "openshell", "active_gateway"),
      "openshell\n",
      "utf8",
    );
  }
}
