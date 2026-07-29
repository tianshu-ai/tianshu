/**
 * OAuth Token Manager — auto-refreshes OAuth tokens for providers
 * configured with `auth: "oauth"` in config.json.
 *
 * Currently supports Google (Gemini) via Gemini CLI credentials.
 * Runs at server boot and sets up a refresh timer.
 *
 * The access token is stored in process.env.GOOGLE_OAUTH_TOKEN so
 * the existing apiKey="${GOOGLE_OAUTH_TOKEN}" placeholder resolves it.
 */

import { getGlobalConfigPath, getTianshuHome } from "../core/paths.js";
import {
  extractGeminiCliCredentials,
  refreshGeminiToken,
  tokenNeedsRefresh,
  type GeminiOAuthCredentials,
  type GeminiOAuthTokens,
} from "../setup/gemini-oauth.js";
import fs from "node:fs";

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function initOAuthTokenManager(): Promise<void> {
  const home = getTianshuHome();
  const configPath = getGlobalConfigPath(home);
  if (!fs.existsSync(configPath)) return;

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return;
  }

  const providers = (config as { models?: { providers?: Record<string, unknown> } })
    .models?.providers;
  if (!providers) return;

  // Find Google OAuth provider
  const google = providers.google as {
    auth?: string;
    oauth?: {
      refreshToken?: string;
      expiresAt?: number;
      email?: string;
    };
  } | undefined;

  if (google?.auth !== "oauth" || !google.oauth?.refreshToken) return;

  // Extract CLI credentials for refresh
  const cliCreds = extractGeminiCliCredentials();
  if (!cliCreds) {
    console.warn(
      "[oauth] Google OAuth configured but Gemini CLI not found. " +
      "Cannot refresh tokens. Install: npm i -g @google/gemini-cli",
    );
    return;
  }

  const tokens: GeminiOAuthTokens = {
    accessToken: "",
    refreshToken: google.oauth.refreshToken,
    expiresAt: google.oauth.expiresAt ?? 0,
    email: google.oauth.email,
  };

  // Initial refresh
  await doRefresh(cliCreds, tokens, configPath);

  // Refresh every 45 minutes (token lasts 1h)
  refreshTimer = setInterval(
    () => doRefresh(cliCreds, tokens, configPath),
    45 * 60_000,
  );
  refreshTimer.unref(); // don't keep the process alive
}

async function doRefresh(
  creds: GeminiOAuthCredentials,
  tokens: GeminiOAuthTokens,
  configPath: string,
): Promise<void> {
  try {
    if (!tokens.accessToken || tokenNeedsRefresh(tokens)) {
      const refreshed = await refreshGeminiToken(creds, tokens);
      tokens.accessToken = refreshed.accessToken;
      tokens.refreshToken = refreshed.refreshToken;
      tokens.expiresAt = refreshed.expiresAt;

      // Persist updated refresh token to config (in case it rotated)
      try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (config.models?.providers?.google?.oauth) {
          config.models.providers.google.oauth.refreshToken = tokens.refreshToken;
          config.models.providers.google.oauth.expiresAt = tokens.expiresAt;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
        }
      } catch {}
    }

    // Set env var so ${GOOGLE_OAUTH_TOKEN} resolves
    process.env.GOOGLE_OAUTH_TOKEN = tokens.accessToken;
    console.log(
      `[oauth] Google token refreshed${tokens.email ? ` (${tokens.email})` : ""}, ` +
      `expires ${new Date(tokens.expiresAt).toLocaleTimeString()}`,
    );
  } catch (err) {
    console.error(
      `[oauth] Google token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function stopOAuthTokenManager(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
