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
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
      // Yu, 2026-09-19: /ws/asr is a separate WebSocketServer (see
      // packages/server/src/boot/ws-asr.ts), and vite's proxy config
      // matches paths individually — the /ws entry above does not
      // cover child paths like /ws/asr. Adding an explicit entry with
      // ws:true so dev-mode voice input works. In prod both paths hit
      // the tianshu server directly and this indirection isn't needed.
      "/ws/asr": { target: `ws://localhost:${serverPort}`, ws: true },
      // Custom shell UI lives at /shell/tenants/... so it doesn't
      // hijack the native UI. Proxy all /shell/ requests to backend.
      "/shell": `http://localhost:${serverPort}`,
    },
  },
});
