# Changelog

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
