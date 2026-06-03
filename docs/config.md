# Configuration

Tianshu has two layers of configuration:

```
~/.tianshu/config.json                          ← global (process-wide)
~/.tianshu/tenants/<tenantId>/config.json       ← per-tenant override
```

(Override the home dir via `TIANSHU_HOME=/path` env var.)

**Real config files never live in this repo.** Only
[`config.example.json`](../config.example.json) is committed; copy it to
`~/.tianshu/config.json` and edit. The repo's `.gitignore` actively
blocks `~/.tianshu/`, `tianshu-home/`, `tianshu.models.json`, and
similar paths to keep secrets out.

## Override rules (ADR-0001 §7)

A tenant config is **only** allowed to set these fields:

| Field | Notes |
| --- | --- |
| `defaultModel` | string |
| `models` | full provider catalog (see below) |
| `worker` | `{count, pollMs, model}` — partial OK, deep-merged with global |
| `oauth` | array of OAuth/OIDC provider configs |
| `branding` | `{name, emoji}` — deep-merged |
| `apiKeys` | flat `{providerName: key}` map — deep-merged |

The following are **global-only** and a tenant config that tries to set
them is rejected at load time:

| Field | Reason |
| --- | --- |
| `server` | port / cors / publicUrl — process-wide |
| `logging` | log level / output — process-wide |
| `autoCreateDefault` | controls boot behaviour |
| `builtinConfigDir` | filesystem layout |

## Provider catalog (`models`)

Mirrors the closed-source predecessor's `tianshu.models.json` for easy
transplant.

```jsonc
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "api":     "anthropic-messages",
        "apiKey":  "${ANTHROPIC_API_KEY}",
        "group":   "Cloud",
        "models": [
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6",
            "contextWindow": 1048576, "maxTokens": 65536 }
        ]
      },
      "local-llama": {
        "baseUrl": "http://localhost:8083/v1",
        "api":     "openai-completions",
        "group":   "Local",
        "apiKey":  "sk-no-key",
        "models": [
          { "id": "Qwen3.6-35B-A3B-Q8_0.gguf", "name": "Qwen3.6 35B (Local)",
            "contextWindow": 262144, "maxTokens": 8192 }
        ]
      }
    }
  }
}
```

`apiKey` accepts `${VAR}` and `${VAR:-fallback}` placeholders. They are
resolved at request time (not at load), so secrets never sit in
process memory longer than necessary.

The model id surfaced to users is `<providerId>/<modelEntry.id>`, e.g.
`anthropic/claude-sonnet-4-6` or `local-llama/Qwen3.6-35B-A3B-Q8_0.gguf`.

## Quick start

```bash
# 1) Drop the example into TIANSHU_HOME
mkdir -p ~/.tianshu
cp config.example.json ~/.tianshu/config.json

# 2) Strip the // comments (the loader is plain JSON, not JSON5)
#    and edit the providers / apiKey / defaultModel.

# 3) Set provider keys via env (matches the ${VAR} placeholders above)
export ANTHROPIC_API_KEY=sk-ant-...

# 4) Boot
npm run dev
```

## Storing API keys

Two acceptable patterns:

1. **`${ENV_VAR}` placeholder + shell env** (preferred for self-host).
   The literal key never lives on disk in `config.json`.
2. **Plain string in `config.json`**.
   File mode is `0600` after our atomic writes — readable only by you
   on a single-user machine, but a string in a config file is still a
   secret on disk; treat backups accordingly.

OAuth client secrets and similar **must** live in
`~/.tianshu/tenants/<id>/secrets/` (mode `0700`), not in `config.json`.
PR #20 creates that directory; PR #21+ wires reads.
