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

// Read version from root package.json for client-side version checking.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname2, "../../package.json"), "utf8"));

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: webPort,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/ws": { target: `ws://localhost:${serverPort}`, ws: true },
      // Custom shell UI lives at /shell/tenants/... so it doesn't
      // hijack the native UI. Proxy all /shell/ requests to backend.
      "/shell": `http://localhost:${serverPort}`,
    },
  },
});
