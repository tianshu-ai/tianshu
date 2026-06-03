# Security Policy

We take security seriously. If you believe you've found a security vulnerability
in Tianshu, please report it responsibly.

## Supported Versions

Tianshu is in active early-stage development. Only the `main` branch receives
security updates at this time.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | ✅                 |
| < 0.1   | ❌                 |

## Reporting a Vulnerability

**Please do _not_ open a public GitHub issue for security reports.**

Instead, email the maintainer directly:

- **Email:** ltjsjyyy@gmail.com
- **Subject prefix:** `[security] tianshu — <short description>`

Please include:

1. A description of the vulnerability and its potential impact
2. Steps to reproduce (or proof-of-concept code, if applicable)
3. Affected version / commit SHA
4. Your contact info for follow-up

### Response timeline

- **Acknowledgement:** within 72 hours
- **Initial triage / severity assessment:** within 7 days
- **Fix or mitigation plan:** depends on severity, typically 14-30 days

We'll credit reporters in the release notes / changelog unless you prefer to
remain anonymous.

## Out of Scope

The following are not considered vulnerabilities:

- Issues requiring physical access to a user's device
- Self-XSS that requires the victim to paste attacker-controlled code
- Vulnerabilities in third-party dependencies that don't affect Tianshu
  directly (please report those upstream)
- Missing security headers on `/api/health` (intentionally minimal)
- Brute-force attacks against `AUTH_MODE=dev` (dev mode is documented as
  insecure-by-design and must not be used in production)

## Hardening Checklist for Operators

If you're deploying Tianshu, please:

1. Set `AUTH_MODE=jwt` (never `dev` in production)
2. Generate strong secrets: `openssl rand -base64 32` for `JWT_SECRET` /
   `BETTER_AUTH_SECRET`
3. Restrict `CORS_ORIGIN` to your actual domain(s) — no wildcards
4. Run behind HTTPS (Cloudflare Tunnel, Caddy, nginx, etc.)
5. Mount `/app/data` on a persistent encrypted volume
6. Keep dependencies up to date (`npm audit`)
7. Disable self-registration (`ALLOW_REGISTRATION=0`) once you've created
   your initial admin account
