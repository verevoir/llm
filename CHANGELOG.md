# Changelog

## [0.14.0] — 2026-06-17

**Per-provider base-URL overrides + model→provider routing** (STDIO-375, STDIO-374).

- **`<PROVIDER>_BASE_URL` overrides** — every adapter honours an env override for its endpoint, so any provider can be pointed at a gateway, proxy, regional, or self-hosted endpoint without a code change: `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GEMINI_BASE_URL` (with `GOOGLE_BASE_URL` fallback), `MISTRAL_BASE_URL`, `DEEPSEEK_BASE_URL`, `SAMBA_NOVA_BASE_URL`. Resolved via a shared `resolveBaseUrl(envVar?, fallback?)`, keyed by provider/endpoint to mirror `<PROVIDER>_API_KEY`. Anthropic/Google thread it through their SDKs (`baseURL` / `httpOptions.baseUrl`); the OpenAI-compatible adapters via the factory's new `baseUrlEnv`. Only the generic **OpenAI** adapter is keyless-capable: a base-URL override with a **blank key** points it at a local server (LM Studio / Ollama / vLLM) and it builds with a placeholder key (`localEndpointKey`), with `isProviderConfigured` counting the URL alone as usable. Hosted providers (Anthropic, Gemini, SambaNova, Mistral, DeepSeek) always need their key — a base-URL override alone (a regional/proxy endpoint) does **not** make them configured.
- **Provider connection registry + routing** — each adapter registers its connection (`registerProviderConnection`) so routing can answer "is this provider configured?" (`isProviderConfigured`, `configuredProviders`). `providersForFamily(family)` is the inverse index — which providers serve a family (e.g. DeepSeek-V3 over both deepseek.com and SambaNova) — and `resolveModel({ family?, modelClass?, configuredOnly?, prefer? })` picks the best: cheapest configured by default, or by an explicit provider preference. Loud-on-miss (returns `null`). Routing sees only providers whose subpath has been imported, same as the catalog.

## [0.13.0] — 2026-06-12

**Tool calling on the Google (Gemini) adapter** (STDIO-342) — the last provider gap, so the whole matrix is now tool-capable.

- **`@verevoir/llm/google` gains `chatWithTools` (single-shot) + `chatWithToolLoop`** using Gemini's function-calling: `config.tools` function declarations, `response.functionCalls` read back, results fed in as `functionResponse` parts. Same surface as the Anthropic + OpenAI-compatible adapters. JSON-schema `type`s are uppercased into Gemini's `Type` enum form.
- **Validated against the live Gemini API** (the tool loop runs, the model invokes the tool with parsed args, and returns a final reply) in addition to the mocked unit tests.

With this, every provider in the cross-provider matrix — Anthropic, Google, Mistral, SambaNova (Llama + DeepSeek) — can drive the tool loop that enactment depends on.

## [0.12.0] — 2026-06-12

**Tool calling on the OpenAI-compatible adapters** (STDIO-342) — so Mistral / SambaNova / DeepSeek-via-Samba can drive a tool loop, not just plain `chat()`. Tool-using enactment is the actual mechanism; without it a cross-provider matrix is "a bit pointless".

- **`createOpenAICompatAdapter` gains `chatWithTools` (single-shot) + `chatWithToolLoop`** (model → execute tools → feed `tool_result` back → repeat, to a `maxIterations` cap). Uses OpenAI Chat Completions native `tools`/`tool_calls`; provider-agnostic `ToolDef`/`ToolUse` map straight across. Same surface as the Anthropic adapter's tool methods. Exposed from `@verevoir/llm/mistral` and `@verevoir/llm/samba`.
- **Fix: SambaNova model ids corrected to the live catalogue.** 0.11.0 defaulted extraction to `Meta-Llama-3.1-8B-Instruct`, which SambaNova doesn't host. Verified via the `/models` endpoint: defaults are now `Meta-Llama-3.3-70B-Instruct` (reasoning) + `DeepSeek-V3.2` (extraction), both tool-capable. (Decisions key on provider/family, so a new `DeepSeek-V3.x` point-release still normalises via the prefix.)
- Gemini (`/google`) tool calling — a separate API shape — is the follow-up; the matrix's enactment path needs both.

## [0.11.0] — 2026-06-12

Two more providers — **SambaNova** and **Mistral** — for the cross-provider model matrix (STDIO-332). Both expose OpenAI-compatible Chat Completions APIs.

- **New `@verevoir/llm/samba`** (`SAMBA_NOVA_API_KEY`) and **`@verevoir/llm/mistral`** (`MISTRAL_API_KEY`) — `chat()` only, matching the staged rollout of `/openai` + `/deepseek`. Both reuse the existing `openai` peer dependency pointed at the provider's `baseURL`.
- **New shared `createOpenAICompatAdapter` factory** (internal). DeepSeek/SambaNova/Mistral all differ only in base URL, key env var, and model catalogue, so the adapter is built from a small config rather than copied per provider. The new adapters are born **de-brittle**: they register a provider/family **model catalogue** (0.10.0), so `models` / `rates` / labels derive from one source and decisions key on `provider/family`, not the exact version (a new version of a listed family still normalises + prices via its prefix). A tier ladder fills any class a provider doesn't declare (drafting falls up to reasoning).
- Default model tables and pricing are sensible starting points (worst-case input rates) — verify model ids + rates against each provider's current catalogue; since decisions key on family, the exact default id is reporting metadata.

## [0.10.0] — 2026-06-12

De-brittled model identity — **decisions key on `provider/family`, never on the exact version** (STDIO-332). A version bump used to silently zero a model's cost and forced downstream band-aids (duplicate `…-4-5` / `…-4-5-20251001` rate rows). The version string is now reporting metadata only.

- **New: a model catalog as the single source of truth.** `ModelCatalogEntry { provider, family, currentId, rates, label, modelClass?, aliases?, prefixes? }` registered via `registerModelCatalog()`. An adapter declares each family once and derives its `models` / `rates` / labels from it — a version upgrade is a one-line `currentId` change, not three hand-edited tables.
- **New: `normalizeModelId(id) → { provider, family } | null`.** Matches `currentId`, then `aliases`, then a `prefix` pass — so a brand-new, unseen version of a known family (`claude-haiku-…`) resolves **forward** instead of dropping to unknown. `catalogEntryFor(id)` returns the resolved entry.
- **`estimateCostUSD` + `modelLabel` fall back to the family catalog**, so a drifted version prices and labels correctly with no new row. `estimateCostUSD` stays silent on a genuinely-unknown model (back-compat: still contributes $0); **`uncoveredModels(usage, rates?)`** is the new loud-on-miss surface a cost display can warn on.
- **Anthropic adapter:** `models` / `rates` / labels now derive from one `CATALOG`. All existing exports (`models`, `rates`, `PROVIDER`, `anthropic`, `registerModelLabels`, …) are preserved; the change is additive.

## [0.8.0] — 2026-05-29

Cache-aware cost accounting — prompt-cache savings are now visible in `estimateCostUSD` instead of buried at the standard input rate (STDIO-166). Profiling-grade instrumentation for the LLM-optimisation pass; backwards-compatible.

- **`PerModelUsage` entries gain optional `cacheRead` / `cacheWrite`.** Old persisted rollups carried only `{ in, out }`; the fields are optional and every helper coalesces a missing one to 0, so existing serialised usage still parses. Keeping cache tokens separate from `in` is the whole point — it's what lets cost pricing discount them.
- **`estimateCostUSD` prices cache reads / writes at their own rates.** `RateTuple` widens to `[input, output, cacheRead?, cacheWrite?]`; when an adapter omits the cache rates it falls back to the Anthropic-standard multipliers (read **0.1×**, write **1.25×** of input). Previously all of `in` (including folded-in cache reads, at ~10× their real cost) priced at the standard input rate — a worst-case upper bound that hid every caching win. Existing two-element rate tables stay valid.
- **`totalTokens` now sums input + output + cacheRead + cacheWrite at face value.** Unchanged for old `{ in, out }` data; for new data it keeps a token-count budget guard honest (a cache read is cheaper in dollars but is still a token the model processed). Cost discounts cache; the raw token count does not.
- No adapter or `chat()` surface change. Consumers that fold cache tokens into `in` themselves (e.g. an `accumulateUsage`) should split them out to benefit; until they do, behaviour is unchanged.

## [0.7.0] — 2026-05-26

Prompt-cache structuring in the Anthropic adapter — the conversation-prefix half.

- **`chatWithToolLoop` now caches the growing conversation prefix.** Each loop iteration re-sends the full message history; the adapter now places a `cache_control: {type: "ephemeral"}` breakpoint on the last block of the last message, so the next iteration reads the prior prefix from cache (~0.1× input cost) instead of reprocessing it. The system breakpoint already caches the tools + system prefix (render order is tools → system → messages), so a tool loop now pays full input price only on the per-iteration delta.
- Single-shot `chat` / `chatWithTools` are unchanged: their final block is the varying current question, so a message-level breakpoint there would only write a cache entry that never gets read. The system/tools breakpoint already covers their stable prefix.
- Cache activity continues to surface on `TokenUsage.cacheCreationInputTokens` / `cacheReadInputTokens` (already wired). No public API change. (STDIO-11 — prompt-cache structuring. The card's "layer-side file/issue cache" half is superseded by `@verevoir/context`, which owns file/issue caching.)

## [0.6.0] — 2026-05-26

Fourth provider: DeepSeek via its OpenAI-compatible API.

- **New `@verevoir/llm/deepseek`** — `chat()` only, matching the staged rollout of `/openai` + `/google`. DeepSeek exposes an OpenAI-compatible API, so the adapter reuses the existing `openai` peer dependency pointed at `https://api.deepseek.com`. It mirrors the `/openai` adapter's structure but calls the **Chat Completions** API (`chat.completions.create`) rather than the Responses API — DeepSeek implements the former, not the latter.
- Model classes map `reasoning` → `deepseek-reasoner` and `extraction` → `deepseek-chat`. Friendly labels ("DeepSeek Reasoner" / "DeepSeek Chat") registered on import. Worst-case rate table (standard cache-miss input rates) for upper-bound cost estimates.
- Cache hits read from DeepSeek's `prompt_cache_hit_tokens` (falling back to `prompt_tokens_details.cached_tokens`) into `cacheReadInputTokens`. Same exponential-backoff retry shape + `onRetry` narration + `abortSignal` handling as the other adapters.
- No new peer dependency — `/deepseek` shares `openai` with `/openai`. Auth via `DEEPSEEK_API_KEY` (or a per-call `apiKey`).

## [0.5.0] — 2026-05-20

Third frontier provider: OpenAI via the Responses API.

### OpenAI subpath (`@verevoir/llm/openai`) — new

- New optional peer dep: `openai`.
- `chat()` — single-shot text generation via `client.responses.create()` (the post-Chat-Completions canonical surface). Same `{ systemPrompt, turns, apiKey, modelClass, onRetry, onUsage, abortSignal }` shape as the Anthropic + Google adapters. Returns `{ content, usage, stopReason }`.
- Model table: `reasoning → gpt-5`, `extraction → gpt-5-mini`.
- API key resolution: per-call `apiKey` → `OPENAI_API_KEY` env.
- Friendly labels registered on import: `GPT-5` / `GPT-5 Mini`.
- Retries with exponential backoff on 429 / 500 / 502 / 503 with provider-named reason strings.
- `cached_tokens` from the Responses API's `input_tokens_details` flows into `TokenUsage.cacheReadInputTokens`.
- Not in this release: `chatWithTools()`, `chatWithToolLoop()`, live `onProgress`. Aligns with `/google`'s staged rollout.

### Compatibility

- Fully backwards-compatible. All three SDK deps stay optional peers.

## [0.4.0] — 2026-05-20

First non-Anthropic provider. Single-shot `chat()` on Google Gemini.

### Anthropic subpath (`@verevoir/llm/anthropic`)

- Unchanged from `0.3.0`.

### Google subpath (`@verevoir/llm/google`) — new

- New optional peer dep: `@google/genai`.
- `chat()` — single-shot text generation against Gemini. Same `{ systemPrompt, turns, apiKey, modelClass, onRetry, onUsage, abortSignal }` surface as the Anthropic adapter. Returns `{ content, usage, stopReason }`. Retries with exponential backoff on Google transient errors (429/500/503/UNAVAILABLE/DEADLINE_EXCEEDED).
- Model table: `reasoning → gemini-2.5-pro`, `extraction → gemini-2.5-flash`.
- API key resolution: per-call `apiKey` → `GEMINI_API_KEY` env → `GOOGLE_API_KEY` env.
- Registers friendly labels (`Gemini Pro` / `Gemini Flash`) on import for the core's `modelLabel` helper.
- Not yet in this release: `chatWithTools()`, `chatWithToolLoop()`, live `onProgress` narration. Gemini's function-calling + streaming need a different mapping from the Anthropic shape; tracked for the next release.

### Compatibility

- Fully backwards-compatible. The `/anthropic` subpath is untouched; new consumers can opt into `/google` without rippling.

## [0.3.0] — 2026-05-20

Cooperative cancellation via `AbortSignal`.

### Core (`@verevoir/llm`)

- `ChatOptions` gains optional `abortSignal: AbortSignal`. When the signal aborts, the adapter throws the signal's `reason` (or a generic AbortError when none was set). `ChatWithToolsOptions` and `ChatWithToolLoopOptions` inherit it.

### Anthropic subpath (`@verevoir/llm/anthropic`)

- `chat()` and `chatWithTools()` check the signal once, before the LLM call.
- `chatWithToolLoop()` checks at the top of each iteration. The in-flight iteration's LLM call still settles and its tokens are recorded (so accounting stays correct), but no further iterations start once the signal is aborted.
- Driving use case: an `onUsage` hook that aborts the controller when an aggregate budget is exceeded. The hook's own throws are still swallowed by the adapter for back-compat; abort is the supported escape hatch.

### Compatibility

- Fully backwards-compatible: existing callers that don't pass `abortSignal` see identical behaviour to 0.2.x.

## [0.2.0] — 2026-05-18

Multi-turn tool conversations + structured content blocks.

### Core (`@verevoir/llm`)

- `Turn.content` widens to `string | ContentBlock[]`. Plain strings still work; structured content unlocks tool loops and lays the schema for future multimodal blocks (image, document) without a second migration.
- New `ContentBlock` discriminated union: `text`, `tool_use`, `tool_result`. Mirrors Anthropic's native SDK shape so the adapter doesn't translate.
- New `ToolExecutor` type — the caller-supplied function that runs a single tool_use and returns the matching tool_result string.
- New `ChatWithToolLoopOptions` / `ChatWithToolLoopResult` types describing the multi-turn shape.

### Anthropic subpath (`@verevoir/llm/anthropic`)

- New **`chatWithToolLoop()`** — runs the model → execute tools → feed `tool_result` blocks back loop internally until the model returns text-only (or `maxIterations` fires). Executor failures surface as `is_error: true` tool_results so the model can recover gracefully rather than crashing the conversation.
- Per-iteration `onUsage` + `onIteration` hooks. Returned `usage` is summed across all iterations of the loop so per-conversation-turn accounting stays accurate.
- `chat()` and `chatWithTools()` unchanged.

### Compatibility

- Backwards-compatible at the API surface: callers passing `Turn[]` with `content: string` get the same behaviour as 0.1.x.
- Consumers using `chatWithTools()` with their own single-shot tool handling don't need to change; `chatWithToolLoop()` is purely additive.

## [0.1.0] — 2026-05-17

First deliberate release. **Pre-stable** — `0.x` line communicates that the API
surface can shift before `1.0`. Bumps to `1.0` follow validation by the first
real consumer (aigency-web migration). Implementation ported from a private
consumer.

### Core (`@verevoir/llm`)

- Types: `ModelClass`, `Turn`, `TokenUsage` (carries provider × model × direction), `ChatOptions`, `ChatReply`, `ChatRetryInfo`, `ProgressInfo`, `ToolDef`, `ToolUse`, `ChatWithToolsOptions`, `ChatWithToolsResult`, `PerModelUsage`, `RateTuple`, `RatesTable`.
- Accounting helpers: `parseUsage`, `sumUsages`, `totalTokens`, `formatTokensCompact`, `estimateCostUSD`, `registerModelLabels`, `modelLabel`.

### Anthropic subpath (`@verevoir/llm/anthropic`)

- `chat()` — single-shot, streamed, with retry-with-narration + BYOK + optional `report_progress` live narration via auto-injected tool.
- `chatWithTools()` — tool-calling variant; surfaces non-progress `tool_use` blocks for caller execution.
- Exported `models` (class → model id), `rates` (per-model USD/Mtok), and `PROVIDER` constant.
- Registers `Opus` / `Haiku` friendly labels with the core registry on import.

### Scaffolding (from 0.0.0)

- Apache 2.0 LICENSE, README quickstart, `llms.txt` at root for LLM-agent self-onboarding.
- `tsconfig.build.json` excludes tests from the published `dist/`.
- Vitest suite covering the pure-function helpers and the Anthropic adapter's exported tables.
- Runnable example: `examples/anthropic-chat.ts`.

## [0.0.0] — scaffold only, unpublished

Initial repository scaffold per the [Verevoir publishing quality bar](https://github.com/verevoir/aigency).
Never published to npm; the version is recorded here for posterity.
