# @verevoir/llm

Provider-agnostic LLM call surface with token + cost accounting. The core export
holds the contract and shared types; provider SDK adapters live in subpaths so
consumers only pay for the SDK they actually use.

## Status

`v0` in progress — the surface is being extracted from a private consumer
(aigency-web). The first published version targets Anthropic via
`@verevoir/llm/anthropic`. Calls throw with "extraction in progress" until the
implementation lands.

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

| Subpath                   | SDK dep             | Status     |
| ------------------------- | ------------------- | ---------- |
| `@verevoir/llm`           | none                | extracting |
| `@verevoir/llm/anthropic` | `@anthropic-ai/sdk` | extracting |
| `@verevoir/llm/google`    | `@google/genai`     | planned    |

Multi-provider deployments depend on the same `chat()` contract; consumers
switch backends by importing a different subpath, not by changing call sites.

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
