# Changelog

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
