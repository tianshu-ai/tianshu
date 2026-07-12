// Auth configuration health check.
//
// Answers two operator questions the setup flow otherwise leaves unsaid:
//   1. How do I configure a super-admin (the first account that can log in)?
//   2. Is my current auth config actually correct / loginable?
//
// Runs against the global config + resolved ${VAR} secrets. Never prints
// secret VALUES — only whether they resolve to something non-empty.

import fs from "node:fs";
import { CheckGroup } from "../render.js";
import {
  loadGlobalConfig,
  expandEnvPlaceholders,
  type AuthConfig,
} from "../../core/config.js";
import { getAuthDbPath, getTianshuHome } from "../../core/paths.js";

export interface AuthCheckOpts {
  home?: string;
}

/** Guidance shown whenever auth is on but a super-admin isn't loginable. */
const SUPERADMIN_HOWTO =
  'Add a super-admin to ~/.tianshu/config.json → auth.superAdmins, e.g.\n' +
  '  "auth": {\n' +
  '    "enabled": true,\n' +
  '    "sessionSecret": "${TIANSHU_AUTH_SECRET}",\n' +
  '    "superAdmins": [{ "username": "admin", "password": "${TIANSHU_ADMIN_PASSWORD}" }]\n' +
  '  }\n' +
  "The password supports ${VAR} placeholders (keep plaintext out of the file).\n" +
  "On next start it's scrypt-hashed into auth.db; log in at /login with it.";

export function checkAuth(opts: AuthCheckOpts = {}): CheckGroup {
  const home = opts.home ?? getTianshuHome();
  const lines: CheckGroup["lines"] = [];

  let cfg: AuthConfig;
  try {
    cfg = loadGlobalConfig(home).auth ?? {};
  } catch (err) {
    lines.push({
      severity: "blocker",
      text: "failed to read auth config",
      detail: err instanceof Error ? err.message : String(err),
    });
    return { title: "Authentication", lines };
  }

  // Auth off → nothing to validate. Say so + how to turn it on.
  if (!cfg.enabled) {
    lines.push({
      severity: "ok",
      text: "disabled (open dev mode — no login wall)",
      detail:
        'Set auth.enabled=true in ~/.tianshu/config.json to require sign-in.\n' +
        SUPERADMIN_HOWTO,
    });
    return { title: "Authentication", lines };
  }

  lines.push({ severity: "ok", text: "enabled (sign-in required)" });

  // Session secret must resolve to something non-empty.
  const secret = expandEnvPlaceholders(cfg.sessionSecret) ?? "";
  if (!secret) {
    lines.push({
      severity: "blocker",
      text: "auth.sessionSecret is empty / unresolved",
      detail:
        cfg.sessionSecret
          ? `"${cfg.sessionSecret}" resolved to empty — is the env var set?`
          : "set auth.sessionSecret (a random string, or a ${VAR} that resolves). The server refuses to start without it.",
    });
  } else {
    lines.push({ severity: "ok", text: "sessionSecret resolves" });
  }

  // At least one way to log in: OAuth providers, super-admins, or open
  // registration. This mirrors assertAuthArmable's boot-time gate.
  const providers = cfg.providers ?? [];
  const superAdmins = cfg.superAdmins ?? [];
  const emailAdmins = cfg.admins ?? [];
  const hasLoginMethod =
    providers.length > 0 || superAdmins.length > 0 || !!cfg.allowRegistration;
  if (!hasLoginMethod) {
    lines.push({
      severity: "blocker",
      text: "no way to log in",
      detail:
        "auth.enabled=true but there are no providers, no superAdmins, and allowRegistration is off — nobody can sign in.\n" +
        SUPERADMIN_HOWTO,
    });
  }

  // Super-admin accounts: each must have a username + a password that
  // resolves. This is THE "first login" account.
  if (superAdmins.length === 0 && emailAdmins.length === 0) {
    lines.push({
      severity: "warning",
      text: "no super-admin configured",
      detail:
        "No auth.superAdmins (local) and no auth.admins (OAuth email). Without one, nobody has global admin — and a fresh install has no tenant memberships, so non-admins can't sign in either.\n" +
        SUPERADMIN_HOWTO,
    });
  }

  for (const sa of superAdmins) {
    const username = sa.username?.trim();
    if (!username) {
      lines.push({
        severity: "blocker",
        text: "a superAdmins entry has an empty username",
      });
      continue;
    }
    const pw = expandEnvPlaceholders(sa.password) ?? "";
    if (!pw) {
      lines.push({
        severity: "blocker",
        text: `super-admin "${username}": password empty / unresolved`,
        detail: sa.password
          ? `"${sa.password}" resolved to empty — is the env var set? This account can't log in until it resolves.`
          : "set a password (or a ${VAR} placeholder that resolves).",
      });
    } else {
      lines.push({
        severity: "ok",
        text: `super-admin "${username}" ready`,
        detail:
          "log in at /login with this username + the configured password (scrypt-hashed into auth.db on start).",
      });
    }
  }

  for (const email of emailAdmins) {
    lines.push({
      severity: "ok",
      text: `OAuth super-admin: ${email}`,
      detail: "this email, when it logs in via a provider, is a global admin.",
    });
  }

  // OAuth providers sanity: each needs clientId + a resolvable secret +
  // an endpoint source (issuer OR explicit URLs).
  for (const pr of providers) {
    const problems: string[] = [];
    if (!pr.clientId) problems.push("missing clientId");
    if (!(expandEnvPlaceholders(pr.clientSecret) ?? "")) problems.push("clientSecret empty/unresolved");
    const hasIssuer = !!pr.issuer;
    const hasExplicit = !!(pr.authorizeUrl && pr.tokenUrl && pr.userInfoUrl);
    if (!hasIssuer && !hasExplicit) {
      problems.push("no issuer and no explicit authorize/token/userInfo URLs");
    }
    if (problems.length > 0) {
      lines.push({
        severity: "warning",
        text: `provider "${pr.id}": ${problems.join("; ")}`,
      });
    } else {
      lines.push({ severity: "ok", text: `provider "${pr.id}" configured` });
    }
  }

  // auth.db presence (informational — created on first boot).
  const dbPath = getAuthDbPath(home);
  if (fs.existsSync(dbPath)) {
    lines.push({ severity: "ok", text: "auth.db present", detail: dbPath });
  } else {
    lines.push({
      severity: "ok",
      text: "auth.db not created yet (created on first start)",
      detail: dbPath,
    });
  }

  return { title: "Authentication", lines };
}
