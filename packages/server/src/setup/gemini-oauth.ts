/**
 * Gemini CLI OAuth integration.
 *
 * Extracts OAuth client credentials from a locally-installed Gemini CLI,
 * then either reads existing tokens from ~/.gemini/ or runs a fresh
 * OAuth PKCE login flow with a local callback server on :8085.
 *
 * Token refresh uses the same client_id/secret extracted from the CLI.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────

export interface GeminiOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export interface GeminiOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms timestamp
  email?: string;
  projectId?: string;
}

// ─── Constants ────────────────────────────────────────────────────

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const REDIRECT_URI = "http://localhost:8085/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const TOKEN_BUFFER_MS = 5 * 60_000; // refresh 5min before expiry

// ─── CLI Credential Extraction ────────────────────────────────────

/**
 * Find the gemini CLI binary and extract its embedded OAuth
 * client_id + client_secret from the bundled JS source.
 */
export function extractGeminiCliCredentials(): GeminiOAuthCredentials | null {
  const geminiPath = findGeminiBinary();
  if (!geminiPath) return null;

  // Resolve symlinks to find the actual package directory
  let resolved: string;
  try {
    resolved = fs.realpathSync(geminiPath);
  } catch {
    return null;
  }

  // Walk up to find the gemini-cli package root
  const searchDirs = resolveSearchDirs(geminiPath, resolved);

  for (const dir of searchDirs) {
    const creds = searchForCredentials(dir);
    if (creds) return creds;
  }
  return null;
}

function findGeminiBinary(): string | null {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "gemini");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveSearchDirs(binPath: string, resolvedPath: string): string[] {
  const binDir = path.dirname(binPath);
  const candidates = [
    path.dirname(path.dirname(resolvedPath)),
    path.join(path.dirname(resolvedPath), "node_modules", "@google", "gemini-cli"),
    path.join(binDir, "node_modules", "@google", "gemini-cli"),
    path.join(path.dirname(binDir), "node_modules", "@google", "gemini-cli"),
    path.join(path.dirname(binDir), "lib", "node_modules", "@google", "gemini-cli"),
  ];
  return candidates.filter((d) => fs.existsSync(path.join(d, "package.json")));
}

function searchForCredentials(dir: string, depth = 10): GeminiOAuthCredentials | null {
  // Known paths first
  const knownPaths = [
    path.join(dir, "node_modules", "@google", "gemini-cli-core", "dist", "src", "code_assist", "oauth2.js"),
    path.join(dir, "node_modules", "@google", "gemini-cli-core", "dist", "code_assist", "oauth2.js"),
  ];
  for (const p of knownPaths) {
    const creds = tryParseCredFile(p);
    if (creds) return creds;
  }

  // Bundle dir
  const bundleDir = path.join(dir, "bundle");
  if (fs.existsSync(bundleDir)) {
    try {
      for (const entry of fs.readdirSync(bundleDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".js")) {
          const creds = tryParseCredFile(path.join(bundleDir, entry.name));
          if (creds) return creds;
        }
      }
    } catch {}
  }

  // Recursive search for oauth2.js
  return findOauth2InTree(dir, depth);
}

function findOauth2InTree(dir: string, depth: number): GeminiOAuthCredentials | null {
  if (depth <= 0) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "oauth2.js") {
        const creds = tryParseCredFile(fullPath);
        if (creds) return creds;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        const found = findOauth2InTree(fullPath, depth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function tryParseCredFile(filePath: string): GeminiOAuthCredentials | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const clientId =
      content.match(/OAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1] ??
      content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/)?.[1];
    const clientSecret =
      content.match(/OAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1] ??
      content.match(/(GOCSPX-[A-Za-z0-9_-]+)/)?.[1];
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch {}
  return null;
}

// ─── Read existing CLI tokens ─────────────────────────────────────

/** Try to read existing OAuth tokens from ~/.gemini/oauth_creds.json */
export function readExistingGeminiTokens(): GeminiOAuthTokens | null {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const credsPath = path.join(home, ".gemini", "oauth_creds.json");
  if (!fs.existsSync(credsPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(credsPath, "utf8"));
    const accessToken = data.access_token ?? data.accessToken;
    const refreshToken = data.refresh_token ?? data.refreshToken;
    if (!refreshToken) return null;
    return {
      accessToken: accessToken ?? "",
      refreshToken,
      expiresAt: data.expiry_date ?? data.expiresAt ?? data.expires_at ?? 0,
      email: data.email,
      projectId: data.project_id ?? data.projectId,
    };
  } catch {
    return null;
  }
}

// ─── OAuth PKCE Flow ──────────────────────────────────────────────

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(
  clientId: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Run a full OAuth login flow:
 * 1. Generate PKCE verifier/challenge
 * 2. Open browser to Google consent
 * 3. Listen on localhost:8085 for the callback
 * 4. Exchange code for tokens
 */
export async function loginGeminiOAuth(
  creds: GeminiOAuthCredentials,
  openUrl: (url: string) => void,
): Promise<GeminiOAuthTokens> {
  const { verifier, challenge } = generatePkce();
  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(creds.clientId, challenge, state);

  // Start local callback server
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost:8085");
      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization failed</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }
      if (!returnedCode) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>No code</h1>");
        server.close();
        reject(new Error("No authorization code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>✓ Authorization successful</h1><p>You can close this tab and return to the terminal.</p>",
      );
      server.close();
      resolve(returnedCode);
    });

    server.listen(8085, () => {
      openUrl(authUrl);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth login timed out (5 minutes)"));
    }, 300_000);
  });

  // Exchange code for tokens
  return exchangeCodeForTokens(creds, code, verifier);
}

async function exchangeCodeForTokens(
  creds: GeminiOAuthCredentials,
  code: string,
  verifier: string,
): Promise<GeminiOAuthTokens> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;

  // Fetch user email
  let email: string | undefined;
  try {
    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as { email?: string };
      email = user.email;
    }
  } catch {}

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt,
    email,
  };
}

// ─── Token Refresh ────────────────────────────────────────────────

export async function refreshGeminiToken(
  creds: GeminiOAuthCredentials,
  tokens: GeminiOAuthTokens,
): Promise<GeminiOAuthTokens> {
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    email: tokens.email,
    projectId: tokens.projectId,
  };
}

/** Check if token needs refresh (expired or within buffer). */
export function tokenNeedsRefresh(tokens: GeminiOAuthTokens): boolean {
  return Date.now() + TOKEN_BUFFER_MS >= tokens.expiresAt;
}

/**
 * Get a valid access token, refreshing if needed.
 * Mutates the tokens object in place on refresh.
 */
export async function getValidAccessToken(
  creds: GeminiOAuthCredentials,
  tokens: GeminiOAuthTokens,
): Promise<string> {
  if (tokenNeedsRefresh(tokens)) {
    const refreshed = await refreshGeminiToken(creds, tokens);
    tokens.accessToken = refreshed.accessToken;
    tokens.refreshToken = refreshed.refreshToken;
    tokens.expiresAt = refreshed.expiresAt;
  }
  return tokens.accessToken;
}
