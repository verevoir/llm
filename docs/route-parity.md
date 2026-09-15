# Cross-provider route parity — what these adapters do, as of one commit

**Read against `main` @ `2e3b48548025f3019c37ebec3b3a972d3a633229` (0.26.3), source-verified this session — not settled behaviour of the providers, only of these adapters at this commit.** Re-check before relying on it after any adapter changes.

## Tool-calling: a structural fork, not a degradation

`chatWithTools` / `chatWithToolLoop` exist as exports on **Anthropic, Gemini (`/google`), SambaNova (`/samba`), Mistral (`/mistral`)** — full parity, one function name works across all four. They are **absent as exports** — not stubbed, not throwing, simply not there — on **direct OpenAI (`/openai`)** and **DeepSeek (`/deepseek`)**, and on **claude-cli** by design (`--disallowedTools "*"`, single-shot only). No Qwen adapter exists anywhere in this package.

**The silent-failure consequence.** A caller that falls back to `chat()` for OpenAI or DeepSeek when no tool-calling entry point exists gets tools silently never offered, with no error: `callResponsesCreate` and `callChatCompletionsCreate` (their `chat()` implementations) build no `tools` field in the request body at all — verified by reading both directly. This is the identical shape to the defect `aigency-harness` PR #111 found and fixed on its own Anthropic `ModelPort` adapter (which used to call plain `chat()` regardless of what tools a caller passed). It is a pattern this package can reproduce for any caller who assumes parity across routes, not a one-off.

## Gemini tool-call id collision — fixed (verevoir/llm#48)

`chatWithTools`/`chatWithToolLoop`'s `toolUses` mapping used to fall back `id: f.id ?? f.name` when Gemini's own response omitted an id (`src/google/index.ts`). Two parallel calls to the **same tool name** within one turn then shared that fallback id — correlating a `tool_use` to its `tool_result` by id was safe on every route except this one.

`f.id` being read at all was correct: Gemini's own `FunctionCall.id` type declaration says it is genuinely optional — "If populated, the client [executes] the function_call and return[s] the response with the matching id" — some calls carry it, some don't. The defect was only in the fallback value. Fixed in #48: the fallback is now derived from the call's name plus its position within that turn's `functionCalls` array (`name#index`) — stable within the turn, distinct between parallel calls to the same tool, and not required to be unique beyond that turn since tool uses and results are only ever correlated within one iteration.

## `onProgress` is Anthropic-only

Only `src/anthropic/index.ts` reads `options.onProgress` (auto-injecting `report_progress`). Gemini, the OpenAI-compat factory (`samba`/`mistral`), direct OpenAI, DeepSeek, and **claude-cli** never reference it — it never throws, it simply never fires. claude-cli's own file header says so explicitly: "`onProgress` IS ACCEPTED, NEVER INVOKED ... A caller supplying `onProgress` will never see it called; nothing here throws for supplying it" (`src/claude-cli/index.ts:139-144`). A caller building progress UX on the assumption of parity gets silence on **six of seven routes** — every route except Anthropic.

## Why `assertNoBuiltinToolsReachable` is correctly narrow, not a gap

Every API-based route (six of seven) only ever sends the tools a caller explicitly builds via `chatWithTools`/`chatWithToolLoop` — verified directly in `callChatCompletionsCreate`, `callResponsesCreate`, `callGenerateContent`, and Anthropic's `buildRequest`: no default toolset, no environment channel. "No tools reachable" is therefore structural on those six, free by construction, needing no runtime check. `claude-cli` is the one route that spawns a general-purpose agent (Claude Code) with its own environment-derived built-in tools, independent of anything `ChatOptions` carries — which is exactly why `--tools ""` silently failed to disable them for three minor versions (0.25.0–0.26.2) before `assertNoBuiltinToolsReachable` verified it against the CLI's own `init` event instead of trusting the flag. The check's scope matches where the actual risk lives.

**Caveat:** this covers only tools declared through this package's own `tools` parameter. Grepped `main` for provider-side/server-executed tools (e.g. an Anthropic `web_search`/`computer_use` passthrough) — zero matches on any adapter, as of this commit. Re-check this claim if a future release adds one.

## Gemini has no client-side call timeout, and no wired abort path

Established by reading the installed `@google/genai@2.21.0` runtime (`dist/node/index.cjs`), not the type declarations alone: `createAttemptSignal(timeout, callerSignal)` builds **no `AbortController` at all** — `signal: undefined` on the underlying `fetch` — when both `timeout` and a caller signal are absent. `src/google/index.ts` never sets `httpOptions.timeout` when constructing `GoogleGenAI` (only `baseUrl`, when overridden), so this is the adapter's actual, current configuration, not a hypothetical one. Separately, `generateContent`'s request config does accept a per-call `abortSignal` (verified: every generated API method reads `abortSignal: params.config?.abortSignal`) — but `callGenerateContent` (`src/google/index.ts`) never passes `options.abortSignal` into it; the adapter's own `throwIfAborted` check runs once, before the call starts, and never again.

**Net effect: a hung Gemini call has no code-level bound at all** — not a long inherited SDK default, none — and cannot be interrupted once in flight via `ChatOptions.abortSignal` either. This is the sharpest gap in the timeout-asymmetry picture (claude-cli's package-owned 10-minute timeout vs. the keyed routes' SDK-inherited defaults): Gemini is the one route with neither a default nor a wired escape hatch.
