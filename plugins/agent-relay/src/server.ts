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
        relayClient = new RelayClient({
          db: ctx.db, relayUrl, apiKey: cfg.apiKey as string | undefined,
          tenantId: ctx.tenantId ?? "default", agentCard, discoverable: cfg.discoverable === true,
          log: ctx.log,
          onRequest: async (_req) => ({
            status: 501, headers: {},
            body: JSON.stringify({ error: "not_implemented", message: "Local A2A handler not wired yet" }),
          }),
        });
        relayClient.start();
        ctx.log.info("agent-relay activated (client mode)", { relayUrl });
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
