// Per-tenant per-plugin secret storage.
//
// Why a separate file from `<tenant>/config.json`:
//   - config.json is the public-ish shape: a leak (or an
//     accidental git commit, or a bug in a backup script) gives
//     up plugin layout + tenant settings, but NOT credentials.
//     Secrets live in their own file under `<tenant>/secrets/`,
//     a directory the host already creates with mode 0700 (see
//     `getTenantSecretsDir` in core/paths.ts).
//   - the `secret` config field's redaction contract relies on
//     not having to redact a structured config blob \u2014 the secret
//     is simply absent from `config.json` reads, so there's
//     nothing to scrub.
//
// Layout:
//   <tenant>/secrets/plugin-<pluginId>.json
//   {
//     "<dotted.key>": "<cleartext>",
//     ...
//   }
//
// File mode: 0600. Directory mode: 0700 (set by paths.ts).
//
// API surface:
//   - `loadPluginSecrets(secretsDir, pluginId)`: read the file,
//     return a flat map of dotted-key -> cleartext. Missing file
//     means {} (no secrets configured).
//   - `mergePluginSecrets(rawConfig, secrets)`: splice each
//     dotted key from `secrets` into a deep-cloned copy of the
//     raw config object. Used by the registry just before passing
//     `pluginConfig` to the plugin's activate().
//   - `applyPluginSecretPatch(secretsDir, pluginId, patch)`: PATCH
//     semantics for the plugin admin endpoint. Returns the new
//     map plus a boolean `changed` flag.
//   - `redactSecretsInConfig(rawConfig, fields)`: GET-side
//     redaction. Replaces each secret's value with
//     `{ __secret: true, set: <bool> }` so the form can render a
//     "set / unset" indicator without ever sending cleartext to
//     the browser.

import fs from "node:fs";
import path from "node:path";
import type { PluginConfigField } from "@tianshu-ai/plugin-sdk";

export interface SecretMap {
  [dottedKey: string]: string;
}

export type SecretPatch = Record<
  string,
  string | { __secret: true; clear: true }
>;

function secretFilePath(secretsDir: string, pluginId: string): string {
  // `pluginId` is validated upstream (alphanumeric / dashes); the
  // join is safe.
  return path.join(secretsDir, `plugin-${pluginId}.json`);
}

export function loadPluginSecrets(
  secretsDir: string,
  pluginId: string,
): SecretMap {
  const file = secretFilePath(secretsDir, pluginId);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: SecretMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    // Malformed file shouldn't break activation; just skip secrets.
    return {};
  }
}

function writePluginSecrets(
  secretsDir: string,
  pluginId: string,
  secrets: SecretMap,
): void {
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const file = secretFilePath(secretsDir, pluginId);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  // Mode 0600 explicitly so a permissive umask doesn't widen it.
  fs.writeFileSync(tmp, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * PATCH semantics. `patch` is an object whose keys are dotted
 * paths into the plugin config:
 *   - string value      -> set the secret
 *   - { __secret: true, clear: true } -> remove the secret
 *   - other shapes      -> ignored (defensive; the schema shouldn't
 *                          permit them, but we don't want one bad
 *                          field to crash a save)
 *
 * Returns `{ secrets, changed }`. `changed` is false when the
 * patch was a no-op so the caller can skip the rewrite (matters
 * for "user clicks save without touching anything" \u2014 the form
 * sends back the redacted shape verbatim).
 */
export function applyPluginSecretPatch(
  secretsDir: string,
  pluginId: string,
  patch: SecretPatch,
): { secrets: SecretMap; changed: boolean } {
  const secrets = loadPluginSecrets(secretsDir, pluginId);
  let changed = false;
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === "string") {
      // Empty string means "leave it alone" \u2014 the form sends "" by
      // default for unset fields and we don't want to wipe a
      // configured key just because the user didn't type anything.
      if (v === "") continue;
      if (secrets[k] !== v) {
        secrets[k] = v;
        changed = true;
      }
    } else if (
      v &&
      typeof v === "object" &&
      (v as { __secret?: unknown }).__secret === true &&
      (v as { clear?: unknown }).clear === true
    ) {
      if (k in secrets) {
        delete secrets[k];
        changed = true;
      }
    }
    // Anything else: ignore.
  }
  if (changed) writePluginSecrets(secretsDir, pluginId, secrets);
  return { secrets, changed };
}

/**
 * Splice each dotted-key secret into a deep-cloned copy of
 * `rawConfig`, creating intermediate objects as needed. Returns a
 * NEW object so callers can hand the original to clients (which
 * see the redacted shape) and the merged copy to the plugin
 * (which sees cleartext).
 */
export function mergePluginSecrets(
  rawConfig: Record<string, unknown>,
  secrets: SecretMap,
): Record<string, unknown> {
  if (Object.keys(secrets).length === 0) return rawConfig;
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(rawConfig));
  for (const [k, v] of Object.entries(secrets)) {
    setDottedKey(out, k, v);
  }
  return out;
}

/**
 * Replace each secret field's value in `rawConfig` with the
 * redaction marker so a GET response never includes cleartext.
 * Mutates the passed object for simplicity \u2014 the caller already
 * builds a fresh object per request.
 *
 * `set` reflects whether the secrets file currently has a value
 * for that key; the form uses it to render "set" vs "unset".
 */
export function redactSecretsInConfig(
  rawConfig: Record<string, unknown>,
  fields: readonly PluginConfigField[],
  secrets: SecretMap,
): Record<string, unknown> {
  const out = { ...rawConfig };
  for (const f of fields) {
    if (f.kind !== "secret") continue;
    setDottedKey(out, f.key, {
      __secret: true,
      set: typeof secrets[f.key] === "string" && secrets[f.key].length > 0,
    });
  }
  return out;
}

function setDottedKey(
  obj: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cursor[k];
    if (!next || typeof next !== "object") {
      const fresh: Record<string, unknown> = {};
      cursor[k] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]!] = value;
}
