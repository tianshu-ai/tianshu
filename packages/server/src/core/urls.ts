// Central place for "where does this server live, in URL form?".
//
// Three things were drifting before this module existed:
//   1. The server process picks a port (env PORT → 3110).
//   2. The wizard / launchd / doctor pick a port too (env PORT →
//      global config server.port → 3110).
//   3. The CLI prints user-facing URLs (tenant list, status,
//      wizard banner) and has to know both the *port* and the
//      *mode* (dev = vite on a separate web port; prod = server
//      hosts the SPA on the API port via TIANSHU_WEB_DIST).
//
// Each of those used to inline its own resolver. They drifted —
// the most recent symptom was `tianshu tenant list` printing the
// vite port (5183) on a prod install, where no vite process
// exists. This module is the single source of truth.
//
// What it does NOT do:
//   - It doesn't decide the *bind port* the running server
//     uses. `index.ts` keeps its own narrow `process.env.PORT
//     ?? 3110` read so it never depends on the global config
//     file existing during boot. (If you want the server to
//     honour global config someday, change index.ts and
//     re-aim the launchd plist env vars; don't change urls.ts.)
//   - It doesn't probe sockets. `setup/checks/network.ts` still
//     owns the actual "is the port answering?" probe, but it
//     gets its port numbers and dev/prod mode from here.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig, type GlobalConfig } from "./config.js";

export const DEFAULT_SERVER_PORT = 3110;
export const DEFAULT_WEB_PORT = 5183;

/** Two install shapes. See module docstring. */
export type InstallMode = "dev" | "prod";

export interface UrlContext {
  /** Pre-loaded global config, if the caller already has it. */
  config?: GlobalConfig;
  /**
   * The tianshu checkout the running CLI lives in. Used only
   * for dev/prod detection. Defaults to walking up from this
   * file (works for both dev checkouts and global installs).
   */
  repoRoot?: string;
}

/**
 * Resolve the API server's port:
 *   1. process.env.PORT
 *   2. global config server.port
 *   3. DEFAULT_SERVER_PORT (3110)
 *
 * Matches what the wizard writes to .env and what doctor probes.
 * The running server itself doesn't call this (see module
 * docstring) — it keeps a narrower env-only read so its boot
 * isn't blocked by a missing global config.
 */
export function resolveServerPort(ctx: UrlContext = {}): number {
  const envPort = parsePort(process.env.PORT);
  if (envPort !== undefined) return envPort;
  const cfg = ctx.config ?? safeLoadConfig();
  if (cfg?.server?.port && Number.isFinite(cfg.server.port)) {
    return cfg.server.port;
  }
  return DEFAULT_SERVER_PORT;
}

/**
 * Resolve the *vite dev server* port. Only meaningful in dev
 * mode. We don't read this from global config because it isn't
 * a config field — it's a per-dev-checkout `.env` knob the
 * wizard writes when installing a dev launchd agent.
 *
 *   1. process.env.WEB_PORT
 *   2. DEFAULT_WEB_PORT (5183)
 */
export function resolveWebPort(): number {
  const envPort = parsePort(process.env.WEB_PORT);
  if (envPort !== undefined) return envPort;
  return DEFAULT_WEB_PORT;
}

/**
 * Whether this CLI is running from a dev checkout (vite serves
 * the SPA on a separate port) or a global / npm-published
 * install (server hosts the SPA itself on the API port).
 *
 * Heuristic mirrors `setup/repo-root.ts:isDevelopmentCheckout`
 * but kept inline so this module stays import-light (config.ts
 * is the only cross-module dep). The two definitions must
 * agree — if they ever drift, doctor and the wizard will start
 * reporting different modes for the same machine. There's a
 * smoke test in urls.test.ts that pins them together.
 */
export function detectInstallMode(ctx: UrlContext = {}): InstallMode {
  try {
    const explicitRoot = ctx.repoRoot;
    if (explicitRoot) return modeFromPath(explicitRoot);
    return modeFromPath(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    // Conservative fallback: assume prod so we don't print
    // dev-only "open localhost:5183" advice to a real user.
    return "prod";
  }
}

function modeFromPath(start: string): InstallMode {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return "dev";
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (start.includes(`${path.sep}node_modules${path.sep}`)) return "prod";
  return "prod";
}

/**
 * The URL the user opens in a browser.
 *
 * Resolution order:
 *   1. TIANSHU_WEB_URL env (explicit override — Cloudflare
 *      tunnel hostname etc.). Trumps everything.
 *   2. global config server.publicUrl (operator-declared,
 *      persisted; same intent as TIANSHU_WEB_URL but written
 *      once into config instead of needing env in every shell).
 *   3. global config server.effectivePublicUrl (auto-written
 *      by the running server on each boot — reflects which
 *      port is actually serving the SPA *right now*, regardless
 *      of whether the install is dev or prod shape).
 *   4. http://localhost:<port>, where <port> is:
 *      - prod mode → server port (server hosts the SPA itself)
 *      - dev  mode → web port    (vite dev server)
 *      This last fallback runs when the server has never
 *      booted (so #3 isn't populated yet) AND the operator
 *      hasn't declared publicUrl. We still use the dev/prod
 *      heuristic from the filesystem here — it's the same
 *      one the wizard's launchd plist uses.
 *
 * Always returned without a trailing slash so callers can do
 * `${publicBase}/tenants/...` safely.
 */
export function resolvePublicBaseUrl(ctx: UrlContext = {}): string {
  const envUrl = process.env.TIANSHU_WEB_URL;
  if (envUrl) return stripTrailingSlash(envUrl);
  const cfg = ctx.config ?? safeLoadConfig();
  const cfgUrl = cfg?.server?.publicUrl;
  if (cfgUrl) return stripTrailingSlash(cfgUrl);
  const effective = cfg?.server?.effectivePublicUrl;
  if (effective) return stripTrailingSlash(effective);
  const mode = detectInstallMode(ctx);
  const port = mode === "prod" ? resolveServerPort({ config: cfg }) : resolveWebPort();
  return `http://localhost:${port}`;
}

/**
 * What the running server should publish as its
 * `effectivePublicUrl` — i.e. "this is the localhost URL that
 * actually opens the SPA right now". The server calls this
 * during boot and writes the result to global config so CLI
 * commands (which run in separate processes and can't read
 * the server's env) still know which port the SPA lives on.
 *
 * Don't confuse with publicBaseUrl: this one ignores
 * TIANSHU_WEB_URL / publicUrl on purpose. It's the
 * *observed* truth, not the *declared* one.
 */
export function computeServerEffectivePublicUrl(opts: {
  /** PORT the server is actually listening on. */
  port: number;
  /** True when this process is hosting the SPA itself
   *  (TIANSHU_WEB_DIST is set and points at a valid dist). */
  hostsSpa: boolean;
}): string {
  if (opts.hostsSpa) return `http://localhost:${opts.port}`;
  return `http://localhost:${resolveWebPort()}`;
}

/**
 * The URL local code uses to talk to the running server's API.
 *
 * Differs from publicBaseUrl deliberately:
 *   - `publicBaseUrl` is for HUMANS. It may point at a public
 *     Cloudflare tunnel hostname.
 *   - `localServerBaseUrl` is for IN-PROCESS PROBES (doctor's
 *     health check, the wizard waiting for the server to come
 *     up). Those must hit localhost on the actual bind port,
 *     regardless of any public override — otherwise doctor
 *     would try to probe a tunnel that may be off.
 *
 * No trailing slash.
 */
export function resolveLocalServerBaseUrl(ctx: UrlContext = {}): string {
  return `http://localhost:${resolveServerPort(ctx)}`;
}

/** Convenience: build the URL for `tenants/<t>/users/<u>/`. */
export function buildTenantUserUrl(
  baseUrl: string,
  tenantId: string,
  userId: string,
): string {
  return `${stripTrailingSlash(baseUrl)}/tenants/${tenantId}/users/${userId}/`;
}

// ─── helpers ────────────────────────────────────────────────

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function safeLoadConfig(): GlobalConfig | undefined {
  try {
    return loadGlobalConfig();
  } catch {
    return undefined;
  }
}
