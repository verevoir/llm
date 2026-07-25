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

**Anthropic — subscription OAuth, preferred over the metered key.** When
`CLAUDE_CODE_OAUTH_TOKEN` is set (a Claude subscription token from
`claude setup-token`), the Anthropic adapter authenticates with it as a bearer
token — the same credential the Claude Code CLI and the CI review gate use —
instead of billing `ANTHROPIC_API_KEY`. Precedence: an explicit per-call `apiKey`
(BYOK) → `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` (the metered key is only
the fallback, used when not already authenticated). The subscription token
requires an `anthropic-beta` flag and a Claude-Code system identity on each
request; both are sent automatically and are overridable via
`ANTHROPIC_OAUTH_BETA` / `ANTHROPIC_OAUTH_SYSTEM` should Anthropic revise them.

The override is keyed by **provider/endpoint, not model**: running DeepSeek-V3
_via SambaNova_ uses `SAMBA_NOVA_*`, not `DEEPSEEK_*`. Setting only
`OPENAI_BASE_URL` (no key) is treated as a **keyless local endpoint** (LM Studio
/ Ollama / vLLM) — the generic OpenAI client builds with a placeholder key and
routing counts it usable. Hosted providers (Anthropic, Gemini, SambaNova,
Mistral, DeepSeek) always need their key; a base-URL override alone does not make
them configured.

Because the same model family is served by several providers, **routing**
resolves a desired model to a concrete provider:

- `providersForFamily(family)` — which providers serve a family.
- `isProviderConfigured(provider)` / `configuredProviders()` — which have a
  usable credential right now.
- `resolveModel({ family?, modelClass?, configuredOnly?, prefer? })` — pick one:
  cheapest configured by default, or by explicit `prefer` order; `null` on no
  match.
- `resolveModelByTerm(term, opts?)` — resolve a loose term (`"deepseek"`) or an
  exact family/id to a catalog entry (exact wins over substring).
- `modelConnection(term, opts?)` — a ready OpenAI-compatible connection
  `{ provider, modelId, baseUrl, apiKey }` for a resolved term, so a config can
  name a model by family and bind it to a real endpoint + current version.
  `null` for an SDK-only provider (Anthropic / Gemini).

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

## Model-span audit hook

`setModelSpanSink(sink)` registers an optional, process-wide sink that fires
once per underlying model call with a `ModelSpan`: the call's `TokenUsage`
plus the emitting `scope` (`<provider>.<entry>`, e.g.
`anthropic.chatWithToolLoop`, `samba.chat`). Every adapter emits it from every
entry point — `chat`, `chatWithTools`, and `chatWithToolLoop` alike — so a
consumer can audit every model call across providers from one registration,
independent of any per-call `onUsage` hook. Because emission is per underlying
model call, a single `chatWithToolLoop` call yields **one span per iteration**:
expect multiple spans from one loop, each carrying that iteration's own usage
(not the aggregate). Off by default (no sink, no behaviour change); a throwing
sink is caught and warned, never breaking the call. Pass `null` to detach.

## Advisor pair

`withAdvisor(tools, executor, advisor)` (core export, SDK-free) turns any tool
loop into a **pair**: a cheap executor model does the work, and a
`consult_advisor` tool puts a stronger model one call away when it hits a
decision it cannot confidently resolve. The advisor **guides — it never
certifies**: its answer comes back as an ordinary tool result and the executor
carries on. The advisor is dependency-injected as a `chat` function, so any
adapter (or your own function) can answer:

```ts
import { withAdvisor } from '@verevoir/llm';
import { anthropic } from '@verevoir/llm/anthropic';
import { chatWithToolLoop } from '@verevoir/llm/samba';

const { tools, executor } = withAdvisor(myTools, myExecutor, {
  chat: anthropic.chat, // the advisor model — any adapter's chat
  systemPrompt: 'You are the senior reviewer. Hold answers to the practices.',
  onConsult: ({ question, usage }) => recordConsult(question, usage), // optional metrics
});

const result = await chatWithToolLoop({
  systemPrompt: 'Do the task. Consult your advisor when unsure.',
  turns: [{ role: 'user', content: task }],
  tools,
  executor, // consults route to anthropic; every other tool runs as before
  modelClass: 'extraction', // the cheap executor tier
});
```

The input `tools` array is never mutated; a name collision with the consult
tool throws at wrap time (`toolName` renames it). A failing advisor never kills
the work — the executor gets a legible "advisor unavailable" result and
carries on. The advisor's own adapter emits its model span as usual, so
`setModelSpanSink` sees both sides of the pair.

## See also

- [`llms.txt`](./llms.txt) — LLM-agent-facing description of this package.
- [`CHANGELOG.md`](./CHANGELOG.md) — release history.
- [`examples/`](./examples/) — runnable usage examples per subpath (land with
  the extraction slice).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
