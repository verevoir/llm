# Cross-provider route parity — what these adapters do, as of one commit

**Read against `main` @ `2e3b48548025f3019c37ebec3b3a972d3a633229` (0.26.3), source-verified this session — not settled behaviour of the providers, only of these adapters at this commit.** Re-check before relying on it after any adapter changes.

## Tool-calling: a structural fork, not a degradation

`chatWithTools` / `chatWithToolLoop` exist as exports on **Anthropic, Gemini (`/google`), SambaNova (`/samba`), Mistral (`/mistral`)** — full parity, one function name works across all four. They are **absent as exports** — not stubbed, not throwing, simply not there — on **direct OpenAI (`/openai`)** and **DeepSeek (`/deepseek`)**, and on **claude-cli** by design (`--disallowedTools "*"`, single-shot only). No Qwen adapter exists anywhere in this package.

**The silent-failure consequence.** A caller that falls back to `chat()` for OpenAI or DeepSeek when no tool-calling entry point exists gets tools silently never offered, with no error: `callResponsesCreate` and `callChatCompletionsCreate` (their `chat()` implementations) build no `tools` field in the request body at all — verified by reading both directly. This is the identical shape to the defect `aigency-harness` PR #111 found and fixed on its own Anthropic `ModelPort` adapter (which used to call plain `chat()` regardless of what tools a caller passed). It is a pattern this package can reproduce for any caller who assumes parity across routes, not a one-off.

## Gemini tool-call id collision

`chatWithTools`/`chatWithToolLoop`'s `toolUses` mapping falls back `id: f.id ?? f.name` when Gemini's own response omits an id (`src/google/index.ts`). Two parallel calls to the **same tool name** within one turn then share that fallback id. Correlating a `tool_use` to its `tool_result` by id is safe on every route except this one.

## `onProgress` is Anthropic-only

Only `src/anthropic/index.ts` reads `options.onProgress` (auto-injecting `report_progress`). Gemini, the OpenAI-compat factory (`samba`/`mistral`), direct OpenAI and DeepSeek never reference it — it never throws, it simply never fires. A caller building progress UX on the assumption of parity gets silence on five of seven routes.

## Why `assertNoBuiltinToolsReachable` is correctly narrow, not a gap

Every API-based route (six of seven) only ever sends the tools a caller explicitly builds via `chatWithTools`/`chatWithToolLoop` — verified directly in `callChatCompletionsCreate`, `callResponsesCreate`, `callGenerateContent`, and Anthropic's `buildRequest`: no default toolset, no environment channel. "No tools reachable" is therefore structural on those six, free by construction, needing no runtime check. `claude-cli` is the one route that spawns a general-purpose agent (Claude Code) with its own environment-derived built-in tools, independent of anything `ChatOptions` carries — which is exactly why `--tools ""` silently failed to disable them for three minor versions (0.25.0–0.26.2) before `assertNoBuiltinToolsReachable` verified it against the CLI's own `init` event instead of trusting the flag. The check's scope matches where the actual risk lives.

**Caveat:** this covers only tools declared through this package's own `tools` parameter. Grepped `main` for provider-side/server-executed tools (e.g. an Anthropic `web_search`/`computer_use` passthrough) — zero matches on any adapter, as of this commit. Re-check this claim if a future release adds one.

## Left open, not guessed at

**Gemini SDK (`@google/genai`) timeout default** — not established from source this session; not asserted here as any particular value. Mark open until read directly.
