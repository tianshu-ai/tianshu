import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Default dev ports for the open-source repo deliberately differ from the
// closed-source predecessor (3100 / 5173) so both can run on the same
// dev machine without colliding.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      "/api": "http://localhost:3110",
      "/ws": { target: "ws://localhost:3110", ws: true },
    },
  },
});
