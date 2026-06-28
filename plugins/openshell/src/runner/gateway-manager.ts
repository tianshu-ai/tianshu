// OpenShell gateway lifecycle manager.
//
// Spawns and supervises a per-tianshu-plugin `openshell-gateway`
// process. We run the gateway as a child of the tianshu server
// rather than relying on a system service so:
//
//  - Each tianshu install owns its own gateway state (no port
//    conflicts when two tianshu tenants share a host)
//  - cert / config lifecycle stays inside the plugin's state dir
//    (`<tenantHome>/state/openshell-plugin/`)
//  - `tianshu plugin disable openshell` cleanly shuts the gateway
//    down via the SDK deactivate hook
//
// The gateway is a single Rust binary (~50 MB) shipped by NVIDIA;
// we expect operators to install it once via the upstream
// installer or our own bootstrap (`tianshu setup openshell`,
// follow-up PR). For now the binary path is plugin-config-driven
// and defaults to looking in $PATH.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as net from "node:net";

export interface GatewayManagerOpts {
  /** Path to the `openshell-gateway` binary. Defaults to
   *  `openshell-gateway` on $PATH. */
  gatewayBin?: string;
  /** Per-plugin state directory. Holds certs, config, logs, the
   *  sqlite db that openshell-gateway writes to. Plugin owns it
   *  end-to-end so tenant uninstall is `rm -rf` safe. */
  stateDir: string;
  /** Loopback port the gateway listens on. The CLI and tianshu
   *  both dial localhost:<port>. */
  port: number;
  /** Logger from plugin ctx. */
  log: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
}

export interface GatewayHandle {
  pid: number;
  /** `https://host.openshell.internal:<port>` — the URL the
   *  sandbox supervisor inside the container dials. */
  grpcEndpoint: string;
  /** Absolute path to the cert dir; passed back to the runner so
   *  CLI calls can authenticate with the matching client cert. */
  certsDir: string;
}

/**
 * Start an openshell-gateway in the plugin's state dir. Idempotent
 * across plugin reloads: if the same port is already serving, we
 * adopt it (no-op restart) instead of double-binding.
 */
export class GatewayManager {
  private child: ChildProcess | null = null;
  private opts: GatewayManagerOpts;

  constructor(opts: GatewayManagerOpts) {
    this.opts = opts;
  }

  /**
   * Ensure a gateway is running. Returns a handle the runner uses to
   * talk to it. Safe to call repeatedly; subsequent calls are no-ops
   * once the gateway is up.
   */
  async ensureRunning(): Promise<GatewayHandle> {
    if (this.child && this.child.exitCode === null) {
      return this.handle();
    }
    if (await this.portInUse()) {
      // Either we're racing another tianshu process or the user
      // already has a gateway up. Adopt it — auth still works
      // because the cert dir lookup is deterministic.
      this.opts.log.info(
        `openshell: port ${this.opts.port} already serving; adopting existing gateway`,
      );
      return this.handle();
    }

    await this.ensureCertsExist();
    await this.writeGatewayToml();

    const certsDir = path.join(this.opts.stateDir, "certs");
    const args = [
      "--config",
      path.join(this.opts.stateDir, "gateway.toml"),
      "--bind-address",
      "0.0.0.0", // Docker driver: supervisor inside container must reach the gateway via host.openshell.internal, which Docker Desktop routes to the bridge IP — only 0.0.0.0 listener accepts that path.
      "--port",
      String(this.opts.port),
      "--tls-cert",
      path.join(certsDir, "server", "tls.crt"),
      "--tls-key",
      path.join(certsDir, "server", "tls.key"),
      "--tls-client-ca",
      path.join(certsDir, "ca.crt"),
      "--drivers",
      "docker",
    ];

    const logPath = path.join(this.opts.stateDir, "gateway.log");
    const logFd = await fs.open(logPath, "a");
    const child = spawn(
      this.opts.gatewayBin ?? "openshell-gateway",
      args,
      {
        stdio: ["ignore", logFd.fd, logFd.fd],
        // Detach so a tianshu server SIGTERM doesn't take the
        // gateway down with the children's parent group; we kill
        // it explicitly on `stop()`.
        detached: false,
      },
    );
    await logFd.close();
    this.child = child;

    child.on("exit", (code, signal) => {
      this.opts.log.warn(
        `openshell-gateway exited code=${code ?? "null"} signal=${signal ?? "null"}; logs at ${logPath}`,
      );
      this.child = null;
    });

    // Wait for the gateway to actually accept connections so the
    // first sandbox-create doesn't race the listener.
    await this.waitForListen();
    this.opts.log.info(`openshell-gateway pid=${child.pid} on :${this.opts.port}`);
    return this.handle();
  }

  /** SIGTERM-then-SIGKILL the gateway. Idempotent. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
    // Give the gateway 3s to flush sqlite + close listeners, then
    // SIGKILL. Don't block plugin teardown longer than that.
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(deadline);
        resolve();
      });
    });
  }

  private handle(): GatewayHandle {
    return {
      pid: this.child?.pid ?? -1,
      grpcEndpoint: `https://host.openshell.internal:${this.opts.port}`,
      certsDir: path.join(this.opts.stateDir, "certs"),
    };
  }

  // ─── internals ─────────────────────────────────────────────────

  /** Generate cert bundle on first start. We invoke
   *  `openshell-gateway generate-certs` so the file layout matches
   *  exactly what the gateway expects (server.crt/key + client.crt/key
   *  + ca.crt + jwt/signing|public|kid). SAN list pinned to the
   *  hosts the docker driver auto-injects. */
  private async ensureCertsExist(): Promise<void> {
    const certsDir = path.join(this.opts.stateDir, "certs");
    const marker = path.join(certsDir, "ca.crt");
    try {
      await fs.access(marker);
      return; // already generated
    } catch {
      /* fall through */
    }
    await fs.mkdir(certsDir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        this.opts.gatewayBin ?? "openshell-gateway",
        [
          "generate-certs",
          "--output-dir",
          certsDir,
          "--server-san",
          "host.openshell.internal",
          "--server-san",
          "host.docker.internal",
          // Docker Desktop's stable bridge IP on macOS. Linux uses
          // a different per-network gateway; the supervisor falls
          // back to host.openshell.internal in /etc/hosts so the
          // extra SAN is purely for the openssl path probe in
          // tests + future Linux work.
          "--server-san",
          "192.168.65.254",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      proc.stderr.on("data", (c) => {
        stderr += c.toString("utf8");
      });
      proc.on("close", (code) => {
        if (code === 0) return resolve();
        reject(
          new Error(
            `openshell-gateway generate-certs exit=${code}: ${stderr.trim()}`,
          ),
        );
      });
      proc.on("error", reject);
    });
    this.opts.log.info(`openshell: generated certs at ${certsDir}`);
  }

  /** Drop a minimal gateway.toml with JWT pointers + docker driver
   *  config (mTLS to guest, bind mounts enabled). Re-written every
   *  start so plugin upgrades that change the schema take effect
   *  without a manual edit. */
  private async writeGatewayToml(): Promise<void> {
    const certsDir = path.join(this.opts.stateDir, "certs");
    const toml = `# Auto-generated by tianshu openshell plugin. Do not edit by hand —
# changes are clobbered on plugin restart. To override, set
# plugin config in tenant config.json.

[openshell.gateway.gateway_jwt]
signing_key_path = "${path.join(certsDir, "jwt/signing.pem")}"
public_key_path  = "${path.join(certsDir, "jwt/public.pem")}"
kid_path         = "${path.join(certsDir, "jwt/kid")}"

[openshell.drivers.docker]
# The supervisor inside the container dials this URL. Must be HTTPS
# (the gateway 0.0.0.0+TLS listener rejects plaintext) and must
# resolve from inside the container — Docker Desktop's
# host.openshell.internal alias is injected automatically.
grpc_endpoint  = "https://host.openshell.internal:${this.opts.port}"
guest_tls_ca   = "${path.join(certsDir, "ca.crt")}"
guest_tls_cert = "${path.join(certsDir, "client/tls.crt")}"
guest_tls_key  = "${path.join(certsDir, "client/tls.key")}"

# Required so the runner can bind-mount each tenant's workspace dir
# into /workspace inside the container at create-time. Without this
# we'd be stuck with 'sandbox upload' / 'sandbox download' for every
# read/write — much slower than host fs and no atomicity guarantee.
enable_bind_mounts = true
`;
    await fs.writeFile(
      path.join(this.opts.stateDir, "gateway.toml"),
      toml,
      "utf8",
    );
  }

  /** TCP connectability probe. Used to: (a) decide whether a gateway
   *  is already up (adopt instead of double-bind), (b) wait for our
   *  own spawn to become reachable. */
  private async portInUse(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection({
        host: "127.0.0.1",
        port: this.opts.port,
        timeout: 200,
      });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => {
        sock.destroy();
        resolve(false);
      });
    });
  }

  /** Block until the gateway accepts a TCP connection. Throws after
   *  the deadline. Cold start on a populated host is < 3s; we give
   *  generous slack for first-ever start (binary cold cache). */
  private async waitForListen(): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await this.portInUse()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(
      `openshell-gateway did not start listening on :${this.opts.port} within 20s`,
    );
  }
}
