# Known model limits

This file is a curated reference of `contextWindow` and `maxTokens`
values for models tianshu users commonly configure. It exists
because:

- catalogs in `config.json` hand-rolled by users (or the cli-agent)
  often ship with conservative / stale values, leaving real
  capability on the floor (e.g. `maxTokens: 8192` for a model that
  actually supports 32k+)
- the server falls back to `contextWindow: 128_000 / maxTokens: 4_096`
  for any field left blank — fine but not great
- provider docs drift between releases, so a static table goes stale
  quickly; we keep this file under git so changes are auditable and
  the `lastVerified` column tells users / agents when a row was last
  cross-checked

## How tianshu uses this file

- `tianshu doctor` cross-references each catalog entry against this
  table. When the catalog value is **lower** than the table's
  value, doctor emits a soft warning ("dashscope/qwen3-max-preview
  has maxTokens=8192 in your catalog; this table records 32768 as
  the provider's current ceiling — bump to use full capacity?").
  Catalogs that match or **exceed** the table value get no warning —
  the user might know something we don't.
- `tianshu setup` cli-agent reads this file before writing a fresh
  catalog entry, picking the recorded ceiling so new providers ship
  with reasonable defaults instead of the 128k/4k fallback.
- Both layers treat absent rows as "no opinion": doctor stays quiet,
  cli-agent falls back to `web_fetch` against the provider's docs
  before committing.

## Maintenance rules

- **Source URLs are required.** Every row must cite the provider doc
  it was copied from. PRs that change a row must update both the
  value and the URL/date.
- **lastVerified date is when a human last cross-checked the value
  against the source URL.** Update when bumping a value; otherwise
  leave it alone so we know how stale we are.
- **Conservative on inputs, accurate on outputs.** When provider
  docs give a range or note caveats ("up to X with extended thinking
  enabled"), record the *base* value and add a note. Users who need
  the extended ceiling can override per-model.
- **Don't guess from training memory.** Limits change release-over-
  release; only record what's currently documented.

## Reading the table

- `ctx` = `contextWindow`: total token budget (input + output)
- `max` = `maxTokens`: per-response output cap
- All values in tokens.
- `note` calls out caveats (extended-thinking modes, reasoning
  budgets, image input handling, etc.).

---

## Anthropic (`api: anthropic-messages`)

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `claude-opus-4-5` | 1_000_000 | 64_000 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | extended thinking up to ~64k more |
| `claude-opus-4-6` | 1_000_000 | 64_000 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | |
| `claude-opus-4-7` | 1_000_000 | 64_000 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | |
| `claude-sonnet-4-5` | 1_000_000 | 64_000 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | |
| `claude-sonnet-4-6` | 1_000_000 | 64_000 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | |
| `claude-3-7-sonnet-20250219` | 200_000 | 64_000 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | |
| `claude-3-5-sonnet-20241022` | 200_000 | 8_192 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | legacy; bumped to 8192 in Oct '24 |
| `claude-3-5-haiku-20241022` | 200_000 | 8_192 | 2026-06-21 | https://docs.anthropic.com/en/docs/about-claude/models/overview | |

## OpenAI (`api: openai-completions` for chat completions endpoint)

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `gpt-5` | 400_000 | 128_000 | 2026-06-21 | https://platform.openai.com/docs/models/gpt-5 | reasoning model; respects reasoning_effort |
| `gpt-5-mini` | 400_000 | 128_000 | 2026-06-21 | https://platform.openai.com/docs/models/gpt-5-mini | |
| `gpt-4o` | 128_000 | 16_384 | 2026-06-21 | https://platform.openai.com/docs/models/gpt-4o | |
| `gpt-4o-mini` | 128_000 | 16_384 | 2026-06-21 | https://platform.openai.com/docs/models/gpt-4o-mini | |
| `o4-mini` | 200_000 | 100_000 | 2026-06-21 | https://platform.openai.com/docs/models/o4-mini | reasoning model |
| `o3` | 200_000 | 100_000 | 2026-06-21 | https://platform.openai.com/docs/models/o3 | reasoning model |

## Google (`api: google-generative-ai`)

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `gemini-2.5-pro` | 1_048_576 | 65_536 | 2026-06-21 | https://ai.google.dev/gemini-api/docs/models | output `8192` text + `64k` reasoning combined |
| `gemini-2.5-flash` | 1_048_576 | 65_536 | 2026-06-21 | https://ai.google.dev/gemini-api/docs/models | |
| `gemini-2.5-flash-lite` | 1_048_576 | 65_536 | 2026-06-21 | https://ai.google.dev/gemini-api/docs/models | |
| `gemini-3-pro-preview` | 1_048_576 | 65_536 | 2026-06-21 | https://ai.google.dev/gemini-api/docs/models | preview channel; values may drift |

## Alibaba Cloud Dashscope (Qwen, `api: openai-completions`)

OpenAI-compatible mode at `https://dashscope.aliyuncs.com/compatible-mode/v1`.

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `qwen3-max-preview` | 256_000 | 32_768 | 2026-06-21 | https://help.aliyun.com/zh/model-studio/models | check `max_tokens` column under text-generation models |
| `qwen3-max` | 256_000 | 32_768 | 2026-06-21 | https://help.aliyun.com/zh/model-studio/models | |
| `qwen3-plus` | 131_072 | 16_384 | 2026-06-21 | https://help.aliyun.com/zh/model-studio/models | |
| `qwen3-flash` | 131_072 | 16_384 | 2026-06-21 | https://help.aliyun.com/zh/model-studio/models | |

## Volcengine Ark (`api: openai-completions`)

OpenAI-compatible at `https://ark.cn-beijing.volces.com/api/v3`.

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `kimi-k2.5` | 256_000 | 32_768 | 2026-06-21 | https://www.volcengine.com/docs/82379 | |
| `doubao-seed-1.6` | 256_000 | 16_384 | 2026-06-21 | https://www.volcengine.com/docs/82379 | |

## Moonshot Kimi (direct, `api: openai-completions`)

Direct endpoint at `https://api.moonshot.cn/v1`.

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `moonshot-v1-128k` | 128_000 | 8_192 | 2026-06-21 | https://platform.moonshot.cn/docs/intro | |
| `kimi-k2-0905-preview` | 256_000 | 32_768 | 2026-06-21 | https://platform.moonshot.cn/docs/intro | |

## DeepSeek (`api: openai-completions`)

Direct endpoint at `https://api.deepseek.com/v1`.

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `deepseek-chat` | 128_000 | 8_192 | 2026-06-21 | https://api-docs.deepseek.com/quick_start/pricing | |
| `deepseek-reasoner` | 128_000 | 8_192 | 2026-06-21 | https://api-docs.deepseek.com/quick_start/pricing | reasoning model |

## Mistral (`api: mistral-conversations`)

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `mistral-large-2411` | 128_000 | 16_384 | 2026-06-21 | https://docs.mistral.ai/getting-started/models/models_overview/ | |
| `mistral-medium-2505` | 128_000 | 16_384 | 2026-06-21 | https://docs.mistral.ai/getting-started/models/models_overview/ | |
| `codestral-2501` | 256_000 | 16_384 | 2026-06-21 | https://docs.mistral.ai/getting-started/models/models_overview/ | code-tuned |

## llama.cpp / local llama-server (`api: openai-completions`)

Model id depends on the GGUF you loaded; these are the per-quant
ceilings most commonly seen with the GGUF/Q8 quants the team uses
on the Mac Studio M3 Ultra. Adjust based on `-c` (context size)
flag you passed to `llama-server`.

| model id | ctx | max | lastVerified | source | note |
| --- | ---:| ---:| --- | --- | --- |
| `Qwen3.6-35B-A3B-Q8_0.gguf` | 262_144 | 32_768 | 2026-06-21 | https://huggingface.co/Qwen/Qwen3.6-35B-A3B | ctx limited by what you pass to `llama-server -c` |
| `MiniMax-M2.1-Q4_K_XL.gguf` | 1_000_000 | 32_768 | 2026-06-21 | https://huggingface.co/MiniMaxAI/MiniMax-M2.1 | |
| `GLM-4.7-Q8_0.gguf` | 128_000 | 32_768 | 2026-06-21 | https://huggingface.co/zai-org/GLM-4.7 | |

---

## Adding a row

1. Open the provider's official model page (linked in `source`)
   and copy the **current** `context length` and `max output tokens`.
2. Convert to integers (no `K`/`M` shorthand).
3. Sanity check: `max ≤ ctx`. If the doc reads `1M / 64k`, write
   `ctx=1_048_576` (or whatever the exact number is — providers
   sometimes round) and `max=65_536`.
4. Set `lastVerified` to today's UTC date.
5. Run `tianshu doctor` to confirm the new row doesn't break any
   internal consistency check.

## Removing a row

Models get deprecated. When a provider removes a model from their
catalog (or it stops accepting traffic), delete the row outright
rather than commenting it out — the git history preserves it for
posterity.
