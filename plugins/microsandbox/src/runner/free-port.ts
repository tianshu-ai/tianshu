// Pick a free TCP port on the host (loopback).
//
// We open a listener on port 0 and let the kernel hand back an
// ephemeral port, then close it. Race-prone against other processes
// that grab the same port between close and `Sandbox.builder().port()`,
// but in practice microsandbox claims the forward immediately after
// build() so the window is small enough.
//
// Picking a known fixed port instead would be friendlier to users
// bookmarking `http://localhost:6080` for noVNC, but breaks the moment
// two tenants run on the same host. We surface the picked port via the
// BrowserSidecar so the admin Browser page can render whatever number
// landed.

import * as net from "node:net";

export async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("net.createServer() returned no address"));
      }
    });
  });
}

/** Pick `count` distinct free ports. The pool is just a Set of ports
 *  already handed out in this call so we don't return the same port
 *  twice when the kernel happens to reuse it across rapid listens. */
export async function pickFreePorts(count: number): Promise<number[]> {
  const seen = new Set<number>();
  const out: number[] = [];
  let attempts = 0;
  while (out.length < count && attempts < count * 4) {
    attempts++;
    const p = await pickFreePort();
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  if (out.length < count) {
    throw new Error(
      `pickFreePorts: only got ${out.length}/${count} unique free ports after ${attempts} attempts`,
    );
  }
  return out;
}
