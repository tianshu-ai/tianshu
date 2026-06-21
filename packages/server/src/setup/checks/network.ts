// Network + service-health check.
//
// Three things to verify:
//   1. The configured server / web ports are bindable. If
//      something else owns them, that's a port conflict.
//   2. If they're owned by *us* (tianshu's own server is
//      running), that's actually the happy path — the doctor
//      reports it as "service running" rather than warning
//      about a port conflict.
//   3. The service responds with a sane /api/health body so
//      we know it's not just a stale process holding the
//      socket.
//
// This module is sync-safe (no boot-time side effects); the
// HTTP probe has a 2s timeout so doctor stays fast.

import net from "node:net";
import { CheckGroup } from "../render.js";
import { loadGlobalConfig } from "../../core/config.js";
import {
  detectInstallMode,
  resolveServerPort,
  resolveWebPort,
} from "../../core/urls.js";

export interface NetworkCheckOpts {
  home?: string;
  /** Override the discovered ports for tests. */
  serverPort?: number;
  webPort?: number;
  /** Override the timeout used by the health probe. */
  healthTimeoutMs?: number;
}

export async function checkNetwork(
  opts: NetworkCheckOpts = {},
): Promise<CheckGroup> {
  const lines: CheckGroup["lines"] = [];
  // Port + mode resolution is centralised in core/urls.ts.
  // The only thing doctor-specific here is the test-override
  // hooks (opts.serverPort / opts.webPort).
  let cfg: ReturnType<typeof loadGlobalConfig> | undefined;
  try {
    cfg = loadGlobalConfig(opts.home);
  } catch {
    // config might not exist yet — that's fine for this check
  }
  const serverPort = opts.serverPort ?? resolveServerPort({ config: cfg });
  const webPort = opts.webPort ?? resolveWebPort();

  // Server port: free → server isn't running. Owned → probe
  // /api/health to find out who's there.
  const serverState = await probePort(serverPort);
  if (serverState === "free") {
    lines.push({
      severity: "warning",
      text: `Server port ${serverPort} free`,
      detail:
        "Server isn't running. Start it with `tianshu setup --wizard` (auto-installs launchd) or `npm run dev` from a checkout.",
    });
  } else {
    const health = await probeHealth(
      `http://localhost:${serverPort}/api/health`,
      opts.healthTimeoutMs ?? 2000,
    );
    if (health.kind === "tianshu") {
      lines.push({
        severity: "ok",
        text: `Server up on :${serverPort}`,
        detail: `health: ${health.status}, tenants: ${health.tenants ?? "?"}, uptime: ${
          health.uptimeSec ? `${health.uptimeSec}s` : "?"
        }`,
      });
    } else if (health.kind === "stranger") {
      lines.push({
        severity: "warning",
        text: `Port ${serverPort} owned by another process`,
        detail: `Got HTTP ${health.statusCode ?? "?"} but the body doesn't look like tianshu. ${health.bodyPreview}`,
      });
    } else {
      // listening but didn't answer the HTTP probe — maybe a
      // raw TCP listener, maybe a tianshu instance that's still
      // booting. Soft-warning.
      lines.push({
        severity: "warning",
        text: `Port ${serverPort} in use, no HTTP response`,
        detail:
          health.error ??
          "Something is listening but didn't answer GET /api/health within the timeout. If you just ran the wizard, give it ~30s; otherwise stop the unrelated process or pick a different PORT.",
      });
    }
  }

  // Web port behaviour depends on which mode the user installed in:
  //
  // - Dev (git checkout, `npm run dev`): vite hosts the SPA on a
  //   separate port (default 5183). Doctor should expect both
  //   ports and warn on conflicts.
  // - Production (global npm install, `npm run serve`): the
  //   server hosts the SPA on the API port via
  //   TIANSHU_WEB_DIST. The web port is irrelevant and showing
  //   "web port 5183 free" only confuses users.
  //
  // detectInstallMode (core/urls.ts) returns "dev" when this
  // CLI is itself running from a git checkout; the wizard's
  // launchd plist applies the same heuristic via
  // isDevelopmentCheckout, so doctor's view matches the actual
  // service.
  const mode = detectInstallMode();
  if (mode === "dev") {
    const webState = await probePort(webPort);
    if (webState === "free") {
      lines.push({
        severity: "ok",
        text: `Web port ${webPort} free`,
        detail: "Will be bound by `vite` when the dev server starts.",
      });
    } else {
      lines.push({
        severity: "ok",
        text: `Web port ${webPort} in use`,
        detail: `Probably the dev UI; visit http://localhost:${webPort}`,
      });
    }
  } else {
    // Production: web served by the API process. Just confirm
    // the user-facing URL.
    lines.push({
      severity: "ok",
      text: `Web UI on http://localhost:${serverPort}`,
      detail:
        "Production mode — the server hosts the SPA on the API port (TIANSHU_WEB_DIST). No separate web process / port.",
    });
  }

  return { title: "Network & service", lines };
}

/**
 * Probe whether `port` is in use — by trying to connect to it.
 *
 * We deliberately do NOT use `net.createServer().listen()` to
 * test bindability: macOS happily lets two sockets share a port
 * when one is on 0.0.0.0 / 127.0.0.1 and the other is on `::1`,
 * so a 'can I bind' probe can succeed even when something else
 * is already listening on the dual-stack catch-all. Connecting
 * is unambiguous — if it succeeds, *something* answers there.
 *
 * We try both 127.0.0.1 and ::1 because tianshu's server
 * binds dual-stack catch-all (`::`) but vite binds only ::1,
 * and an IPv4-only probe would miss the latter.
 */
async function probePort(port: number): Promise<"free" | "in_use"> {
  if (await tryConnect("127.0.0.1", port)) return "in_use";
  if (await tryConnect("::1", port)) return "in_use";
  return "free";
}

function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let resolved = false;
    const finish = (ok: boolean) => {
      if (resolved) return;
      resolved = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(800);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
    sock.connect(port, host);
  });
}

interface HealthOk {
  kind: "tianshu";
  status: string;
  tenants?: number;
  uptimeSec?: number;
  version?: string;
}
interface HealthStranger {
  kind: "stranger";
  statusCode?: number;
  bodyPreview: string;
}
interface HealthSilent {
  kind: "silent";
  error?: string;
}

async function probeHealth(
  url: string,
  timeoutMs: number,
): Promise<HealthOk | HealthStranger | HealthSilent> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    const text = await res.text();
    clearTimeout(t);
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — definitely not us
    }
    if (
      body &&
      typeof body === "object" &&
      typeof body.status === "string" &&
      body.name === "tianshu"
    ) {
      return {
        kind: "tianshu",
        status: String(body.status),
        tenants: typeof body.tenants === "number" ? body.tenants : undefined,
        uptimeSec:
          typeof body.uptimeSec === "number"
            ? Math.round(body.uptimeSec)
            : undefined,
        version: typeof body.version === "string" ? body.version : undefined,
      };
    }
    return {
      kind: "stranger",
      statusCode: res.status,
      bodyPreview: text.slice(0, 100),
    };
  } catch (err) {
    clearTimeout(t);
    return {
      kind: "silent",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
