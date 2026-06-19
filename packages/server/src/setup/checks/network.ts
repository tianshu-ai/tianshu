// Network port readiness — make sure the ports the server / web
// will bind to aren't already in use.
//
// Subtle: a *previous* tianshu instance owning the port is the
// most common cause; we still mark it as a blocker because two
// instances on the same port would clash. The fix message
// disambiguates.

import net from "node:net";
import { CheckGroup } from "../render.js";
import { loadGlobalConfig } from "../../core/config.js";

export interface NetworkCheckOpts {
  home?: string;
  /** Override the discovered ports for tests. */
  serverPort?: number;
  webPort?: number;
}

const DEFAULT_SERVER_PORT = 3110;
const DEFAULT_WEB_PORT = 5183;

export async function checkNetwork(
  opts: NetworkCheckOpts = {},
): Promise<CheckGroup> {
  const lines: CheckGroup["lines"] = [];
  let serverPort = opts.serverPort ?? envPort("PORT") ?? DEFAULT_SERVER_PORT;
  let webPort = opts.webPort ?? DEFAULT_WEB_PORT;
  try {
    const cfg = loadGlobalConfig(opts.home);
    serverPort = opts.serverPort ?? cfg.server?.port ?? serverPort;
  } catch {
    // config might not exist yet — that's fine for this check
  }

  for (const [label, port] of [
    ["server", serverPort],
    ["web (vite dev)", webPort],
  ] as const) {
    const status = await probePort(port);
    if (status === "free") {
      lines.push({
        severity: "ok",
        text: `${label} port ${port} free`,
      });
    } else {
      lines.push({
        severity: "warning",
        text: `${label} port ${port} in use`,
        detail:
          "Another process owns this port. Stop it, or set PORT (server) / change vite.config.ts (web) to a free port.",
      });
    }
  }
  return { title: "Network", lines };
}

function envPort(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

function probePort(port: number): Promise<"free" | "in_use"> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve("in_use"));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve("free"));
    });
  });
}
