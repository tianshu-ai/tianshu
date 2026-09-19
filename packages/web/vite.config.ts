import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Default dev ports for the open-source repo deliberately differ from the
// closed-source predecessor (3100 / 5173) so both can run on the same
// dev machine without colliding.
//
// Override via env at dev time:
//   WEB_PORT=5184 PORT=3111 npm run dev
// The wizard writes these to .env when the user picks non-default ports.
const webPort = Number.parseInt(process.env.WEB_PORT ?? "5183", 10);
const serverPort = Number.parseInt(process.env.PORT ?? "3110", 10);

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      // Yu, 2026-09-19: this single "/ws" entry proxies all upgrade
      // requests with a /ws* URL to the tianshu server, including
      // /ws/asr. http-proxy-middleware does prefix matching, so a
      // second more-specific entry for /ws/asr would either be
      // shadowed (order-dependent) or, worse, trigger vite's
      // known upgrade-dispatch race between two ws:true entries
      // on the same target. Path preservation is enough because
      // the tianshu server distinguishes /ws vs /ws/asr internally
      // (see ws-upgrade.ts and ws-asr.ts).
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
      // Custom shell UI lives at /shell/tenants/... so it doesn't
      // hijack the native UI. Proxy all /shell/ requests to backend.
      "/shell": `http://localhost:${serverPort}`,
    },
  },
});
