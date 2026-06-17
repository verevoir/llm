# @verevoir/llm

Provider-agnostic LLM call surface with token + cost accounting. The core export
holds the contract and shared types; provider SDK adapters live in subpaths so
consumers only pay for the SDK they actually use.

## Status

**`0.1.0`** — first deliberate release. Pre-stable: the `0.x` line communicates
that the API surface can shift before `1.0`. Bumps to `1.0` follow validation
by the first real consumer.

## Install

```bash
npm install @verevoir/llm @anthropic-ai/sdk
```

Each provider SDK is an **optional peer dependency** — install only the SDK(s)
that match the subpath(s) you import.

## Quickstart (Anthropic)

```ts
import { anthropic } from '@verevoir/llm/anthropic';

const reply = await anthropic.chat({
  systemPrompt: 'You are a helpful assistant.',
  turns: [{ role: 'user', content: 'Hello' }],
  apiKey: process.env.ANTHROPIC_API_KEY!,
  modelClass: 'reasoning',
});

console.log(reply.content);
// reply.usage → { provider, model, direction, inputTokens, outputTokens, ... }
```

## Why subpaths

The core export (`@verevoir/llm`) carries provider-agnostic types — `TokenUsage`,
`PerModelUsage`, `ModelClass`, the `chat()` contract, cost-accounting helpers.
Each adapter lives under its own subpath so the unused provider SDK never
enters the consumer's bundle:

| Subpath                   | SDK dep             | Status                  |
| ------------------------- | ------------------- | ----------------------- |
| `@verevoir/llm`           | none                | shipped                 |
| `@verevoir/llm/anthropic` | `@anthropic-ai/sdk` | shipped                 |
| `@verevoir/llm/google`    | `@google/genai`     | `chat()` only (`0.4.0`) |
| `@verevoir/llm/openai`    | `openai`            | `chat()` only (`0.5.0`) |
| `@verevoir/llm/deepseek`  | `openai`            | `chat()` only (`0.6.0`) |

Multi-provider deployments depend on the same `chat()` contract; consumers
switch backends by importing a different subpath, not by changing call sites.

## Provider endpoints & routing

Every adapter authenticates with `<PROVIDER>_API_KEY` and can be pointed at a
different endpoint with `<PROVIDER>_BASE_URL` — a gateway, proxy, regional, or
self-hosted endpoint — without a code change:

| Provider        | Key env                             | Base-URL override                     |
| --------------- | ----------------------------------- | ------------------------------------- |
| OpenAI          | `OPENAI_API_KEY`                    | `OPENAI_BASE_URL`                     |
| Anthropic       | `ANTHROPIC_API_KEY`                 | `ANTHROPIC_BASE_URL`                  |
| Google (Gemini) | `GEMINI_API_KEY` / `GOOGLE_API_KEY` | `GEMINI_BASE_URL` / `GOOGLE_BASE_URL` |
| Mistral         | `MISTRAL_API_KEY`                   | `MISTRAL_BASE_URL`                    |
| DeepSeek        | `DEEPSEEK_API_KEY`                  | `DEEPSEEK_BASE_URL`                   |
| SambaNova       | `SAMBA_NOVA_API_KEY`                | `SAMBA_NOVA_BASE_URL`                 |

The override is keyed by **provider/endpoint, not model**: running DeepSeek-V3
_via SambaNova_ uses `SAMBA_NOVA_*`, not `DEEPSEEK_*`.

Because the same model family is served by several providers, **routing**
resolves a desired model to a concrete provider:

- `providersForFamily(family)` — which providers serve a family.
- `isProviderConfigured(provider)` / `configuredProviders()` — which have a
  usable credential right now.
- `resolveModel({ family?, modelClass?, configuredOnly?, prefer? })` — pick one:
  cheapest configured by default, or by explicit `prefer` order; `null` on no
  match.

Routing sees only providers whose subpath has been imported (same as the model
catalog).

## Cost accounting

Every call returns a `TokenUsage` shaped as
`{ provider, model, direction, inputTokens, outputTokens, ... }`. The package
exports `sumUsages`, `formatTokensCompact`, and a per-model rate table so
per-conversation / per-project rollups need no external lookups. The
**direction** field tracks the model-class semantic (`reasoning` /
`extraction`) so rollups can break down "spent X on reasoning + Y on extraction"
natively.

## See also

- [`llms.txt`](./llms.txt) — LLM-agent-facing description of this package.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.
- [`examples/`](./examples/) — runnable usage examples per subpath (land with
  the extraction slice).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
