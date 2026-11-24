# @verevoir/llm

Provider-agnostic LLM call surface with token + cost accounting. The core export
holds the contract and shared types; provider SDK adapters live in subpaths so
consumers only pay for the SDK they actually use.

## Status

Pre-stable: the `0.x` line communicates that the API surface can shift before
`1.0`. Track the current version and release history in the repo's
[CHANGELOG](./CHANGELOG.md). Bumps to `1.0` follow validation by the first
real consumer.

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
  // Pass NOTHING when auth is ambient: it resolves from the environment —
  // CLAUDE_CODE_OAUTH_TOKEN (subscription) preferred, else ANTHROPIC_API_KEY.
  // Pass `apiKey` ONLY to force a specific key (BYOK); an explicit key here
  // short-circuits the OAuth preference.
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

| Subpath                       | SDK dep                         | Status                  |
| ----------------------------- | ------------------------------- | ----------------------- |
| `@verevoir/llm`               | none                            | shipped                 |
| `@verevoir/llm/anthropic`     | `@anthropic-ai/sdk`             | shipped                 |
| `@verevoir/llm/vertex`        | `@anthropic-ai/vertex-sdk`      | shipped                 |
| `@verevoir/llm/vertex-openai` | `openai`, `google-auth-library` | shipped                 |
| `@verevoir/llm/google`        | `@google/genai`                 | `chat()` only (`0.4.0`) |
| `@verevoir/llm/openai`        | `openai`                        | `chat()` only (`0.5.0`) |
| `@verevoir/llm/deepseek`      | `openai`                        | `chat()` only (`0.6.0`) |
| `@verevoir/llm/samba`         | `openai`                        | shipped                 |
| `@verevoir/llm/mistral`       | `openai`                        | shipped                 |
| `@verevoir/llm/claude-cli`    | none (spawns `claude -p`)       | shipped (`chat()` only) |
| `@verevoir/llm/catalog`       | none                            | shipped                 |

Multi-provider deployments depend on the same `chat()` contract; consumers
switch backends by importing a different subpath, not by changing call sites.

**`claude-cli` idle timeout.** Every fresh-spawn `chat()` call through
`@verevoir/llm/claude-cli` is bounded by an IDLE-output timer, not a wall-clock
one: the timer resets on every chunk of stdout/stderr the `claude` process
writes — including a running tool call's own stream-json output — so a call
that is genuinely working is never killed by this regardless of total
runtime; only real silence is. Default 10 minutes; override per call with
`idleTimeoutMs`, or process-wide with `CLAUDE_CLI_IDLE_TIMEOUT_MS`
(milliseconds). On expiry the process is killed and the call rejects with an
`Error` carrying `.code === 'CLAUDE_CLI_IDLE_TIMEOUT'` and `.timeoutMs`.

**`claude-cli` environment.** The child `claude` sees only `PATH`, `HOME`, `TMPDIR`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR` (a path, not a secret; see the CHANGELOG `SECURITY:` entry for 0.36.0); nothing else is passed through.

## Naming a model

Every call takes a `modelClass` (`'reasoning' | 'drafting' | 'extraction'`,
default `'reasoning'`), which the adapter resolves to its own current model id.
A call may also carry `model`, an exact model id:

```ts
import { samba } from '@verevoir/llm/samba';

const reply = await samba.chat({
  systemPrompt: '...',
  turns: [{ role: 'user', content: '...' }],
  model: 'DeepSeek-V3.2',
});
// reply.usage.model → 'DeepSeek-V3.2'
```

- **Which adapters act on it.** `@verevoir/llm/anthropic`, `/vertex`,
  `/vertex-openai`, `/samba` and `/mistral` send `model` when it is set, on
  `chat`, `chatWithTools` and every call `chatWithToolLoop` makes, including
  the loop's final call after the iteration cap. `/deepseek` does so on `chat`,
  the one call it exports.
  `/claude-cli` hands it to the CLI as `--model`, on `chat` and
  `chatWithToolLoop`. `/openai` and `/google` accept `model` and ignore it:
  they send their own id for the `modelClass`.
- **The id is sent exactly as given.** It is not looked up in the model
  catalogue, so a family name or other alias is not resolved to a current id,
  and nothing checks that the provider serves the model. A name the provider
  does not know fails as that provider's own error.
- **Without `model`**, the adapter sends its id for the `modelClass`
  (`models[modelClass]`); `/claude-cli`, which has no catalogue, leaves the
  choice to the CLI; `/vertex-openai`, which has no catalogue either, refuses
  the call.
- **Usage and spans report the id that was sent.** `TokenUsage.model`, the
  `ModelSpan` and the OpenTelemetry span's request model all carry it.
  `TokenUsage.direction` is the `modelClass` the call asked for (`'reasoning'`
  when none was given), whether or not the named model belongs to that class.
- **Cost.** The cost API looks a usage record up by the model name it carries;
  a name the price book cannot match is reported as `unpriced`.

## Failures

A failed call rejects with what it always rejected with: the provider SDK's own
error, or this library's own plain `Error`. To find out what went wrong without
knowing which provider answered, pass the caught error to `classifyLlmError`:

```ts
import { classifyLlmError } from '@verevoir/llm';

try {
  await anthropic.chat({ systemPrompt, turns });
} catch (err) {
  const { kind, retryable } = classifyLlmError(err);
  // kind: 'authentication' | 'permission' | 'rate-limited' | ...
  // retryable: may a later attempt succeed?
  // err is untouched: err.status, err.message and instanceof still work.
}
```

- **It returns a plain `LlmFailure` object, `{ kind, retryable }`.** Nothing is
  thrown as one, and the error you pass in is only read, never wrapped or
  changed.
- **`kind`** is one of a closed union, `LlmErrorKind` (table below).
- **`retryable`** says whether a later attempt at the same call may succeed. It
  does not say how long to wait, and the adapter has already made its own
  retries (three, with backoff, on the API adapters) before the error reaches
  you.

| `kind`            | Recognised by                                                                                                                                             | `retryable` |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `authentication`  | HTTP status 401                                                                                                                                           | no          |
| `permission`      | HTTP status 403                                                                                                                                           | no          |
| `rate-limited`    | HTTP status 429; or, with no status, error type `rate_limit_error`                                                                                        | yes         |
| `overloaded`      | HTTP status 529; or, with no status, error type `overloaded_error`                                                                                        | yes         |
| `unavailable`     | Any other HTTP 5xx; or, with no status, error type `api_error` or an SDK `APIConnectionError`                                                             | yes         |
| `invalid-request` | Any other HTTP 4xx                                                                                                                                        | no          |
| `timeout`         | HTTP status 408; or, with no status, error type `timeout_error` or an SDK `APIConnectionTimeoutError`; a `claude-cli` idle or turn timeout, by its `code` | yes         |
| `empty-response`  | An `EmptyResponseError`: the call succeeded but `chat()` got no text back                                                                                 | no          |
| `other`           | Anything else, including every shape not listed above                                                                                                     | no          |

Read in this order, first match wins: the `EmptyResponseError` class; a `code`
of `CLAUDE_CLI_IDLE_TIMEOUT` or `CLAUDE_CLI_SESSION_TURN_TIMEOUT`; the numeric
`status` on the SDK's error (a status that is not a number is never coerced);
the string `type` the Anthropic SDK puts on an error that arrives part-way
through a streamed response, where there is no failing status to read; the
class names the Anthropic and OpenAI SDKs give a request that never got a
response. The error's message text is never read. You can also call it on an
error from your own SDK call.

**What is new on a thrown error.** Thrown errors are otherwise unchanged; there
are two additions:

- **`EmptyResponseError`.** When `chat()` gets no text back, the error is now an
  instance of this exported class (`extends Error`) where it was a plain
  `Error`. Its `message` is exactly what it was
  (`<provider>.chat: response had no text content (…)`, with the finish reason)
  and its `name` is still `Error`, so `instanceof Error`, a message match and a
  logged error all read as before.
- **A `code` on the `claude-cli` held-session turn timeout.** That error now
  carries `.code === 'CLAUDE_CLI_SESSION_TURN_TIMEOUT'` (exported from
  `@verevoir/llm/claude-cli` as `CLAUDE_CLI_SESSION_TURN_TIMEOUT_CODE`),
  alongside its unchanged message. The idle timeout already carried
  `CLAUDE_CLI_IDLE_TIMEOUT`.

What cannot be told apart:

- **Overload** is its own kind only on Anthropic (529). The other providers
  report it as an ordinary 5xx, which is `unavailable`.
- **A network failure or timeout on Google** is `other`: that SDK throws the
  platform's own fetch error, with no status and no class of its own.
- **`claude-cli`** reports why it failed only as free text, so everything except
  its two timeouts is `other` — a login failure included. The text is the
  error's own `message`, as it always was.
- **A 4xx is `invalid-request` whatever its cause** — a malformed request, an
  unknown model and an over-long prompt are not distinguished.
- **An abort.** A call cancelled through `abortSignal` rejects with the signal's
  own `reason` (or an `AbortError` when it has none), which is `other`. There is
  no `aborted` kind: you hold the signal, so `signal.aborted` already tells you.
- **The library's own argument and configuration checks** — no turns, no tools,
  a missing API key, an `UnsupportedContentBlockError` — are `other` too.

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

## Claude on Google Cloud Vertex AI

`@verevoir/llm/vertex` is the Anthropic adapter with a different client: an
`AnthropicVertex` from `@anthropic-ai/vertex-sdk`, an optional peer that only
this subpath imports. It exports `chat`, `chatWithTools`, `chatWithToolLoop`
and `PROVIDER`, plus the namespaced `vertex`.

```bash
npm install @verevoir/llm @anthropic-ai/vertex-sdk
```

Those two are the whole install for this route. `@anthropic-ai/vertex-sdk`
declares `@anthropic-ai/sdk` and `google-auth-library` as dependencies of its
own, so neither is installed separately, and this subpath imports no other
provider SDK. `@opentelemetry/api` is a required peer of `@verevoir/llm` on
every route: npm installs it with the line above, and a package manager that
does not install peers needs it named.

```ts
import { vertex } from '@verevoir/llm/vertex';

// ANTHROPIC_VERTEX_PROJECT_ID and CLOUD_ML_REGION are set in the environment.
const reply = await vertex.chat({
  systemPrompt: 'You are a helpful assistant.',
  turns: [{ role: 'user', content: 'Hello' }],
  modelClass: 'reasoning',
});
```

The requests are the ones `@verevoir/llm/anthropic` sends on an API key, built
by the same code: the same system and message blocks, the same cache breakpoints
for each `cache` value (`'none' | 'default' | 'prefix'`), the same tool loop and
retries, `image` / `document` content blocks included. What differs:

- **Credentials.** Authentication is Google Cloud's standard credentials flow,
  run by the Vertex SDK. There is no API key: a per-call `apiKey` is refused
  with a plain error, and `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are
  never read, so the direct adapter's subscription-token identity and its
  fallback to the metered key do not exist on this route.
- **Project and region.** `ChatOptions` has no field for them; they come from
  the environment variables the Vertex SDK itself reads,
  `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION`, read on each call. If
  either is unset or blank the call is refused before anything is sent, with a
  plain error that names the variable and no value
  (`No Vertex AI region: set CLOUD_ML_REGION.`, and the same for the project).
  One client is kept and reused for as long as both stay the same.
- **Model names.** The name is sent exactly as given: `model` when set,
  otherwise the Anthropic catalogue's id for the `modelClass`. There is no
  mapping to Vertex AI's names. Where Vertex AI names a model differently, pass
  that name as `model`.
- **Usage and cost.** `TokenUsage` carries the same figures as the direct
  route, including cache writes, cache reads and the five-minute / one-hour
  cache-write split. `provider` is `'vertex'` and `route` is `'google-cloud'`.
  The price book has no entry of its own for provider `vertex`: it looks a
  usage up by exact model name, then by `vertex/<model>`, so a call is priced
  only if the name sent has an entry, and at that entry's rates; any other name
  is `unpriced`. Pricing Vertex calls is the caller's concern.
- **Failures.** The Vertex SDK throws the Anthropic SDK's own error classes, so
  `classifyLlmError` gives the same kind for the same status. The library's own
  errors and the model span's `scope` read `vertex.chat`, `vertex.chatWithTools`
  and `vertex.chatWithToolLoop`.
- **Catalogue and routing.** The subpath registers nothing: `isProviderConfigured`,
  `resolveModel` and the other routing helpers do not know a `vertex` provider.

## Vertex AI's OpenAI-compatible endpoint

`@verevoir/llm/vertex-openai` calls the Chat Completions endpoint Google Cloud
Vertex AI offers for models of several publishers:
`POST https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions`.
It exports `chat`, `chatWithTools`, `chatWithToolLoop` and `PROVIDER`
(`'vertex-openai'`), the namespaced `vertexOpenAI`, and two error classes,
`VertexOpenAIConfigError` and `VertexOpenAITokenError`.

```bash
npm install @verevoir/llm openai google-auth-library
```

`openai` and `google-auth-library` are optional peers; this is the only subpath
that imports `google-auth-library`. `@verevoir/llm/vertex` does not need it
named: `@anthropic-ai/vertex-sdk` brings its own.

```ts
import { vertexOpenAI } from '@verevoir/llm/vertex-openai';

// GOOGLE_CLOUD_PROJECT is set in the environment.
const reply = await vertexOpenAI.chat({
  systemPrompt: 'You are a helpful assistant.',
  turns: [{ role: 'user', content: 'Hello' }],
  model: 'google/gemini-3.5-flash',
});
```

The three calls are the ones `@verevoir/llm/samba` and `/mistral` have, built by
the same code: the same messages, tool calls, tool loop and retries. What
differs:

- **The model is required.** There is no catalogue and no default: pass `model`
  in the endpoint's `<publisher>/<model>` form. It is sent exactly as given. A
  call with no `model` (or a blank one) is refused with a
  `VertexOpenAIConfigError` whose `setting` is `'model'`, before any token is
  asked for or any request sent. `modelClass` chooses nothing here; it is still
  reported as `TokenUsage.direction`.
- **Credentials.** Authentication is Google Cloud's standard credentials flow,
  through `google-auth-library`, for the scope
  `https://www.googleapis.com/auth/cloud-platform`. The access token is asked
  for before every request, a tool loop's included, so a token the library has
  replaced is the one sent; the library keeps the token it holds and fetches
  another only when that one is about to expire. No credential is looked up
  when the subpath is imported. There is no API key: a per-call `apiKey` is
  refused (`setting: 'apiKey'`), and `OPENAI_API_KEY`, `OPENAI_BASE_URL`,
  `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are not used.
- **Project and location.** `ChatOptions` has no field for them. The project
  comes from `GOOGLE_CLOUD_PROJECT` and the location from
  `GOOGLE_CLOUD_LOCATION`, read on each call. These are not the variables
  `@verevoir/llm/vertex` reads, and neither subpath reads the other's. With no
  project the call is refused with a `VertexOpenAIConfigError`
  (`setting: 'GOOGLE_CLOUD_PROJECT'`, message
  `No Vertex AI project: set GOOGLE_CLOUD_PROJECT.`). The location defaults to
  `global`, which is served by `aiplatform.googleapis.com`; any other location
  is served by `{location}-aiplatform.googleapis.com`. Some models answer only
  at `global`. A project or location that is not a plain identifier is refused
  without being repeated, since both become part of the URL the token is sent
  to. There is no base-URL override.
- **Usage.** `provider` is `'vertex-openai'` and `route` is `'google-cloud'`.
  `inputTokens` is `prompt_tokens` less any cached tokens, and
  `cacheReadInputTokens` is `prompt_tokens_details.cached_tokens` when the
  endpoint reports it. When it reports none (the member is absent or `null`)
  the count is `0`, as on the other OpenAI-compatible adapters: `TokenUsage`
  cannot say "not reported". `cacheCreationInputTokens` is always `0`.
  Reasoning tokens are counted within `outputTokens`: where the response's
  `total_tokens` equals prompt + completion + reasoning, the endpoint reported
  them apart from `completion_tokens` and they are added; otherwise
  `completion_tokens` is taken as the whole output. `TokenUsage` has no
  separate reasoning count.
- **Cost.** The subpath adds no price. The price book looks a usage up by the
  exact model name sent, then by `vertex-openai/<that name>`; a name with no
  entry is `unpriced`.
- **Failures.** The `openai` SDK's errors are thrown as they are, so
  `classifyLlmError` reads the endpoint's status as on any other adapter. A
  failure to obtain an access token is a `VertexOpenAITokenError`: no request
  was sent, it carries no `status`, and it classifies as `other`, not
  retryable, so it does not read as the endpoint's refusal of the request or
  of the credential. Its message is fixed and holds no text from the
  credentials library; that library's own error is on `cause`.
  `VertexOpenAIConfigError` classifies as `other` too. The access token is in
  no error, span or log line this library writes.
- **Catalogue and routing.** The subpath registers nothing: `isProviderConfigured`,
  `resolveModel` and the other routing helpers do not know a `vertex-openai`
  provider.

## Cost accounting

Every call returns a `TokenUsage` shaped as
`{ provider, model, direction, inputTokens, outputTokens, ... }`. The cost API
is `createPriceBook(...)` / `book.costOf(usage)` — it prices from LiteLLM's
live price table, with a bundled snapshot as the fallback, and reports an
unmatched model as `unpriced` rather than `$0`. The package also exports
`sumUsages` and `formatTokensCompact` for rollups and compact displays. The
older per-adapter `rates` tables and `estimateCostUSD` are kept for
back-compat but `@deprecated` — use `createPriceBook` instead. The
**direction** field tracks the model-class semantic (`reasoning` /
`extraction`) so rollups can break down "spent X on reasoning + Y on extraction"
natively.

**Prompt caching (`ChatOptions.cache`, Anthropic and Vertex only).** `TokenUsage` reports
cache reads (`cacheReadInputTokens`) and cache writes
(`cacheCreationInputTokens`) separately from plain input, and the price book
prices each at its own rate. A cache write costs more than plain input and only
pays back when a later call reads it, so the caller can choose per call:

```ts
await anthropic.chat({ systemPrompt, turns, cache: 'none' }); // write nothing
```

- `'default'` (or omitted): the adapter's standard breakpoints with the
  provider's five-minute lifetime.
- `'none'`: no `cache_control` anywhere in the request. For a one-off call
  whose prefix nothing will read again.
- `'prefix'`: one breakpoint, on the system prompt (which caches the tools and
  the system prompt together), and never one on the conversation. For a call
  that shares its system prompt with sibling calls, but whose own conversation
  nothing else will read.

```ts
await anthropic.chatWithToolLoop({ systemPrompt, turns, tools, executor, cache: 'prefix' });
```

`'prefix'` is a trade, not a saving in every case. Within one tool loop,
`'default'` writes the growing conversation to the cache on each iteration so
the next iteration can read it back; under `'prefix'` each iteration re-sends
the whole conversation uncached. That costs more plain input tokens per
iteration and saves the cache-write premium on the conversation. It pays only
when the conversation is short, or when nothing will read it again; for a long
loop `'default'` is usually the cheaper choice. The provider's minimum
cacheable length still applies to the system prompt: a prefix shorter than it
is not cached at all, under any value.

It applies to `chat`, `chatWithTools` and every call `chatWithToolLoop` makes.
Every other adapter accepts the option and ignores it.

When the provider returns the cache-write split by lifetime,
`cacheCreationEphemeral5mInputTokens` / `cacheCreationEphemeral1hInputTokens`
carry it and `book.costOf(usage)` prices each part at its own rate.

**`costUsdReported` (claude-cli only).** `@verevoir/llm/claude-cli` relays the
CLI's own `total_cost_usd` as the optional `TokenUsage.costUsdReported`. It is
the CLI's own figure: **API-equivalent** on a subscription login, but **billed
money** on a metered Console login. The field does not know which (see the CHANGELOG
`SECURITY:` entry for 0.36.0). It is absent (never defaulted to `0` or `NaN`) unless the
CLI reports a finite number >= 0, and is then relayed as-is, except that a
`-0` becomes `0`; a reported `0` is relayed. A malformed value is recorded as
`TokenUsage.costUsdReportedInvalidType` (`negative`, `non-finite`, or the type
name such as `string` or `null`) and on the span as
`verevoir.llm.cost_usd_reported_invalid_type`, so it is not
mistaken for a missing one. Every other adapter leaves it absent — their cost
comes from the PriceBook.

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

### Content blocks: images and PDF documents

`ToolExecutor` may return `Promise<string | ContentBlock[]>`, not only a plain
string. Returning `ContentBlock[]` lets a tool hand back an `image` or
`document` block (e.g. a screenshot, a generated PDF) instead of text.
`@verevoir/llm/anthropic` (and `@verevoir/llm/vertex`, which shares its
implementation) passes both through to the model unchanged, in
`tool_result.content` and in user-turn content alike. Every other adapter can
only carry text: a non-text block reaching one of them throws the named
`UnsupportedContentBlockError` (`provider` + `blockType`) instead of being
silently dropped or stringified.

```ts
import { chatWithToolLoop, type ContentBlock } from '@verevoir/llm/anthropic';

const screenshotTool = {
  name: 'screenshot',
  description: 'Capture the current screen as an image.',
  input_schema: { type: 'object', properties: {} },
};

const result = await chatWithToolLoop({
  systemPrompt: 'Diagnose the UI bug from the screenshot.',
  turns: [{ role: 'user', content: 'What is wrong with this page?' }],
  apiKey: process.env.ANTHROPIC_API_KEY,
  tools: [screenshotTool],
  executor: async (toolUse): Promise<ContentBlock[]> => {
    const png = await captureScreenshot(); // base64 PNG data
    return [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }];
  },
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
