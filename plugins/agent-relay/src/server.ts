// Agent Relay — plugin server entry

import type { PluginContext, PluginServerExports, PluginServerModule } from "@tianshu-ai/plugin-sdk";
import { RelayServer } from "./relay-server.js";
import { RelayClient } from "./relay-client.js";

let relayServer: RelayServer | null = null;
let relayClient: RelayClient | null = null;

const plugin: PluginServerModule = {
  activate(ctx: PluginContext): PluginServerExports {
    const cfg = (ctx.pluginConfig ?? {}) as Record<string, unknown>;
    const mode = String(cfg.mode || "off");

    if (mode === "server") {
      const port = Number(cfg.serverPort) || 3002;
      const publicUrl = String(cfg.publicUrl || `http://localhost:${port}`);
      relayServer = new RelayServer({ db: ctx.db, port, publicUrl, log: ctx.log });
      relayServer.start();
      ctx.log.info("agent-relay activated (server mode)", { port, publicUrl });
    } else if (mode === "client") {
      const relayUrl = String(cfg.relayUrl || "");
      if (!relayUrl) {
        ctx.log.warn("agent-relay: client mode requires relayUrl");
      } else {
        const branding = ctx.tenantConfig?.branding ?? {};
        const agentCard = {
          name: (branding.name as string) || "Tianshu Agent",
          description: "",
          provider: { organization: "" },
          version: "1.0.0",
        };

        // Local server port for forwarding proxied A2A requests
        const localPort = Number(process.env.PORT || process.env.TIANSHU_PORT || 3110);
        const localBase = `http://127.0.0.1:${localPort}`;

        relayClient = new RelayClient({
          db: ctx.db, relayUrl,
          apiKey: cfg.apiKey as string | undefined,
          tenantId: ctx.tenantId ?? "default", agentCard,
          discoverable: cfg.discoverable === true,
          log: ctx.log,
          onRequest: async (req) => {
            // Map relay paths to local messenger A2A endpoints
            let localUrl: string;
            if (req.path === "/.well-known/agent-card.json") {
              localUrl = `${localBase}/api/p/messenger/agent-card`;
            } else {
              // Everything else → messenger a2a/receive (JSON-RPC)
              localUrl = `${localBase}/api/p/messenger/a2a/receive`;
            }
            try {
              const resp = await fetch(localUrl, {
                method: req.method,
                headers: { ...req.headers, "content-type": "application/json" },
                ...(req.body ? { body: req.body } : {}),
              });
              const body = await resp.text();
              const headers: Record<string, string> = { "content-type": "application/json" };
              return { status: resp.status, headers, body };
            } catch (err) {
              return { status: 502, headers: {}, body: JSON.stringify({ error: "local_forward_failed", message: String(err) }) };
            }
          },
        });
        relayClient.start();
        ctx.log.info("agent-relay activated (client mode)", { relayUrl, localBase });
      }
    } else {
      ctx.log.info("agent-relay: disabled (mode=off)");
    }

    return {
      routes: {
        status: (_req, res) => {
          if (relayServer) res.json({ mode: "server", status: "running" });
          else if (relayClient) res.json({ mode: "client", connected: relayClient.isConnected, publicUrl: relayClient.relayPublicUrl });
          else res.json({ mode: "off" });
        },
      },
    };
  },
  deactivate() {
    relayServer?.stop();
    relayClient?.stop();
    relayServer = null;
    relayClient = null;
  },
};

export const activate = plugin.activate.bind(plugin);
export const deactivate = plugin.deactivate?.bind(plugin);
export default plugin;
