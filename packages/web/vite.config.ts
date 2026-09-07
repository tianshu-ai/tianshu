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
      // When the custom-ui shell plugin is active, the server serves
      // a custom index.html at /tenants/... with injected config.
      // This bypass rule lets the Vite dev server proxy tenant pages
      // to the backend when the shell is published. The server
      // returns 404 if no shell is active, and Vite falls through
      // to its own SPA handler.
      "/tenants": {
        target: `http://localhost:${serverPort}`,
        bypass(req) {
          // Only proxy HTML page requests (not HMR, assets, etc.)
          const accept = req.headers.accept || "";
          if (!accept.includes("text/html")) return req.url;
        },
      },
    },
  },
});
