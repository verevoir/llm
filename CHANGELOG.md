# Changelog

## [0.47.3] — 2026-11-28

**The single-retry suites run each retry fact at the layer that can break it, so one mistake fails a few tests rather than dozens.** Only the tests change: no behaviour of the library changed, and nothing it exports or publishes is different.

- **One fetch driver.** `src/test-support/fetch-driver.ts` holds the fake `fetch`, the failures it produces (`refusal`, `failToConnect`, `neverAnswer`), `run`, and the two sets of rows both `anthropic-sdk-single-retry.test.ts` and `openai-sdk-single-retry.test.ts` run. Its directory is left out of the build (`tsconfig.build.json`), so nothing in it is published.
- **Every status row once per SDK path.** The retried and not-retried statuses, `x-should-retry`, the stream failures, the request timeout and the abort during each wait run on one site of each of four paths: the direct Anthropic client, Vertex, the OpenAI-compatible factory over Chat Completions, and `/openai` over the Responses API. A status error is built in one method of each SDK's client, `makeStatusError` in `@anthropic-ai/sdk`'s and in `openai`'s `client.js`, whichever call shape sent the request; `AnthropicVertex` extends the Anthropic client and defines none of its own.
- **Five rows on every other site.** Each client-building site and call shape runs "a 503 answered every time", "meets a 429 and then succeeds", the request timeout, the abort during wait 1, and the abort before the call: the faults one site can have on its own (its SDK's retries left on, the policy left out, a timeout of its own, the caller's signal left out).
- **Removed:** "retries on a 429 then succeeds" from `deepseek/chat.test.ts` and `openai/chat.test.ts`. The single-retry suite's rows for those adapters fail on the same fault. Google's keeps its own, as `/google` has a retry loop of its own.

## [0.47.2] — 2026-11-28

**The `/claude-cli` reported-cost tests are one table.** It lives in `src/claude-cli/chat.session.test.ts`, beside the span-usage rows, and runs six kinds of `total_cost_usd` (finite, JSON `-0`, missing, malformed, negative and the `1e999` overflow) on each of the four call paths: one-shot `chat()`, `chat()` on a held session, and `chatWithToolLoop` with and without a held session. Each row compares, in one `toStrictEqual`, the returned `costUsdReported` and `costUsdReportedInvalidType`, the span's two cost attributes and the four returned counts, so a key set to `undefined` fails just as a wrong value does. No behaviour of the library changes.

- **Replaced**: the `costUsdReported` block in `chat.test.ts` (33 tests) and the cost tests in `chat.session.test.ts` (4 span tests and 46 in "costUsdReported on a held session"), 83 tests in all, by the table's 24 rows, each named for what it holds ("a negative cost is not relayed, and is recorded as negative").
- **Where each fault is caught**: classifying a value (every malformed type, `NaN`, `-Infinity`) stays in `cost.test.ts`. The table catches each call path's wiring, the span's cost attributes, keys left out rather than set to `undefined`, the `-0` normalisation and the overflow. `-0` and the overflow are values only parsing JSON yields: the one-shot path parses the child's own output, and the held-session rows are given the value already parsed.

## [0.47.1] — 2026-11-28

**The `/claude-cli` idle-timeout tests start one silent child for the four tests of its rejection and its kill, and a test asserts that a prompt completion leaves no idle timer pending.** Only `src/claude-cli/chat.idle-timeout.test.ts` changes; no behaviour of the library changes. The two precedence tests start silent children of their own, as they did.

- **One silent child, started once, for two tests.** The three tests of the rejection's message, code and `timeoutMs`, and the test that the child is killed, each started a child and waited out the idle timeout. A `beforeAll` starts one child, keeps its rejection, polls until its process is gone, and puts back everything it set. One test compares `{ message, code, timeoutMs }` in one `toEqual`, whose diff names the field that broke; the other asserts the process was gone.
- **A prompt completion leaves no idle timer pending.** In place of a test that waited after a clean close, a test fakes `setTimeout` and `clearTimeout` around a real stub child and asserts `vi.getTimerCount()` is `0` once `chat()` resolves.
- **The file's clean-up puts back only what was set.** `PATH` is restored where a stub was written and the idle override where one was set; a test that sets neither leaves both as the runner gave them.

## [0.47.0] — 2026-11-28

**The OpenTelemetry span's `gen_ai.provider.name` is now the conventions' well-known value wherever one applies.** The registry at `semantic-conventions-genai` v0.1.0 says that if one of its values applies, it MUST be used. Only the span changes: the `provider` on what `chat()`, `chatWithTools` and `chatWithToolLoop` return, which pricing and routing key on, is unchanged on every adapter, as is the `ModelSpan` given to `setModelSpanSink`.

- **Action needed: three adapters' spans carry a new `gen_ai.provider.name`.** A dashboard, query or alert that filters on the old value must change to the new one:

  | Adapter          | Was             | Now                                           |
  | ---------------- | --------------- | --------------------------------------------- |
  | `/vertex`        | `vertex`        | `gcp.vertex_ai`                               |
  | `/vertex-openai` | `vertex-openai` | `gcp.vertex_ai`                               |
  | `/google`        | `google`        | `gcp.gemini`, or `gcp.vertex_ai` on Vertex AI |

  `/vertex` and `/vertex-openai` now share one value, the endpoint the call is made to (`aiplatform.googleapis.com`), whichever model family answers. To tell them apart, use `gen_ai.request.model`, or the returned usage's `provider`. The `/google` value is read from the client the call uses: `gcp.vertex_ai` when its `vertexai` is true, as the SDK decides from its options and environment, otherwise `gcp.gemini`.

- **Unchanged.** `/anthropic` and `/claude-cli` say `anthropic`, `/openai` `openai`, `/deepseek` `deepseek` and `/mistral` `mistral`, the registry's value at v0.1.0, which renamed it from `mistral_ai`. A backend or dashboard that follows the older registry, as `semantic-conventions` v1.41.0 lists it, looks for `mistral_ai`. `/samba` keeps `samba`, the library's own value, because the registry has none for SambaNova.
- **The values are constants in `src/otel.ts`** (`GEN_AI_PROVIDER_ANTHROPIC`, `GEN_AI_PROVIDER_GCP_VERTEX_AI`, `GEN_AI_PROVIDER_GCP_GEMINI`, `GEN_AI_PROVIDER_OPENAI`, `GEN_AI_PROVIDER_DEEPSEEK`, `GEN_AI_PROVIDER_MISTRAL`, `GEN_AI_PROVIDER_SAMBA`). The README's "Telemetry" section has the table of adapter, value and reason.
- **Correction to 0.46.0's entry**: it listed `/anthropic` and `/vertex` among the adapters that leave a count off the span for a reply with no usage object. Those two adapters read the usage object unguarded. What is tested for them is a reply whose usage object carries no value for a count. The entry below now says so.

## [0.46.0] — 2026-11-27

**The OpenTelemetry span now follows the GenAI semantic conventions at `open-telemetry/semantic-conventions-genai` v0.1.0 (status Development), which name the cache counts and count cached tokens as input.** The changes marked "Action needed" below change what the span carries: a dashboard, query or alert that reads it must change with them. What `chat()`, `chatWithTools` and `chatWithToolLoop` return (token counts and cost) is unchanged on every adapter, as is the `ModelSpan` given to `setModelSpanSink`.

- **Action needed: the two cache counts are renamed to the conventions' names.** `verevoir.llm.cache_read_input_tokens` is now `gen_ai.usage.cache_read.input_tokens`, and `verevoir.llm.cache_creation_input_tokens` is now `gen_ai.usage.cache_write.input_tokens`. The old names are no longer emitted, and their constants (`ATTR_VEREVOIR_CACHE_READ_INPUT_TOKENS`, `ATTR_VEREVOIR_CACHE_CREATION_INPUT_TOKENS`) are gone from `src/otel.ts`. Read the new names, on every adapter.
- **Action needed: the span's `gen_ai.usage.input_tokens` now includes cached tokens on every adapter.** The conventions count every input token of the call there, those read from and written to a cache included. On some adapters the number changes; on the others it was already that count and stays as it was:

  | Adapter                                | Provider's input count includes cached tokens? | Span's `gen_ai.usage.input_tokens`                             |
  | -------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
  | `/anthropic`, `/vertex`, `/claude-cli` | No                                             | Now input + cache read + cache write (was input alone)         |
  | `/samba`, `/mistral`, `/vertex-openai` | Yes                                            | Now `prompt_tokens` as given (was `prompt_tokens` less cached) |
  | `/deepseek`                            | Yes                                            | `prompt_tokens` as given, as before                            |
  | `/openai`                              | Yes                                            | `input_tokens` as given, as before                             |
  | `/google`                              | Yes                                            | `promptTokenCount` as given, as before                         |

  A query that adds the cache counts to `gen_ai.usage.input_tokens` to get the whole input must stop adding them on every adapter; one that subtracts them from `/samba`, `/mistral` or `/vertex-openai` spans to get the uncached input must now subtract them on `/anthropic`, `/vertex` and `/claude-cli` spans too. On `/claude-cli` a call whose prompt is mostly cached changes most: a reply with `input_tokens: 2`, `cache_read_input_tokens: 11842` and `cache_creation_input_tokens: 15647` was a span input of 2 and is now 27,491. With no input count from the provider, the span's input is never made from the cache counts alone.

- **Action needed: a usage count the provider gave no value for is now left off the span, on every adapter.** When a reply's usage carried no value for a count, some adapters put `0` on the span: `/anthropic`, `/vertex` and `/claude-cli` for any of `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` and the two cache counts; the others for the input and output counts. On every adapter but `/anthropic` and `/vertex`, a reply with no usage object at all is also tested, with the same result; those two read the usage object unguarded and are tested with an empty one. That attribute is now absent. A `0` the provider did send is on the span as `0`: `/deepseek`, `/openai`, `/google`, `/samba`, `/mistral` and `/vertex-openai` used to drop a cache-read count of `0`, and now carry it. A query that sums or averages these attributes now skips a call whose provider gave no count, where it used to count it as `0`. To find those calls, look for spans that lack the attribute.

- **Unchanged.** What the conventions still have no attribute for keeps its `verevoir.llm.*` name: the 5-minute and 1-hour split of a cache write, the provider's request id, the session id, the reported cost and its invalid kind. The span's name (`chat {model}`) and kind (CLIENT) are as before.
- **The README has a "Telemetry" section**: the span, the attributes and the adapter table above.

## [0.45.0] — 2026-11-25

**A reply now says why the model stopped in one small set of words, `stopKind`, whichever provider answered.** `stopReason` is unchanged: it is still the provider's own word.

A caller that set an output limit had to know each provider's vocabulary to tell a reply cut off at it from one that finished: `max_tokens` from one, `length` from another, `MAX_TOKENS` from a third, and on `/openai` only the status `incomplete`. `chat` and `chatWithTools` now return `stopKind` beside `stopReason`, one of:

| `stopKind`      | The model                                    |
| --------------- | -------------------------------------------- |
| `finished`      | finished its reply                           |
| `max_tokens`    | stopped at the output limit                  |
| `tool_use`      | stopped to call a tool                       |
| `stop_sequence` | stopped at a stop sequence                   |
| `refused`       | refused, or the reply was filtered           |
| `other`         | stopped for a reason the adapter cannot name |

- **Each adapter maps its provider's words in one place.** The README's "Why a reply stopped" has the table, adapter by adapter.
- **A word the adapter does not know is `other`**, the empty string included. It is never an error, and `stopReason` still carries the word.
- **`/openai` keeps the reason behind `incomplete`**: `stopReason` is still the response's `status`, and `stopKind` is read from `incomplete_details.reason`.
- **On `/claude-cli`, a result that names no stop reason is `other`.** Its `stopReason` is `'end_turn'`, which that adapter gives when none is named, so the kind is what tells a missing reason from a real finish.
- **`EmptyResponseError` carries `stopReason` and `stopKind` as fields**, those of the reply that had no text. Built with a message alone, they are `''` and `'other'`.

**What a caller may need to change.** `stopKind` is a required field of `ChatReply` and `ChatWithToolsResult`. Code that only reads results is unaffected. Code that builds one by hand, as a test double does, must add the field for TypeScript to accept it.

**Not verified against live calls.** The words for `/deepseek`, `/samba`, `/mistral` and `/vertex-openai` are taken from the OpenAI SDK's types, and `/openai`'s `incomplete_details.reason` from its Responses types. The maps say so where they live.

## [0.44.0] — 2026-11-24

**`@verevoir/llm/anthropic` and `@verevoir/llm/vertex` now retry a failed request at one layer, by the same policy as the adapters that send through the `openai` SDK.** Each built its client with the Anthropic SDK's default of two retries, and also wrapped every request in a retry of its own, so each attempt of that retry was itself up to three requests. The SDK's retries are now off on both clients (`maxRetries: 0`), the adapters' own copy of the retry is gone, and the library's one policy (0.43.0) makes every retry. This is a behaviour change for a call that meets a failure: the number of requests and the waits between them change (below). A call that succeeds first time is unchanged, as are the thrown errors and every export.

For one call of `chat` or `chatWithTools`, or one request of `chatWithToolLoop`, that fails the same way every time:

| A request that fails with                                                         | Before: requests | Before: `onRetry` calls | Now: requests | Now: `onRetry` calls |
| --------------------------------------------------------------------------------- | ---------------- | ----------------------- | ------------- | -------------------- |
| HTTP 429, 500, 503 or 529                                                         | 12               | 3                       | 4             | 3                    |
| HTTP 408, 409, 502, 504 or another status of 500 or above                         | 3                | 0                       | 4             | 3                    |
| A connection failure                                                              | 3                | 0                       | 4             | 3                    |
| A request never answered (the SDK's 10-minute timeout)                            | 3                | 0                       | 3             | 2                    |
| A 400 with `x-should-retry: true`                                                 | 3                | 0                       | 4             | 3                    |
| A 429, 500, 503 or 529 with `x-should-retry: false`                               | 4                | 3                       | 1             | 0                    |
| A stream that fails part-way with `overloaded_error` or `rate_limit_error`        | 4                | 3                       | 4             | 3                    |
| A stream that fails part-way with `api_error` or `timeout_error`                  | 1                | 0                       | 4             | 3                    |
| A stream that fails part-way with another type, or is cut off with no error event | 1                | 0                       | 1             | 0                    |
| HTTP 400, 401, 403, 404 or 422                                                    | 1                | 0                       | 1             | 0                    |

- **A 429, 500, 503 or 529 answered every time: 12 requests fall to 4.** One request, then the policy's three retries, after waits of 5, 30 and 120 seconds. Before, each of those four attempts was three requests, the SDK's two retries coming about half a second and one second apart.
- **A 408, 409, 502, 504 or other 5xx, a connection failure: 3 requests become 4, on longer waits.** Only the SDK retried these, twice, after waits of about half a second and one second. The library's policy now does, three times, after 5, 30 and 120 seconds, and `onRetry` is told, as it never was for these.
- **A request never answered: 3 requests, as before, and no longer in total.** The SDK gave up each request after its 10-minute timeout, which these adapters do not set, and retried twice, waiting about a second and a half in all between them: 30 minutes and up to a second and a half. The policy sends a timed-out request again at once, at most twice: 30 minutes. `onRetry` is now told, with `delayMs` 0.
- **An abort stops the retries.** The policy takes the call's `abortSignal`. Once it is aborted no request is started: a wait in progress ends at once, a request that fails in a retried way is not sent again, and the call rejects with the signal's `reason`. Before, the signal was read only before each request's first attempt, so the retries and their waits, up to 155 seconds of them, ran on after an abort. The signal is still not handed to the SDK: a request in flight is not cut short.
- **A streamed answer that fails part-way.** Every request these adapters make is streamed, and a stream can open with a 200 and then report an error event, which carries no status. The policy now retries such an error by its `type`, when `classifyLlmError` calls that type retryable: `overloaded_error`, `rate_limit_error`, `api_error` and `timeout_error`. The first two were retried before, recognised in the error's message; `api_error` and `timeout_error` were sent once and are now retried. As before, the answer is read only from a stream that completed, so a retry never repeats or adds to text the failed stream delivered; and, as before, an `onProgress` report the failed stream had completed may be reported again by the retry. A stream cut off with no error event is still sent once.
- **This rule is the shared policy's, so it holds on the `openai` SDK adapters too.** An error with no numeric `status` and one of those four values as its `type` is retried on `/openai`, `/deepseek`, `/samba`, `/mistral` and `/vertex-openai` as well. Nothing else changes for them.
- **`x-should-retry` is read as the SDK read it.** `true` retries a response of any status; `false` stops a retry of any status. One case is retried less than before: a 429, 500, 503 or 529 with `x-should-retry: false` was sent four times, because the adapters' own retry did not read the header, and is now sent once.
- **`onRetry` is now told of every retry.** It was called three times while eleven requests followed the first; the eight the SDK made were never reported. Every request after the first is now preceded by one call.
- **The `reason` given to `onRetry`.** For 429, 500 and 503 it is worded as before. For a 529 it reads `Anthropic server error (529)`, where it read `Anthropic overloaded (529)`. For an error event of a stream it names the kind and the type, for example `Anthropic overloaded (overloaded_error)`, where it read `Anthropic overloaded (529)` or `Anthropic rate-limited (429)`. An error whose message holds the text `529` or `overloaded_error`, with neither that status nor that type, is no longer retried on the strength of the message.
- **Known difference from the SDK's own retries: `Retry-After` is not honoured.** The SDK waited as a `Retry-After` or `retry-after-ms` header asked, within its own retries. The library's policy waits its fixed 5, 30 and 120 seconds whatever the response says.
- **Where it applies.** `chat`, `chatWithTools` and every request `chatWithToolLoop` makes, on both subpaths. On `/anthropic`: the client built for a per-call `apiKey` and the client kept for the environment's credential, whether that is `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and the one further call made on the metered key after a subscription token is rejected. On `/vertex`: its one kept client.
- **Why the waits are 5, 30 and 120 seconds.** The list came from this adapter. The comment that stood beside it there gave its purpose: Anthropic outages of about an hour are real, a single retry is not enough, so the adapter keeps trying with a growing wait so that the caller can narrate it, on a total "comfortably under typical serverless request timeouts"; a longer outage exhausts the retries and the error is thrown. 0.16.0 records how the list came to be three steps long.
- **One policy in the source.** `src/anthropic/adapter.ts` holds no retry, no wait and no list of statuses of its own: it calls the internal `src/retry-policy.ts`, which no subpath exports. Each client module constructs its SDK client in one place.
- `@verevoir/llm/google` is unchanged: it has a retry loop of its own, on the same waits. `@verevoir/llm/claude-cli` is unchanged and makes no retries.

## [0.43.0] — 2026-11-24

**The adapters that send through the `openai` SDK now retry a failed request at one layer, where four of them retried at two, and that one layer retries everything the two did.** `@verevoir/llm/openai`, `/deepseek`, `/samba` and `/mistral` each built its client with the SDK's default of two retries, and also wrapped every request in the library's own retry policy, so each attempt of that policy was itself up to three requests. The SDK's retries are now off on these clients (`maxRetries: 0`), as they already were on `/vertex-openai`, and the library's policy is widened to what the SDK's covered. This is a behaviour change for a call that meets a failure: the number of requests and the waits between them change (below). A call that succeeds first time is unchanged, as are the thrown errors and every export.

- **What the policy retries now.** HTTP 408, 409, 429 and any status of 500 or above; a connection failure and a request timeout; and any response carrying `x-should-retry: true`. Before, it retried 429, 500, 502 and 503 only. As before, an error whose message names a 429, 500, 502 or 503 is retried too. 400, 401, 403, 404 and 422 are one request, as they were.
- **A 429, 500, 502 or 503 answered every time: 12 requests fall to 4.** One request, then the policy's three retries, after waits of 5, 30 and 120 seconds. Before, each of those four attempts was three requests.
- **A 408, 409, 504 or other 5xx, a connection failure: 3 requests become 4, on longer waits.** Only the SDK retried these, twice, after waits of about half a second and one second. The library's policy now does, three times, after 5, 30 and 120 seconds, and `onRetry` is told, as it never was for these. The 5, 30 and 120 seconds were chosen for provider outages (0.16.0) and are applied to these failures as they stand, not tuned for them.
- **A request timeout: 3 requests, as before, with no wait between them.** The SDK retried a request it gave up waiting on twice. The policy does the same: a timeout is sent again at once, and at most two of a call's retries follow a timeout. `onRetry` is told, with `delayMs` 0. On `/vertex-openai`, where the SDK's retries were already off, a timeout was one request and is now up to three.
- **An abort stops the retries.** The policy takes the call's `abortSignal`. Once it is aborted no request is started: a wait in progress ends at once, a request that fails in a retried way is not sent again, and the call rejects with the signal's `reason`, as an abort before the call always did. Before, the signal was read only before a request's first attempt, so the retries and their waits ran on after an abort. The signal is still not handed to the SDK: a request in flight is not cut short.
- **`x-should-retry` is read as the SDK read it.** `true` retries a response of any status; `false` stops a retry of any status. One case is retried less than before: a 429, 500, 502 or 503 with `x-should-retry: false` was sent four times, because the library's policy did not read the header, and is now sent once.
- **`onRetry` is now told of every retry.** It was called three times while eleven requests followed the first; the eight the SDK made were never reported. Every request after the first is now preceded by one call.
- **Known difference from the SDK's own retries: `Retry-After` is not honoured.** The SDK waited as a `Retry-After` or `retry-after-ms` header asked, within its own retries. The library's policy waits its fixed 5, 30 and 120 seconds whatever the response says.
- **The rules, and the bounds they give every call.** A call makes at most 4 requests, whatever the failures. A failure that is not a request timeout is retried after the next unused wait, in order: 5 seconds, then 30, then 120. A request timeout is retried at once, and at most 2 of a call's retries follow a timeout. Nothing else is retried, and an abort ends a wait and stops retrying. So every call, whatever mix of failures it meets, makes at most 4 requests, waits at most 155 seconds in all, and meets at most 3 request timeouts. Each is reached: a request that fails every time with a status or a connection failure is given up after 4 requests and 155 seconds of waiting, plus the requests' own time; one that is never answered runs each request to the SDK's 10-minute timeout and is given up after three requests and 30 minutes, as it was (less the SDK's second and a half of waits).
- **Where it applies.** `chat` on `openai` and `deepseek`. On `samba`, `mistral` and `vertex-openai`, and on any adapter built by the OpenAI-compatible factory: `chat`, `chatWithTools` and every request `chatWithToolLoop` makes. Both the client kept for the key in the environment and the client built for a per-call `apiKey`.
- **`@verevoir/llm/vertex-openai` changes too.** Its client already had the SDK's retries off, so it retried 429, 500, 502 and 503 only; it now retries the wider list, where those other failures were one request.
- **One policy in the source.** The three copies of the policy (the factory's, `openai`'s and `deepseek`'s) are one internal module, which no subpath exports. The reasons `onRetry` is given for 429, 500, 502 and 503 are worded as before.
- The adapters that do not use the `openai` SDK are unchanged.

## [0.42.0] — 2026-11-24

**New subpath `@verevoir/llm/vertex-openai`: Vertex AI's OpenAI-compatible Chat Completions endpoint, where Google Cloud serves models of several publishers.** It exports `chat`, `chatWithTools`, `chatWithToolLoop` and `PROVIDER` (`'vertex-openai'`), the namespaced `vertexOpenAI`, and the error classes `VertexOpenAIConfigError` and `VertexOpenAITokenError`. The subpath is new; no other subpath's exports or behaviour change, and no core type changes.

- **The endpoint.** `POST https://aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions` for the location `global`; any other location is served by `{location}-aiplatform.googleapis.com`. Requests are sent by the `openai` SDK.
- **New optional peer dependency: `google-auth-library`.** Install it, with `openai`, only to import `@verevoir/llm/vertex-openai`. No other subpath imports it; `@verevoir/llm/vertex` still gets its own copy through `@anthropic-ai/vertex-sdk` and needs nothing new.
- **`model` is required.** The endpoint has no fixed catalogue, so the subpath has no `models`, no `rates` and no default. Pass `model` as `<publisher>/<model>` (for example `google/gemini-3.5-flash`); it is sent exactly as given. A call with no `model`, or a blank one, is refused with a `VertexOpenAIConfigError` (`setting: 'model'`) before any token is asked for or any request sent. `modelClass` selects nothing; it is reported as `TokenUsage.direction`.
- **Credentials.** Google Cloud's standard credentials flow, through `google-auth-library`, for the scope `https://www.googleapis.com/auth/cloud-platform`. The access token is asked for before every request, each tool-loop iteration included, so a token the library has replaced is the one sent; the library fetches a new one only when the one it holds is about to expire. No credential is looked up when the subpath is imported. There is no API key: a per-call `apiKey` is refused (`setting: 'apiKey'`), and `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` are not used.
- **Project and location** come from `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, read on each call; `ChatOptions` has no field for them. They are not the variables `@verevoir/llm/vertex` reads (`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`), and neither subpath reads the other's. A missing or blank project is refused with a `VertexOpenAIConfigError` (`setting: 'GOOGLE_CLOUD_PROJECT'`, message `No Vertex AI project: set GOOGLE_CLOUD_PROJECT.`). The location defaults to `global`: the endpoint answers there, and some models answer nowhere else. A project or location that is not a plain identifier is refused without being repeated, since both become part of the URL the token is sent to. There is no base-URL override. One client is kept while both settings stay the same.
- **Usage** carries `provider: 'vertex-openai'` and `route: 'google-cloud'`. `inputTokens` is `prompt_tokens` less cached tokens; `cacheReadInputTokens` is `prompt_tokens_details.cached_tokens` when reported and `0` when that member is absent or `null`; `cacheCreationInputTokens` is always `0`. Reasoning tokens are counted within `outputTokens`: where the response's `total_tokens` equals prompt + completion + reasoning they were reported apart from `completion_tokens` and are added, otherwise `completion_tokens` is the whole output. The endpoint's `extra_properties` member is not read.
- **Cost.** No price is added. A call is priced only if the price book has an entry for the exact model name sent, or for `vertex-openai/<that name>`; otherwise it is `unpriced`.
- **Failures.** The `openai` SDK's errors are thrown unchanged, so `classifyLlmError` gives a 401 `authentication`, a 403 `permission`, another 4xx `invalid-request`, and so on. A failure to obtain an access token is a `VertexOpenAITokenError`: no request was sent, the error has no `status`, its message is fixed, and the credentials library's own error is on `cause`. It classifies as `other`, not retryable, and the adapter does not retry it. `VertexOpenAIConfigError` classifies as `other` too. The library's own errors and the model span's `scope` read `vertex-openai.chat`, `vertex-openai.chatWithTools` and `vertex-openai.chatWithToolLoop`. The access token is in no error, span or log line this library writes.
- **Retries.** The `openai` SDK's own retries are off on this subpath's client (`maxRetries: 0`), so the library's retry policy is the only one: a retryable status is sent again at most three times, with the library's backoff, and an access token is asked for before each of those requests. With the SDK's default left on, each of the library's attempts would itself have been up to three requests.
- **Nothing is registered** into the model catalogue or the connection registry, so `isProviderConfigured`, `resolveModel` and the other routing helpers do not know a `vertex-openai` provider, and `@verevoir/llm/catalog` is unchanged.
- **Inside the library.** The three call shapes of the OpenAI-compatible factory are now a function of their own, which the factory calls with its key, base URL and catalogue as before and this subpath calls with its own client and model rule. The adapters built by the factory send the same requests and report the same usage as in 0.41.0.

## [0.41.0] — 2026-11-24

**`ChatOptions.model` is now honoured by `@verevoir/llm/samba`, `@verevoir/llm/mistral` and `@verevoir/llm/deepseek`: a call that names a model is sent that model.** Before, these adapters never read the option and sent their own id for the `modelClass`, so a caller that named a model was silently given the provider's default one. This is a behaviour change for any call to these three subpaths that already passes `model`: it now reaches the model it names. A call that does not pass `model` is unchanged.

- **Where it applies.** On `samba` and `mistral`, which are built by the shared OpenAI-compatible factory: `chat`, `chatWithTools` and every call `chatWithToolLoop` makes, including each iteration and the loop's final call after the iteration cap. On `deepseek`, which has its own adapter file and exports `chat` only: `chat`.
- **The id is sent exactly as given**, as `@verevoir/llm/anthropic` does. It is not looked up in the model catalogue, so a family name or other alias is not resolved to a current id, and nothing checks that the provider serves the model; a name the provider does not know fails as that provider's own error.
- **Without `model`, the request is the same as before:** the adapter's id for the `modelClass`.
- **Usage and spans report the id that was sent.** `TokenUsage.model` (on the result and on each `onUsage` call), the `ModelSpan` passed to the model-span sink, and the OpenTelemetry span's request model all carry the named id, where they used to carry the class's id.
- **`TokenUsage.direction` is unchanged:** it is the `modelClass` the call asked for (`'reasoning'` when none was given), whether or not the named model belongs to that class.
- **Cost.** A usage record is priced by the model name it carries, so a call that names a model is priced as that model; a name the price book cannot match is reported as `unpriced`.
- **`@verevoir/llm/openai` and `@verevoir/llm/google` are unchanged.** They still accept `model` and ignore it, sending their own id for the `modelClass`.

## [0.40.0] — 2026-11-24

**New subpath `@verevoir/llm/vertex`: Claude on Google Cloud Vertex AI, as the Anthropic adapter with a different client.** It exports `chat`, `chatWithTools`, `chatWithToolLoop` and `PROVIDER` (`'vertex'`), plus the namespaced `vertex`. The subpath is new, and the direct route's behaviour is unchanged. One exported type is wider, and it is the one thing an existing consumer may need to act on: `CredentialRoute` gains the value `'google-cloud'`, so an exhaustive `switch` over it with no `default` needs a case for the new value. Where exhaustiveness is checked, that code stops compiling until the case is added; where it is not, the new value falls through unhandled. Only `@verevoir/llm/vertex` reports the value.

- **One implementation, two clients.** The request building, the cache breakpoints for each `cache` value (`'none' | 'default' | 'prefix'`), the streaming, the retries, the tool loop and the usage accounting are the Anthropic adapter's own code, now in an internal module that both subpaths call. A Vertex request is the request `@verevoir/llm/anthropic` sends on an API key, for `chat`, `chatWithTools` and every call `chatWithToolLoop` makes. Only the client differs: an `AnthropicVertex` from `@anthropic-ai/vertex-sdk`. The shared module imports neither route's client module: the one system block a route adds to a request because of its credential, the direct route's subscription-token identity, is supplied by that route.
- **`@verevoir/llm/anthropic` is unchanged.** Its exports, its credential rules and the requests it sends are the same as before, byte for byte. It does not import the Vertex package; only `@verevoir/llm/vertex` does.
- **New optional peer dependency: `@anthropic-ai/vertex-sdk`.** Install it only to import `@verevoir/llm/vertex`. It declares `@anthropic-ai/sdk` as a dependency of its own, so that package is not installed separately for this route, and the subpath does not load the direct route's client module.
- **Credentials.** Authentication is Google Cloud's standard credentials flow, run by the Vertex SDK. There is no API key: a per-call `apiKey` is refused with a plain error, and `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are never read. The direct adapter's subscription-token identity block and its fallback to the metered key are not part of this route; a rejected call is not made again on another credential.
- **Project and region** come from the environment variables the Vertex SDK itself reads, `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION`, on each call; `ChatOptions` has no field for them. If either is unset or blank the call is refused before anything is sent, with a plain error naming the variable and no value. One client is kept and reused while both stay the same.
- **Model names are sent exactly as given:** `model` when set, otherwise the Anthropic catalogue's id for the `modelClass`. There is no mapping to Vertex AI's names; where Vertex AI names a model differently, pass that name as `model`.
- **Usage is reported as on the direct route**, including cache writes, cache reads and the five-minute / one-hour cache-write split, with `provider: 'vertex'` and `route: 'google-cloud'`. `CredentialRoute` gains the value `'google-cloud'`; only this subpath reports it. The price book has no entry of its own for provider `vertex`: a call is priced only if the exact model name sent (or `vertex/<model>`) has an entry, and is `unpriced` otherwise. Pricing Vertex calls is the caller's concern.
- **Failures.** `classifyLlmError` gives the same kind for the same status: the Vertex SDK throws the Anthropic SDK's own error classes, so no recognition rule was added. The library's own errors and the model span's `scope` read `vertex.chat`, `vertex.chatWithTools` and `vertex.chatWithToolLoop`.
- **Nothing is registered** into the model catalogue or the connection registry by this subpath, so `isProviderConfigured`, `resolveModel` and the other routing helpers do not know a `vertex` provider.
- **Development dependency note.** The development dependency on `@anthropic-ai/sdk` moved to the 1.x line in the previous commit. The peer range is unchanged.

## [0.39.0] — 2026-11-23

**New `ChatOptions.cache` value `'prefix'`: cache the system prompt and never the conversation.** For a caller whose calls share a system prompt with sibling calls, but whose own conversation nothing else will read. Until now it had to choose between writing its conversation to the cache on every tool-loop iteration (`'default'`) and giving up the shared prefix as well (`'none'`). Acted on by `@verevoir/llm/anthropic` only, on `chat`, `chatWithTools` and every call `chatWithToolLoop` makes.

- **`'prefix'` sends one breakpoint, on the system prompt, and none on the conversation.** The breakpoint on the system prompt caches the tools and the system prompt together, with the provider's five-minute default lifetime, exactly as under `'default'`. The messages go out as the caller sent them, on every call, including a `chat` continuation, every tool-loop iteration and the loop's final call after the iteration cap.
- **It is a trade within one tool loop, not a saving in every case.** Under `'default'` each iteration writes the growing conversation to the cache and the next iteration reads it back. Under `'prefix'` each iteration re-sends the whole conversation uncached: more plain input tokens per iteration, in exchange for never paying the cache-write premium on the conversation. That pays only when the conversation is short, or when nothing will read it again. For a long loop, `'default'` is usually the cheaper choice.
- **The provider's minimum cacheable length still applies to the system prompt.** A prefix shorter than it is not cached at all, under any value; `'prefix'` does not change that.
- **`'default'`, `'none'` and leaving the option out change nothing.** Their requests are the same as before, byte for byte. A value outside the three, from an untyped caller, is still treated as `'default'`.
- **Every other adapter accepts the value and ignores it**, as it does the other two.

## [0.38.0] — 2026-11-23

**New `classifyLlmError(err)`: pass it the error a call rejected with and it says what went wrong, as `{ kind, retryable }`, so a caller can tell an authentication failure from a rate limit, an overload, a bad request or a timeout without knowing which provider answered.** Exported from the main entry, with the types `LlmErrorKind` and `LlmFailure` and the class `EmptyResponseError`.

- **Thrown errors are unchanged.** Every adapter rejects with exactly what it rejected with before: the provider SDK's own error, or this library's own plain `Error`. `err.status`, `err.code`, `err.message` and `instanceof` checks all read as they did. `classifyLlmError` only reads the error it is given; it wraps nothing and returns a plain object, `LlmFailure`.
- **The kinds:** `authentication` (HTTP 401), `permission` (403), `rate-limited` (429), `overloaded` (529), `unavailable` (any other 5xx, or a connection failure), `invalid-request` (any other 4xx), `timeout` (408, an SDK request timeout, or a `claude-cli` idle / turn timeout), `empty-response` (the call succeeded but `chat()` got no text), `other` (everything else). `rate-limited`, `overloaded`, `unavailable` and `timeout` are retryable; the rest are not. The README's Failures section has the full table.
- **How a kind is recognised, first match wins.** The `EmptyResponseError` class; a `code` of `CLAUDE_CLI_IDLE_TIMEOUT` or `CLAUDE_CLI_SESSION_TURN_TIMEOUT`; a numeric `status` (a non-numeric one is never coerced); then, with no usable status, the string `type` the Anthropic SDK puts on an error that arrives part-way through a stream (`overloaded_error`, `rate_limit_error`, `api_error`, `timeout_error`); then the class name the Anthropic and OpenAI SDKs give a request that got no response (`APIConnectionTimeoutError`, `APIConnectionError`). It never reads message text. An unknown shape is `other`, not retryable.
- **The one addition visible on a thrown error from the API adapters: `EmptyResponseError`.** When `chat()` gets no text back, `anthropic`, `google`, `openai`, `deepseek`, `samba` and `mistral` now throw an instance of this exported class, which `extends Error`, where they threw a plain `Error`. Its `message` is exactly the old one (`<provider>.chat: response had no text content (…)`, with the finish reason) and its `name` is still `Error`, so `instanceof Error`, a message match, a logged error and a span's `error.type` are all as before.
- **The one addition on `claude-cli`: a `code` on the held-session turn timeout.** That error now carries `.code === 'CLAUDE_CLI_SESSION_TURN_TIMEOUT'`, exported from `@verevoir/llm/claude-cli` as `CLAUDE_CLI_SESSION_TURN_TIMEOUT_CODE`; its message is unchanged. It had nothing but message text to recognise it by. The idle timeout already carried `.code === 'CLAUDE_CLI_IDLE_TIMEOUT'`.
- **What cannot be told apart:** only Anthropic signals overload separately (the others report it as a 5xx, `unavailable`); a network failure or timeout on Google is `other` (that SDK throws the platform's fetch error, with no status or class of its own); `claude-cli` reports why it failed only as free text, so everything but its two timeouts is `other`; and there is no `aborted` kind, so an aborted `abortSignal`'s `reason` is `other`, as are the library's own argument and configuration checks.

## [0.37.0] — 2026-11-22

**New `ChatOptions.cache` (`'none' | 'default'`): a caller can now turn prompt caching off for a call.** Acted on by `@verevoir/llm/anthropic` only, on `chat`, `chatWithTools` and every call `chatWithToolLoop` makes.

- **`'default'`, and leaving the option out, change nothing.** The request is the same as before, byte for byte: one breakpoint on the system prompt, plus one on the end of the conversation wherever a growing history is re-sent, with the provider's five-minute default lifetime.
- **`'none'` sends no `cache_control` anywhere in the request**, neither on the system prompt nor on the conversation, including in the tool loop. For a call whose prefix nothing will read again: a cache write is billed at a premium over plain input, and that only pays back when a later call reads the entry.
- **There is no longer-lifetime value.** The provider's one-hour lifetime costs more to write and nothing needs it; an option nobody is asking for is surface to maintain. A value outside the two, from an untyped caller, is treated as `'default'`.
- **Every other adapter accepts the option and ignores it.** They place no cache breakpoints of their own.
- **`chatWithToolLoop` now sums the five-minute / one-hour cache-write split into its returned `usage`**, as `chat` already did (`cacheCreationEphemeral5mInputTokens` / `cacheCreationEphemeral1hInputTokens`, `undefined` unless the provider reported them). Before, the split reached only the per-iteration `onUsage` hook, so `book.costOf(result.usage)` could not price one-hour writes at their own rate. A caller reading these two fields on the loop's result will now see numbers where it saw `undefined`.

## [0.36.0] — 2026-11-06

**SECURITY: `claude-cli` now passes `CLAUDE_CONFIG_DIR` through to the child `claude`.** Decided by the operator on 6 Nov 2026. The env allowlist was `PATH`, `HOME`, `TMPDIR`, `CLAUDE_CODE_OAUTH_TOKEN`; it is now those plus `CLAUDE_CONFIG_DIR`. Why: anyone whose Claude login lives under a custom config dir got "Not logged in" on every call, because the filter stripped the variable that says where the login is. It is a path, not a secret.

- **Threat-model delta, stated honestly.** `CLAUDE_CONFIG_DIR` points the child at a config directory whose `settings.json` can define hooks or MCP servers that run commands, and which can hold a stored login of either kind (subscription or metered Console). That is not a wholly new exposure: `HOME` was already passed, and it already exposes `~/.claude`, the default config dir, with the same contents. What is new is that the caller can now choose a _different_ directory, so the content the child trusts is whatever the caller's environment names. The allowlist still keeps every other variable out, `ANTHROPIC_API_KEY` included.
- **Mitigations in the runner, which this change leaves in place:** the one-shot `chat()` spawn and the held-session spawn pass `--strict-mcp-config` (no MCP server from any configuration source, only an explicit `--mcp-config`, which only the embedded bridge passes), `--disallowedTools "*"` (no built-in tool) and `--safe-mode`. The `claude --version` probe passes none of them: it runs only `claude --version`, and it does receive `CLAUDE_CONFIG_DIR`.
- **UNVERIFIED: whether `settings.json` hooks still fire under those flags.** `--safe-mode`'s own `--help` is documented to disable hooks (see 0.25.0 and 0.26.0), but this repository has never confirmed that by observing a real invocation with a hook defined, and this change did not either. Do not rely on it. What IS enforced and tested here: the three flags are present when `CLAUDE_CONFIG_DIR` is set on `chat()`'s one-shot spawn (`chat.test.ts`) and on the held-session spawn (`session.test.ts`), the `claude --version` probe receives the variable (`chat.test.ts`), and the variable reaches the child only when the parent sets it. The probe's flags are not asserted (it passes only `--version`). Point `CLAUDE_CONFIG_DIR` only at a directory you control.
- **Public surface change, not "unchanged".** `ALLOWED_ENV_VARS`, which `@verevoir/llm/claude-cli` re-exports, now has five names instead of four: its value and its `as const` tuple type both change. Code that matched the old tuple exactly, or asserted the child env's keys against the old four, will see the difference. The new `CLAUDE_CLI_CONFIG_DIR_ENV_VAR` constant is exported from `env.ts` only, not from the package entry.

**`TokenUsage.costUsdReported` semantics corrected, and malformed values recorded.**

- **Not "not billed".** Earlier wording said the figure is API-equivalent and not money billed, on the argument that the allowlist keeps billed credentials out. That was false: `HOME` (and now `CLAUDE_CONFIG_DIR`) can reach a stored, metered Console login. The field is the CLI's own reported cost: API-equivalent on a subscription login, billed money on a metered Console login. The field cannot tell which. (`route: 'subscription-oauth'` stays a fixed label for this adapter's one mechanism, the CLI authenticating itself; it is not a billing statement.)
- **Finite-number guard.** Only a finite number >= 0 is surfaced (`-0` is accepted as zero and normalised to `0`); otherwise the field is absent (never defaulted to `0` or `NaN`; a reported `0` is relayed) and a negative is malformed and flagged. This is now tested with `Infinity` (`1e999`, at usage and span level), `-Infinity`, `NaN` and negatives.
- **A malformed value is distinguishable from a missing one.** New optional `TokenUsage.costUsdReportedInvalidType` (the kind of malformation: `negative`, `non-finite`, or the type name such as `string` or `null`; never the value) and the span attribute `verevoir.llm.cost_usd_reported_invalid_type` (its presence is the malformed signal; there is no separate boolean attribute). The kind is a closed union, `CostInvalidKind`. Nothing is logged: library code writing to stdout can corrupt a stdio-protocol consumer such as an MCP server. A missing `total_cost_usd` sets none of these.
- Other providers leave all of it absent; the API route's cost comes from the PriceBook.

## [0.35.0] — 2026-10-31

**`@verevoir/llm/claude-cli` gains an idle-output timeout on `chat()`'s fresh-spawn path — closing a real hang (audit AIGENCY-RUNTIME-205): a `claude -p` child that stopped writing to stdout/stderr and never exited left the caller's promise pending forever.** Fixed with an IDLE timer, not a wall-clock one, deliberately: the timer resets on every stdout/stderr chunk, so a call that is genuinely working — including one running a tool call, whose own stream-json assistant/tool_use lines count as stdout — is never killed by this, however long it takes in total. Only a true silent gap trips it.

- **Behaviour change for every existing caller, named here rather than left for a reader to discover by its absence:** a fresh-spawn `chat()` call that previously could hang indefinitely on a silent `claude` process now gets killed (`SIGTERM`, then `SIGKILL` after a 5s grace) and rejects after 10 minutes of silence by default. No caller code change is required, but a caller that relied on (or simply never hit) an unbounded wait should know its calls are now bounded.
- **New `ClaudeCliChatOptions.idleTimeoutMs`** — a per-call override. Precedence, highest first: this option, then the new `CLAUDE_CLI_IDLE_TIMEOUT_MS` env var, then the 10-minute default. A value that is not a finite number greater than zero at any level is treated as absent and falls through to the next — never as "disable the guard", so a caller's or operator's mistake degrades to the safe default instead of removing it.
- **New exported `CLAUDE_CLI_IDLE_TIMEOUT_CODE` (`'CLAUDE_CLI_IDLE_TIMEOUT'`)** — the idle rejection now carries this as a stable `.code`, plus `.timeoutMs`, so a caller can match on it structurally rather than by message text. The message itself is deliberately generic (`"claude CLI produced no output for Nms"`) — this package has no reviewer-specific vocabulary of its own; a caller such as `@verevoir/review` maps this onto its own could-not-run outcome in its own layer.
- Kept the code **distinct** from this package's generic `LLM_TIMEOUT` contract (a different mechanism — wall-clock, not idle — and not yet present on this adapter) rather than reusing it, so a future unification is a deliberate choice, not an assumed one.
- The session-holding transport (a `chat()` call with `session` set) is untouched by this — its own `SESSION_IDLE_TIMEOUT_MS` / `SESSION_TURN_TIMEOUT_MS` bounds (0.27.0) govern that path exactly as before.

## [0.34.1] — 2026-10-22

- **The Anthropic, OpenAI, Google and DeepSeek adapters' exported `rates` tables are now `@deprecated`.** Each doc comment points at `createPriceBook(...)` / `book.costOf(...)` as the successor (the 0.33.0 operator decision, below) instead of the old `estimateCostUSD`. No behaviour change — nothing removed, nothing renamed.
- **Correction to the 0.33.0 entry below:** it said "all 5 provider adapters still call `estimateCostUSD`" — that was inaccurate. No provider adapter calls `estimateCostUSD` at runtime; each adapter only _exports_ a `RatesTable` (`rates`) for a _consumer_ to pass to `estimateCostUSD` itself. The only runtime caller found in this repo was `examples/anthropic-chat.ts`, which this change moves onto `createPriceBook` / `book.costOf(...)` instead.
- **README's "Cost accounting" section now names `createPriceBook` / `book.costOf(...)` as the cost API**, states the bundled snapshot is the fallback and an unknown model is `unpriced` (never `$0`), and marks the adapters' `rates` tables and `estimateCostUSD` as deprecated — matching `llms.txt`.

## [0.34.0] — 2026-10-22

**Spans no longer record provider error messages or stacks; exception events carry the error name and status only. Errors thrown to callers are unchanged.** A privacy audit found that `withGenAISpan`'s failure path (`src/otel.ts`) recorded the raw thrown error on the span via `recordException`, verbatim — including claude-cli's `is_error` throws, which embed the CLI's own response text, and every other adapter's passed-through SDK error messages, plus the standard stack trace `recordException` captures (which carries local file paths). The exception event recorded on a span now carries only the error's `name` and a content-free summary (optionally a numeric HTTP status, when the error carries one) — never the error's own message and never its stack. `span.setStatus`'s message is the same content-free summary. The error rethrown to the caller is the identical, untouched object in every case — no behaviour change for anything that catches a `chat()`/`chatWithTools()`/`chatWithToolLoop()` rejection.

## [0.33.0] — 2026-10-22

**Adds a USD-per-token price book (`createPriceBook`), exported from the package's main entry — cost telemetry needs USD, not just token counts.**

- **LiteLLM's live price list is the default; the bundled `PRICING_SNAPSHOT` is the fallback only until the first successful fetch** — used before the first live fetch ever succeeds; `refresh()` only ever assigns the table on success, so once a live fetch has succeeded once, a later failed refresh keeps that last good _live_ table rather than falling back to the snapshot again (unless the caller injects its own snapshot). The bundled snapshot is populated with real LiteLLM data (`asOf: '2026-10-22T12:59:18Z'`, raw upstream sha256 `91da1a98e194e0d7c436aaf970800c8e734d70cc78027cfe314d5b27dfaf9a4c`; 6 providers, 321 parsed entries), trimmed from LiteLLM's `model_prices_and_context_window.json` to the fields this module reads.
- **A bounded fetch timeout, and an overlap guard** — each refresh now aborts its fetch via `AbortController` after `fetchTimeoutMs` (default `DEFAULT_FETCH_TIMEOUT_MS`, 30 seconds; configurable), treating a timeout as a failed refresh exactly like a thrown fetch, a non-OK status, or invalid JSON: the last good table is kept and a warning is logged. A `refreshing` flag also stops a periodic tick from starting a second fetch while one is still in flight.
- **The 10x price-move circuit breaker compares live → live only** — a refresh where any price moved more than 10x in either direction (or crossed to/from exactly zero) against the previous _live_ table rejects the whole payload and keeps the current one.
- **The first move from the snapshot to a live table only warns, never rejects** — a snapshot is stale by construction, so the snapshot → first-live transition is accepted once it parses and validates, with a warning logged for every price that moved more than 10x against the snapshot it replaces.
- **`costOf(usage)`** prices input, output, cache-read, and cache-write (5m/1h) tokens each at their own rate; an unmatched model is `unpriced`, and partial/approximated pricing is marked `complete: false` rather than silently treated as exact or free.
- **Decision: two cost APIs, for now.** `createPriceBook` / `book.costOf(...)` is the successor: live-priced from LiteLLM, with the bundled snapshot as fallback, and an unknown model is always `unpriced`, never `0`. The old static-rates API — `estimateCostUSD`, `RatesTable`, `RateTuple`, `catalogEntryFor`, `uncoveredModels` — is kept and marked `@deprecated` rather than removed, so nothing breaks: all 5 provider adapters still call `estimateCostUSD`. A follow-up moves those adapters onto `PriceBook` and removes the old API in a later minor. Decided by the operator on 2026-10-22.

## [0.32.0] — 2026-10-22

**The `claude-cli` adapter now gets the same OTel GenAI CLIENT spans as the provider-SDK adapters — `chat()`, the held-session turn path (`chatOnSession`), and `chatWithToolLoop()` are all wrapped in `withGenAISpan`, using the same `gen_ai.*` attributes (`gen_ai.provider.name` = `anthropic`, request/response model, input/output token usage) and the same `verevoir.llm.*` cache attributes — closing the telemetry gap for v5's reviews, which run through claude-cli rather than a provider SDK.**

- **New `TokenUsage.costUsdReported`** (optional) — the CLI's own `total_cost_usd`, surfaced as-is and never computed; mirrored on the span as `verevoir.llm.cost_usd_reported`.
- **New `TokenUsage.sessionId`** (optional, claude-cli-only) plus a new span attribute `verevoir.llm.session_id` — the CLI's `session_id`, kept purely to correlate turns on a held session; it is _not_ used as `providerRequestId`, since it's shared across every turn of that session.
- **`providerRequestId` on claude-cli, now actually per-call:** the held-session paths (`chatOnSession`, and `chatWithToolLoop`'s session-backed branch) use the terminal result envelope's own `uuid` field, which is unique per turn — `undefined` when a turn's envelope doesn't carry one. The one-shot `chat()` path (a fresh CLI process per call) keeps `session_id`, which really is unique per call there.
- **The 5m/1h cache-creation split** (`cacheCreationEphemeral5mInputTokens` / `...1hInputTokens`) is now surfaced through claude-cli's own `usage.cache_creation` payload too, alongside Anthropic SDK's own split.

## [0.31.0] — 2026-10-21

**OpenTelemetry GenAI client spans — every provider-SDK call site (Anthropic, Google, OpenAI, DeepSeek, and the shared OpenAI-compatible factory behind Mistral/SambaNova) is now wrapped in an OTel CLIENT span named `chat {model}`.** Span attributes follow GenAI semantic conventions v1.37.0 (`gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`; `error.type` plus a recorded exception and `ERROR` status on failure) — defined as local string constants in the new `src/otel.ts` rather than imported from `@opentelemetry/semantic-conventions/incubating`, per OTel's own guidance for conventions still in Development status. Cache tokens and the provider's own request id aren't in GenAI semconv v1.37.0, so they're custom attributes, deliberately namespaced outside `gen_ai.*` under `verevoir.llm.*`: `cache_read_input_tokens`, `cache_creation_input_tokens`, `cache_creation.ephemeral_5m_input_tokens`, `cache_creation.ephemeral_1h_input_tokens`, and `provider_request_id`. `src/otel.ts` depends only on `@opentelemetry/api`, which no-ops until a consuming application installs an SDK + exporter — demonstrated by `otel.test.ts`'s "no SDK installed" case; a consuming application is where that SDK + exporter actually gets installed (ADR 046: `llm` is the only package that talks to a provider SDK, so it's the right place for the per-call span). No cost arithmetic yet — a price table is next.

- **New `TokenUsage` fields, all optional and `undefined` when a provider doesn't supply them:** `cacheCreationEphemeral5mInputTokens` and `cacheCreationEphemeral1hInputTokens` (only Anthropic's `chat()` currently reports the 5m/1h split, via its beta `usage.cache_creation` shape), and `providerRequestId` — the provider's own id for the call, set only on each adapter's `chat()` (not yet `chatWithTools`/`chatWithToolLoop`): Anthropic uses the message id (its streaming surface doesn't expose an HTTP `request-id` header), while OpenAI, DeepSeek and the OpenAI-compatible factory (Mistral/SambaNova) use the SDK response object's own `id` field. `undefined` on every path that doesn't yet wire it through, including Google (no documented equivalent field).
- **`@opentelemetry/api` is now a `peerDependency` (`^1.9.0`, optional like the provider SDKs) and a `devDependency`**, alongside the new `@opentelemetry/sdk-trace-base` devDependency used by `otel.test.ts`'s in-memory exporter. No cost to a consumer that never installs an OTel SDK: with none installed, `trace.getTracer()` returns the API's own no-op tracer, so every span created here costs nothing and changes no behaviour.

## [0.30.0] — 2026-10-18

**BREAKING: `ContentBlock` gains `image` and `document` members; `ToolExecutor` may now return `ContentBlock[]`, not only `string`.** A tool result or a user-turn message can now carry an inline-base64 `image` (`image/png` | `image/jpeg` | `image/gif` | `image/webp`) or `document` (`application/pdf`) block, mirroring Anthropic's own wire shape. `@verevoir/llm/anthropic` passes both through unchanged — in `tool_result.content` and in user-turn content alike — since its `ContentBlock` already mirrors the real Anthropic API shape. Every OTHER adapter (`/google`, `/openai`, `/openai-compat` and its consumers `/deepseek` + `/samba` + `/mistral`, `/claude-cli`) can only carry text: a non-text block reaching any of them now throws the new, named `UnsupportedContentBlockError` (`provider` + `blockType`) via the new `collapseContentToText(provider, content)` helper, instead of being silently dropped or stringified into an opaque object. A plain `string` `TurnContent`/`ToolExecutor` return behaves exactly as it did before this widening — nothing changes for an existing text-only consumer.

**Migration:** code that implements `ToolExecutor` and returns a `string` is unchanged. Code that CALLS one and treats the result as a `string` must now handle the `ContentBlock[]` case too.

**The refusal rule, by location.** A `ToolExecutor`'s own result reaching an adapter that cannot carry its block type (every adapter except Anthropic, for `image`/`document`) becomes a NAMED `is_error: true` tool_result — the thrown `UnsupportedContentBlockError`'s message (naming the provider and the block type) is what the model sees, and the tool loop continues. An unsupported block in a USER TURN the caller built directly still THROWS `UnsupportedContentBlockError` — that is caller error, not a tool failure the model should see and react to.

- `ContentBlock`'s existing `text` / `tool_use` / `tool_result` members are unchanged; `tool_result.content` widens from `string` to `string | ContentBlock[]`.
- `ToolExecutor`'s return type widens from `Promise<string>` to `Promise<string | ContentBlock[]>`.
- New exports from the core (`src/index.ts`): `UnsupportedContentBlockError` and `collapseContentToText(provider, content): string`.
- Consumers that type their own `ToolExecutor` as returning only `string` keep compiling and behaving identically — the widening is purely additive on the return type.

## [0.29.1] — 2026-10-06

**Fixed: `claudeCli.chat()` could crash the HOST process on an EPIPE, instead of rejecting normally (#289).** `runClaudeCli` wrote the prompt to the spawned `claude` process's stdin with no `child.stdin.on('error', ...)` listener of its own — only `child.on('error', ...)`, the whole-process spawn-level failure (e.g. ENOENT), was wired. `child.stdin` is its own stream/EventEmitter: if `claude` exits before ever reading stdin (e.g. an auth failure that exits non-zero immediately) and the written prompt is larger than the OS pipe buffer, the write raises EPIPE as an `'error'` event on that stream specifically. With zero listeners on it, Node throws — an uncaught exception that can bring down the host, not a normal rejection the caller could catch.

**The fix.** `child.stdin.on('error', () => {})` — deliberately swallowed, not forwarded to `reject` directly. The same process exit that broke the pipe also fires its own `'close'` event, which already carries the real exit code and whatever `stderr` the process wrote before exiting — exactly the "one clear failure carrying the exit code and stderr" this adapter already produces for an ordinary non-zero exit. Rejecting from the stdin `'error'` handler instead would race `close` and — observed directly while building this fix's own test — sometimes win that race, replacing the typed, informative "exited with code N: ..." failure with an opaque "write EPIPE" one.

**Proven deterministically, not by hoping for a real race.** The first version of this fix shipped with only a real-subprocess test (a PATH-stubbed `claude`, a >128KB prompt) as its regression proof. Review found that non-deterministic: on at least one real CI container, the identical scenario never raised EPIPE at all, so that test could not tell the fixed code from the broken code there — it passed either way. The actual proof is now a mock-based test (`chat.test.ts`, "stdin EPIPE when the process exits before reading it (#289, deterministic)") whose fake `stdin` is a real `EventEmitter`: it exercises Node's own no-listener-throws rule for an `'error'` event directly, with no dependency on OS pipe-buffer timing, and additionally asserts no uncaught exception is raised. Mutation-tested: removing the listener makes this test fail, deterministically, on every OS and Node version — confirmed directly, then restored. The original real-subprocess test is kept only as a best-effort smoke check, explicitly labelled as not the proof.

## [0.29.0] — 2026-10-06

**New: `@verevoir/llm/catalog` — the model catalogue, with no SDK import.**
Before this, a provider's catalogue entries were only ever registered as a
side effect of importing a real adapter subpath (`/anthropic`, `/mistral`,
`/samba`), each of which requires its SDK as a peer dependency — so a
consumer that only wants `resolveModelByTerm('opus')`, a label, or a rate
(never a real call) had to add an SDK dependency solely to trigger that
import side effect. `@anthropic-ai/sdk`, `openai` and `@google/genai` stayed
optional peers, but "optional" meant nothing once a consumer needed the data.

Each catalogued provider's `CATALOG` array now lives in its own
`<provider>/catalog.ts` — pure data, importing only the `ModelCatalogEntry`
TYPE, no SDK. `@verevoir/llm/catalog` imports those pure files and registers
all of them; importing it (plus the core package) resolves every known
family with zero SDK as a transitive dependency. `@verevoir/llm/anthropic`,
`/mistral` and `/samba` are UNCHANGED for an existing consumer — each still
imports its own `./catalog.js` and registers it itself (idempotent, so no
conflict if a consumer imports both this subpath and a real adapter).

MINOR, not patch: this adds new public exported surface (the `./catalog`
subpath, and `ANTHROPIC_CATALOG`/`MISTRAL_CATALOG`/`SAMBA_CATALOG`) — new
capability, not a behaviour change to anything existing.

Not touched: `/openai`, `/deepseek`, `/google` never used
`ModelCatalogEntry`/`registerModelCatalog` in the first place (they register
plain labels only), so they have nothing for this subpath to extract.
`/claude-cli` stays deliberately unregistered, per its own design.

## [0.28.0] — 2026-10-06

**Catalog: Anthropic's `opus` family currentId moves to `claude-opus-5-5`** — the
prior `currentId`, `claude-opus-5`, is kept as an alias (alongside the existing
`claude-opus-4-8` / `claude-opus-4-7`), so a transcript, ledger or stored cost
row naming any of the three still normalises, prices and labels correctly.
Driven by a real consumer (`aigency-governance`) switching its reviewer model
from a hand-pinned concrete id to this package's own `resolveModelByTerm`
registry, so its judge model tracks the catalog's current Opus rather than a
literal a maintainer has to remember to bump by hand. **Bumped MINOR, not
patch** — a currentId change alters exported behaviour (`models.reasoning`'s
literal value, the `rates` table key), and this project's own precedent treats
that shape of change as minor: commit `5b9e382` bumped 0.22.0 → 0.23.0 for the
identical kind of currentId move, and the 0.26.6 entry states the rule
directly — a patch is for internal surface with "zero change to any exported
behavior", which this is not.

## [0.27.1] — 2026-09-16

**Wave 4 of 5, the last wave of the split replacing the withdrawn `#55` — fixes the abort-listener-outlives-a-resolved-turn bug that every prior wave (`#57`, `#61`) disclosed and deliberately deferred.**

**The bug, precisely.** `session.ts`'s `runSessionTurn` registered its `AbortSignal` listener (`{ once: true }`) once per turn, but only ONE of the turn's four possible settlement paths (success via a `result` line, the per-turn watchdog firing, an abort firing, the process dying mid-turn) — the synchronous stdin-write-error path — ever removed it. A turn that resolved normally, or via the watchdog, left the listener ARMED against a session that might still be perfectly healthy. If the SAME `AbortSignal` fired again later — plausible for a caller reusing one `AbortController` across a request whose lifetime outlives a single turn — that stale listener fired `onAbort()` and killed an already-resolved, healthy session.

**The fix.** A single `teardown()` closure, stored on `PendingTurn` (not just local to `runSessionTurn`'s own promise executor), that clears the watchdog AND removes the abort listener — called from every settlement path: the success path (`handleStreamLine`), the watchdog, `onAbort` itself, process death (`wireSessionEvents`' `onGone`), and the stdin-write-error path. One teardown point every path calls, rather than four places each separately (and previously, inconsistently) remembering to. Idempotent, so call order between paths never matters.

**A review caught that this list was incomplete before this PR merged — recorded here rather than quietly fixed.** `killHeld` is a FIFTH path that can settle a pending turn, reached from OUTSIDE `runSessionTurn` entirely via three routes: `closeSession` (an exported public API a caller can invoke while a turn is in flight), `evictOverCapacity` (fires unconditionally on respawn once `HELD.size` exceeds `SESSION_MAX_HELD`, with no check for an in-flight turn), and the dead-session cleanup inside `getOrCreateSession`'s own spawn path. `killHeld` was still doing the OLD partial cleanup (`clearTimeout(pending.watchdog)` only) rather than calling `teardown()` at all — so all three of those routes leaked the listener exactly the same way, and the original version of this entry's own claim of covering "every settlement path" was false as written. **Fixed at its one call site** — `killHeld` now calls `pending.teardown()` too — rather than patching each of the three routes separately.

**Proven non-vacuous, same discipline as the mcp-bridge auth fix and wave 2b's tool-arming fix, for BOTH parts of this fix**: the original regression test (`session.test.ts`, `abortSignal` describe block) was run against a temporarily neutered `teardown()` and failed for exactly the claimed reason — `child.kill` was called once when it should never have been — then reverted. The `killHeld` follow-up fix was proven the same way, but by a stronger assertion than a kill-count (which can't distinguish "leaked" from "harmlessly re-killed an already-closed session"): two new tests (`closeSession` and eviction, each with a turn genuinely in flight) assert directly, via `node:events`' `getEventListeners`, that the abort listener is actually gone from the signal afterward. Neutering `killHeld`'s new `pending.teardown()` call (back to the old `clearTimeout(pending.watchdog)`-only cleanup) made both fail for exactly that reason — `getEventListeners` reporting the listener still attached — then reverted; `session.ts` is byte-identical to before that neuter except for the real fix.

**This was never a hypothetical bug.** It was found, precisely, by applying the operator's own indivisibility test to `session.ts`'s turn-execution core during the reviewability-split conversation — tracing all four settlement paths together, rather than any one in isolation, is what surfaced it. See the estate's record of that conversation for the full account.

## [0.27.0] — 2026-09-16

**Wave 3 of 5, replacing the withdrawn `#55` — `@verevoir/llm/claude-cli` gains `createSession`/`closeSession`, `chatWithToolLoop`, and `chatWithTools` on its public surface.** The first wave in this split that changes exported surface (hence minor, not patch) — everything up to this point (`mcp-bridge.ts` at 0.26.6, `env.ts` at 0.26.7, `session.ts` in two waves at 0.26.8/0.26.9) was a confirmed leaf with no caller on `main`. This wires those into `index.ts`:

- **`ClaudeCliSessionHandle`/`createSession`/`closeSession`/`PermissionDenial`/`SESSION_IDLE_TIMEOUT_MS`/`SESSION_MAX_HELD`/`SESSION_TURN_TIMEOUT_MS`/`resetClaudeCliSessionsForTests` are now re-exported from `@verevoir/llm/claude-cli` itself**, not just from `session.ts` internally.
- **`chat()` gains an optional `session` field** (`ClaudeCliChatOptions`). Supplying it runs one turn on the held session via `runSessionTurn` instead of a fresh spawn — `turns` must then carry only the ONE new message, never the full history again (the session already has it); omitting `session` leaves `chat()` exactly as it always was.
- **`chatWithTools()` REFUSES, unconditionally.** There is no point in this transport's design where a `tool_use` exists without already having been executed — a tool-bearing turn runs entirely inside one `claude` invocation via the embedded MCP bridge, which calls the caller's own executor itself. Use `chatWithToolLoop()` instead.
- **`chatWithToolLoop()` is new.** Unlike every other adapter's tool loop (several separate model calls, feeding each result back as the next request), this transport's "loop" happens INSIDE one `claude -p` turn, driven by `claude` itself through the MCP bridge — this function makes exactly one call to `runSessionTurn`. `maxIterations` (default 5, matching every other adapter) maps onto that turn's tool-call BUDGET rather than a call count; the returned `iterations` is an OBSERVED COUNT of `assistant` stream events (this transport's only available proxy), not a count of separate calls made. `options.session` omitted opens and closes a throwaway session for the one call, self-contained like every other adapter's; `options.session` supplied reuses it, carrying prompt-cache warmth and tool availability to the next call, under the same one-new-message-only restriction as `chat()`'s session branch. `permissionDenials` is surfaced as data on the result, never thrown — read it alongside `toolUses`, never alone (see `PermissionDenial`'s own doc comment).

**Reconstruction disclosure.** This wiring was reconstructed from the withdrawn `#55` branch via targeted greps of its surviving copy, not transplanted byte-for-byte — `#55`'s own branch history diverged too far from the pieces that landed independently (`mcp-bridge.ts`, `env.ts`, `session.ts`) for a mechanical rebase. Evidenced behaviourally, not assumed faithful: `chat.session.test.ts` is new coverage exercising every path added here against `session.ts`'s real (mocked-at-the-module-boundary) contract — the same pattern `chat.test.ts` uses for `node:child_process`.

## [0.26.9] — 2026-09-16

**Wave 2b of 5, on top of wave 2a's lifecycle (`0.26.8`) — the other half of the file review split `#57` into.** New (internal, no public behaviour change): `runSessionTurn` — arms the tool bridge, writes one turn's message, races a per-turn watchdog (`SESSION_TURN_TIMEOUT_MS`) against the terminal `result` event / an abort / the process dying, parses the confirmed envelope shape, and extracts permission denials (`PermissionDenial` — read alongside `toolUses`, never alone; an empty array can mean "nothing denied" or "nothing attempted").

**Still a confirmed leaf: nothing on `main` calls `runSessionTurn` yet** — wave 3 is what wires it (and `createSession`/`closeSession`) into `index.ts`'s public surface.

**KNOWN LIMITATION, disclosed and deliberately unfixed in this wave, same as on the withdrawn `#57`.** The abort listener is only explicitly removed on the synchronous stdin-write-error path — a turn that resolves via a normal result line or the watchdog leaves it armed against a session that may still be open, so a later `abort()` on a REUSED `AbortController` would incorrectly kill an already-healthy session. The fix, with its own regression test proving both the bug and the fix, lands as wave 4. Landing it here unfixed would re-mix an unrelated correctness fix into a feature wave — exactly the omnibus shape review rejected `#55` for in the first place.

**FIX, pre-merge: the tool-arming path had zero test coverage — a REJECT from review, correctly.** Every `runSessionTurn` test in the original draft of this wave passed `tools: []`, so the executor-required guard, `bridge.arm()`, and the real populated `toolUses`/`toolResults` return were never exercised — precisely the behaviour this wave's own title names ("arms the tool bridge"), and undisclosed as a deliberate gap unlike the abort-listener limitation above. Closed with one integration test that drives the REAL (unmocked) `createToolBridge` — the same one the wave 2a "concurrent first use" tests already rely on being real — sends a genuine `tools/call` over its actual loopback socket (the identical wire shape `mcp-bridge.test.ts`'s own `sendToolCall` exercises standalone), and asserts `runSessionTurn`'s returned `toolUses`/`toolResults` are genuinely populated from that call. Proven non-vacuous: the arming return was temporarily neutered to always report empty, the suite was run, exactly this one new test failed for exactly the expected reason (the executor still ran; the returned arrays stayed empty), then reverted.

## [0.26.8] — 2026-09-16

**Wave 2a of 5, replacing the withdrawn `#57`.** `#57` (originally "wave 2/4", `session.ts` in full — lifecycle AND turn execution, one file) was REJECTED by review on `pull-requests-carry-what-why-tests`: 1,799 changed lines, nearly double the practical reviewability ceiling, with no override recorded — and the file's own header, plus its own test file's `describe` blocks, already showed an unexercised seam the review named explicitly: lifecycle (`createSession`/`closeSession`/dead-handle/eviction-bounds) vs. turn execution (`runSessionTurn`/watchdog/abort/tool-arming). This PR is that seam, cut for real: the lifecycle half only. The turn-execution half (wave 2b) stacks on top of this.

**New (internal, no public behaviour change beyond wave 1): `claude-cli`'s session lifecycle — `createSession`/`closeSession`, the opaque `ClaudeCliSessionHandle`, dead-handle safety (a handle whose process died/was evicted/was never used starts fresh — the same shape as a 401), the two independent resource-policy bounds (`SESSION_IDLE_TIMEOUT_MS` measuring the gap between turns; `SESSION_MAX_HELD`, LRU-evicted), and `getOrCreateSession` — spawn-or-reuse, including the check-then-act concurrency fix a review already caught and proved on the withdrawn `#57` (two calls on the same fresh handle now share one spawn via a synchronous `INITIALIZING` reservation, never race two, never orphan a process).**

**A confirmed leaf, same pattern the MCP bridge landed in at `0.26.6`: nothing on `main` calls anything in this file yet.** `getOrCreateSession` is exported specifically so this wave's own test file can exercise the full spawn/reuse/dead-handle/eviction contract directly, standing in for the caller (wave 2b's `runSessionTurn`) that doesn't exist yet.

**Deliberately NOT in this wave**, per the review's own named split: the per-turn watchdog, abort handling, tool-bridge arming, terminal-envelope parsing, and permission-denial extraction — all genuinely turn-execution concerns, landing as wave 2b. The wire-shape verification history (three real operator-run probes) moves with them, since nothing in this wave depends on the streaming wire shape being right — it only spawns and tracks processes.

## [0.26.7] — 2026-09-16

**Internal-only refactor, no public behaviour or export change: `claude-cli`'s env allowlist (`ALLOWED_ENV_VARS`/`allowedEnv`/`CLAUDE_CLI_CREDENTIAL_ENV_VAR`) and the `PROVIDER` constant moved from `index.ts` into a new `env.ts`.** Every doc comment carried across verbatim; `index.ts` re-exports all four names under the exact same identifiers, so `@verevoir/llm/claude-cli`'s existing consumers (including this repo's own `chat.test.ts`, unchanged) see no difference.

**Wave 1 of 4, replacing the withdrawn omnibus `#55`.** `#55` (the full claude-cli session-holding transport in one 2,394-line pull request) was rejected by review under `pull-requests-carry-what-why-tests` — solid code, but an omnibus mixing a new feature with an unrelated bugfix, no split attempted. This is the first of the four waves the review's own findings named: **(1) this env.ts extraction, (2) the session core (`session.ts`), (3) the `index.ts` wiring that makes `createSession`/`closeSession`/`chatWithToolLoop`/`chatWithTools` genuinely reachable, (4) a standalone abort-listener-leak fix** (previously `#53`, folded into `#55` by mistake — see wave 4's own entry). Each wave stands alone and the next is built on top, the same shape the embedded MCP bridge landed in at `0.26.6`.

**Why this one is first, and why it is safe on its own.** The upcoming session-holding transport (`session.ts`, wave 2) needs to build the identical child environment `chat()`'s single-shot path already builds, without `session.ts` and `index.ts` importing each other (`index.ts` will wire the session API against `session.ts`; `session.ts` reaching back into `index.ts` for this would be a cycle). Extracting the allowlist first, on its own, with zero behavioural change, means nothing else has to move around it later. Reviewable in isolation: one file added, one file's exports replaced with an identical-shaped re-export, nothing else touched.

## [0.26.6] — 2026-09-16

**New (internal, no public behavior change): the embedded MCP tool bridge for `claude-cli`'s session-holding transport (`src/claude-cli/mcp-bridge.ts`).** Split out of `#45` (the session-holding transport for `claude-cli` tool calling + prompt-cache parity) as its own pull request, on the reasoning that the security-critical part of that change — an authenticated loopback TCP bridge driving a caller's own `ToolExecutor` — is small (roughly 68 logic lines) and deserves to be read on its own rather than lost inside several thousand changed lines. Landed **authenticated from its first commit**: a random per-bridge shared secret is generated in `createToolBridge`, delivered to the generated MCP shim via its spawn `env` (a channel that touches neither the loopback port nor the shim script itself), checked with a constant-time comparison before anything else in the bridge's request handler runs, and an unauthenticated or mismatched call is refused with an explicit `{ refused: true }` response (logged loudly) rather than silently dropped. See the file's own header for the full reasoning, including why loopback binding alone is defense in depth rather than the control itself, and why `--disallowedTools "*"` reliably blocking built-ins but not MCP-declared tools is a confirmed CLI quirk this bridge deliberately depends on.

**What depends on this, and what does not.** This module is a confirmed leaf: its only imports are Node built-ins (`node:net`, `node:crypto`, `node:fs/promises`, `node:os`, `node:path`) plus a type-only import of `ToolDef`/`ToolExecutor`/`ToolUse` from this package's own top-level `index.ts` — types that already exist on `main`. It imports nothing from `claude-cli/session.ts`. **Nothing on `main` calls `createToolBridge` yet** — `claude-cli/index.ts`'s public surface is unchanged by this pull request, and the module has no caller until `#45`'s session-holding transport (`session.ts`, which imports `createToolBridge` and owns spawning the `claude` process this bridge's `--mcp-config` is handed to) lands on top of it. That is a deliberate, disclosed ordering, not an oversight: `session.ts` is the caller whose review needs this piece already settled, not the other way around. This is why the change is a patch version — it adds unreferenced internal surface with zero change to any exported behavior — not a minor.

**Reproduction re-established, not merely relayed, before the fix was written.** The vulnerability this authentication closes was proven, first-party, using the module's own pre-existing test file: `mcp-bridge.test.ts`'s `sendToolCall()` helper — a bare `net.createConnection`, never touching the generated shim at all — already drove the executor with no token and no origin check, and passed, before this fix existed. Non-vacuousness of the fix was proven the same way: the authentication check was temporarily neutered, the suite was run, three tests failed for exactly the expected reason (the executor ran when it should have been refused; the refusal response was absent), then the neutering was reverted as its own commit.

## [0.26.5] — 2026-09-15

**Fix: `pair.ts`'s `consult()` bare-joined the advisor's question and context with no delimiter.** The advisor's user turn was built as `${question}\n\n${context}` — two model-supplied strings joined with no marker of where one ends and the other begins, on a path reachable by every `withAdvisor` caller. Fixed via a new `buildConsultMessage()`, following `src/claude-cli/index.ts`'s existing `joinTurns()` shape (role-labelled `## question` / `## context` sections) rather than inventing a second scheme; no context supplied leaves the bare-question behaviour unchanged. Stated plainly, not just fixed silently: this delimiter is **not a security boundary** — a crafted `context` containing the literal text `"\n\n## question\n"` can still forge a second section once it reaches the advisor, and a dedicated test proves that limitation rather than hiding it. Tool-output feed-back on any route remains a separate, undecided policy question, untouched here.

## [0.26.4] — 2026-09-15

**Fix: `/google`'s tool-call id fallback collided on parallel or repeated same-name calls.** `chatWithTools`/`chatWithToolLoop` built each `ToolUse.id` as `f.id ?? f.name` — Gemini's `FunctionCall.id` is genuinely optional on the wire (populated on some calls, absent on others, which is why the `f.id ??` fallback exists at all), but the fallback value itself was wrong. Two parallel calls to the same tool name in one turn, both missing an id, both fell back to the identical `f.name` — every other route (Anthropic's `block.id`, the OpenAI-compatible path's `tc.id`) carries the provider's real per-call id and never collides this way. Fixed by `fallbackToolCallId(name, scope, indexInCall)`: `scope` is `chatWithToolLoop`'s own `iteration` counter (strictly increasing across the loop's lifetime) or `0` for `chatWithTools`' single call, `indexInCall` is the call's position within that one response — stable, distinct within a response, and distinct across a loop's iterations, closing both the single-response collision and the cross-iteration collision an antagonistic review caught in an earlier draft of this fix. The wire-level `functionResponse.id` sent back to Gemini is untouched (`fc.id` raw, `undefined` when Gemini didn't supply one) — that id is Gemini's own correlation mechanism, not ours to synthesise onto the wire. `src/google` only; no shared code touched.

## [0.26.3] — 2026-09-14

**SECURITY: `claude-cli`'s `--tools ""` never disabled tool use — every published version from 0.25.0 through 0.26.2 shipped this, and the file header's own claim ("disabling tool use substrate-wide") was false the entire time.** Confirmed directly against the CLI (the operator ran it, relayed the answer): `--tools` takes a space-separated allowlist of tool names, and an empty string is read as **not set** — not as an empty allowlist — so every call silently fell through to the CLI's own default built-in tool set. This is the exact property the package's "no-bypass" architecture rests on (a model reads files through the caller's own tool belt, never directly) and the published package never actually had it. There is no evidence of exploitation; this is a defect in the adapter's own promised contract, found via direct verification of a real invocation, not an incident report.

- **Fixed: `--disallowedTools "*"` replaces `--tools ""`.** Confirmed to remove a bare-named tool from context entirely ("absent", the failure shape used everywhere else in this codebase) rather than merely denying a call to it. `--allowedTools` was considered and rejected — confirmed **additive** on top of the CLI's own default safe-list ("runs without prompting"), not a restriction; grepped, not used anywhere in this codebase, so this is not a second silent fail-open.
- **New: tool-safety verification against the CLI's own `init` event, not trust in the flag.** `chat()` now speaks `stream-json` on both stdin and stdout (a wire shape this package has separately, directly confirmed works for a single-shot exchange) specifically so it can read the `{"type":"system","subtype":"init",...}` event's `tools` array — the only authoritative, checkable answer to what a run actually has. A non-empty array, or no init event found at all, **refuses the call** rather than returning a reply that may have used undeclared capabilities. This is the mechanism that would have caught the `--tools ""` defect on day one instead of it shipping silently for three minor versions, and it now guards every future flag change the same way.
- **The terminal result event's own shape is unchanged** — field-for-field identical to the previous `--output-format json` envelope; only the framing (one line among several, not the sole stdout payload) is new. `is_error`, never `subtype`, remains the only failure signal read (a real envelope carried `subtype: "success"` alongside `is_error: true`).
- **Deliberately out of scope: MCP-server loading under `--safe-mode`.** A separate, still-unconfirmed question (this adapter never passes `--mcp-config` at all, so it does not arise for `chat()`'s single-shot path regardless) — fixed and verified independently rather than bundled with this change, which is exactly what nearly let the `--tools ""` defect escape a second time.

## [0.26.2] — 2026-09-09

**`claude-cli`: recover the failure reason from stdout on a non-zero exit** (#43). `claude -p`'s commonest real failure — not logged in — exits 1 with **empty** `stderr`; the actual reason (`"Not logged in · Please run /login"`) lived only in `stdout`'s own `--output-format json` envelope, in `result`, typically alongside `is_error: true`. The non-zero-exit branch never read `stdout` at all, so this surfaced as the content-free `"claude -p exited with code 1"` and the real reason was silently dropped. A new `describeNonZeroExitReason()` parses `stdout` as the JSON envelope and prefers its `result` field; falls back to raw `stdout` when it doesn't parse as JSON or carries no `result`; appends `stderr` only when it says something the recovered text didn't already say. The separate spawn-level-failure message (`"claudeCli.chat(): could not run the claude CLI — …"`, thrown only when the `claude` process itself never starts) is untouched — confirmed byte-identical against `0.26.0` — since `aigency-harness` #99 prefix-matches it to split `unreachable` from `refused`.

**Also carries the devDependency refresh** (#41): `vitest` → 4.1.11, `typescript` → 5.9.3, `@google/genai` → 2.21.0, `openai` → 6.49.0, `prettier` → 3.9.6, `@types/node` → 25.9.5 (all devDependencies; no runtime `dependencies` change). `npm audit` clean before and after.

**Why this is `0.26.2`, not `0.26.1`:** `0.26.1` was already published to npm from a separate tree carrying only the dependency refresh, before the behaviour fix above had merged to `main` — so `0.26.1` on the registry does **not** contain this fix, even though `main`'s `package.json` briefly read `0.26.1` for the same reason (inherited, untouched, from the dependency-refresh branch this fix was built on top of, per the deliberate combined-release sequencing described in #43). `0.26.1` cannot be republished with different contents; this release is the first to carry both changes together under a version npm will accept.

## [0.26.0] — 2026-09-02

**Three additive changes, driven by a real consumer (`aigency-governance`) trying to route its review panel through this package instead of a hand-rolled HTTP client, and finding each of the three genuinely missing rather than merely inconvenient.**

- **New `ChatOptions.maxTokens`** — an optional per-call output-token ceiling override, honoured on every Anthropic adapter call site (`chat`, `chatWithTools`, `chatWithToolLoop`, including the tool-loop's no-tools finalise call). Previously the Anthropic adapter's `MAX_TOKENS` was an unconditional constant (16384) with no override — exactly the ceiling `aigency-governance`'s own `settings.ts` had already raised to 65536 on direct evidence (a real diff that truncated four of five review lenses) and could not express through this package at all. `undefined` behaves exactly as before. `@verevoir/llm/claude-cli` accepts and silently ignores this field — there is no confirmed `claude -p` flag for an output-token ceiling, disclosed in that adapter's own file header rather than left for a caller to discover by the field quietly doing nothing.
- **New `ChatOptions.model`** — an optional exact model id that wins over `modelClass` resolution entirely, on both the Anthropic API adapter and `@verevoir/llm/claude-cli` (sent as `--model <id>`). `modelClass` stays the default, class-based path for every existing caller — decisions still key on provider/family, and this changes nothing for a caller that never sets `model`. `model` is a narrow, deliberate escape hatch for a caller that needs the SAME model answering across two different transports of one provider — e.g. a governance review that judges one commit through the direct API and through `claude -p` and treats disagreement between the two as a signal. Without it, `modelClass` alone cannot guarantee that: the API adapter resolves a class to whatever its own catalog currently maps it to, while `claude-cli` — deliberately never registered into the shared catalog — resolves nothing and falls to whatever the local install defaults to. `--model` on the CLI side is relayed from Claude Code's own `--help` (a class alias or a full model id), not independently re-verified against a live invocation the way this adapter's payload shape was confirmed in 0.25.0 — stated as such in the file header, in the same "relayed, not confirmed" spirit as that release's Bedrock/Vertex strips.
- **`claude-cli`: `--strict-mcp-config` plus an explicit, isolated `cwd` on every spawn (including the `--version` fallback).** Defense-in-depth alongside `--safe-mode`'s own documented suppression of CLAUDE.md/skills/plugins/hooks/MCP servers/custom commands (0.25.0) — not a claim that `--safe-mode` was proven insufficient, since this repository has not independently re-confirmed that suppression by direct observation. `--strict-mcp-config` means no MCP server from any configuration source reaches the call regardless (only a server passed via an explicit `--mcp-config` flag would, and this adapter never passes one). The spawn's `cwd` is now `os.tmpdir()` rather than inherited from the calling process's own working directory — a project's `CLAUDE.md` / `.mcp.json` live relative to cwd, and a governance review's cwd is typically the very repository being reviewed, which is exactly the content this call must not see.

## [0.25.0] — 2026-08-25

**New `@verevoir/llm/claude-cli` — the Claude Code CLI (`claude -p`) as a `chat()`-shaped provider, for callers that must run on a subscription credential rather than a billed API key.** The Anthropic Messages API only accepts a subscription OAuth token for requests that present themselves as Claude Code (see 0.21.0's `oauthSystemIdentity()`); imitating that client to the raw API was ruled out as a route for a caller that isn't actually Claude Code. This adapter instead shells out to the real thing — `claude -p` — and lets it authenticate itself.

- **Provider id is `'claude-cli'`, deliberately distinct from `'anthropic'`**, so `TokenUsage.provider` unambiguously tells a caller which substrate served a call. **Never registered into the shared model catalog or connection registry** — `resolveModel` / `resolveModelByTerm` must never be able to silently substitute this for the real API adapter; a caller wanting this substrate imports and calls it directly.
- **Refuses rather than substitutes, by construction, not by configuration.** The child process's environment is built from an **allowlist** — only `PATH`, `HOME`, `TMPDIR`, and the one credential this adapter uses (`CLAUDE_CODE_OAUTH_TOKEN`) are ever copied into the spawned `claude` process; nothing else the caller's environment carries reaches the child, billed credential or not. This replaced an earlier denylist that named and stripped five specific vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_FILE`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`) while passing everything else in the parent env through unchanged. The gap that motivated the switch was concrete, not hypothetical: an earlier version of that denylist had already missed `ANTHROPIC_AUTH_TOKEN` itself — a live credential vector this package's own `anthropic/client.ts` already defends against for the same provider — caught only by a later review. A denylist can only ever exclude names someone thought to name; an allowlist doesn't need to be exhaustive about threats to be complete about permissions. `route` is reported as the constant `'subscription-oauth'` — a deliberate design choice given this adapter has no fallback ladder, not a claim that every billed-credential path is provably closed. A non-zero exit throws; it never retries against a different credential. A caller-supplied `apiKey` is refused outright rather than silently ignored.
- **Correction, same day — a review found the env-stripping list incomplete and the file header overstating what stripping it guaranteed** ("nothing to fall back to", "no other route this call could have taken"). Both are fixed: the header now states what is actually defended against versus relayed, not an absolute the code cannot prove. `llms.txt` was also found undocumenting this subpath entirely, and the two bullets below were found stale relative to this same commit's own payload-verification work — all three are the same failure `decisions/025` (`verevoir/aigency-rebuild`) already names: a written record going stale while the code moved past it.
- **Flags, and why**: `--system-prompt` (replaces, never appends — distinct from `--append-system-prompt`); `--tools ""` (a positive, checkable declaration that this call had zero tool access, not an assumption resting on the CLI's default); `--output-format json`; `--no-session-persistence`; `--safe-mode` — **not `--bare`**, whose own `--help` states Anthropic auth under it is strictly `ANTHROPIC_API_KEY`/`apiKeyHelper` (OAuth and keychain never read), which would either fail with no key or spend the purchased one; `--safe-mode` gives the same determinism (CLAUDE.md/skills/plugins/hooks/MCP servers/custom commands disabled) while leaving auth, model selection, built-in tools and permissions working normally. **`--json-schema` was considered and rejected**: it could enforce the reply contract structurally, but the Messages-API path has no equivalent, and adopting it here would mean the two substrates run different contracts — exactly what a cross-substrate comparison must not do silently.
- **`chat()` only** for this first cut — no `chatWithTools()` / `chatWithToolLoop()`. `/google` shipped the same way at its own v0.4.0 release (chat() only), then added `chatWithTools()`/`chatWithToolLoop()` in 0.13.0 (see that entry below) — cited here as historical precedent for a first cut, not as `/google`'s current state, which already has both. `--tools ""` makes a tool loop moot for this adapter's purpose anyway.
- **New `TokenUsage.substrateVersion` (optional, core field)** — the same field family as `route`, one level down: `route` answers which credential mechanism served a call, `substrateVersion` answers which VERSION of that mechanism did. Flags and auth behaviour can shift between `claude` CLI releases (`--bare`'s own auth behaviour is exactly the kind of thing that could change, and it's the difference between a subscription call and spending purchased credits), so a run whose substrate version isn't recorded can't be attributed later if behaviour changes after an upgrade. `undefined` for every direct API adapter (Anthropic, Google, OpenAI-compatible) — there the wire protocol is this package's own responsibility. **This entry originally said the adapter checked the `--output-format json` payload for a version field first, falling back to a `claude --version` spawn — stale as of this same commit:** the confirmed real payload carries no version field at all, so that speculative check was removed; `resolveCliVersion()`'s memoized `claude --version` spawn is the ONLY source of `substrateVersion`, confirmed necessary rather than a fallback for a payload path that turned out not to exist. Memoized for the process's lifetime so it never re-spawns per call — the version cannot change mid-run. This is also what makes a controlled CLI-upgrade measurement possible: same corpus, same lenses, one version bump, does the finding text change — that comparison needs every run to carry the version it was made under, or before/after are indistinguishable in the record. The operator is deliberately holding the installed CLI at `2.1.243` until the round trip below is proven, one variable at a time.
- **The `--output-format json` envelope shape is now confirmed against a real invocation** — the operator ran `claude -p ... --output-format json` and relayed the raw payload, correcting several things this entry originally called unverified guesses: the reply text is a flat `result` string (not `content`/`text`); a single call can invoke more than one model; `is_error: true` can appear alongside a zero exit code; there is no version field in the payload at all. What remains genuinely open, not merely relayed: whether a `--model` flag exists to pin a concrete model id, and whether `--safe-mode` genuinely blocks every billed-credential path the CLI might otherwise take — see this change's PR body and the file header's own "What is NOT yet verified" section. The reply-extraction path still falls back to raw stdout and warns, rather than silently guessing, when a payload's shape isn't recognised — unchanged, and still the right behaviour for a shape this confirmation doesn't cover.
- **`abortSignal` is honoured at entry AND mid-call, not just the entry check.** A review found `chat()` never referenced `options.abortSignal` at all — an abort mid-call did nothing and the spawned `claude` process ran to completion regardless, unlike every sibling adapter's `throwIfAborted`-at-entry contract. Fixed on both halves: `chat()` now calls `throwIfAborted` at entry like the rest of the package, and the spawn itself is now abort-aware — an abort while the child is still running kills it (`child.kill()`) and rejects immediately with the signal's own reason, rather than leaving the subprocess to finish in the background after the caller has already been told the call failed. The memoized `claude --version` lookup deliberately stays unwired to any one call's signal, since it's shared process-wide.
- **`options.onProgress` is accepted, never invoked — disclosed here rather than left for a reader to discover by its silence.** Every adapter's shared `ChatOptions` carries `onProgress`, and `anthropic/index.ts` implements it by auto-injecting a `report_progress` tool the model can call mid-turn; that mechanism cannot exist on this adapter, since `--tools ""` disables every tool it could reach. Independently, `--output-format json` delivers one envelope at process exit, not an incremental stream, so there is no partial signal to narrate from even if a tool mechanism existed. Both are structural to this adapter's design as shipped, not gaps left for a later release — a caller supplying `onProgress` will never see it called, and nothing here throws for supplying it.

## [0.24.0] — 2026-08-25

**`TokenUsage` reports which credential mechanism actually served a call — a new, POSITIVE `route` field, never left to be inferred from what is absent.** Before this, the Anthropic adapter's `resolveClient` already computed whether a given call authenticated with the subscription token (`CLAUDE_CODE_OAUTH_TOKEN`) or the metered `ANTHROPIC_API_KEY` — that fact was used to shape the request, then discarded before `TokenUsage` was built. A caller inspecting `TokenUsage.provider === 'anthropic'` after a successful call learned nothing about which credential authenticated it; `isProviderConfigured` (0.21.1) deliberately makes the two credentials indistinguishable for the _configured?_ check (correctly — a provider is usable either way), which left no other signal reporting which one actually ran. That absence is a real gap for a caller that needs to confirm its choice of credential was honoured — e.g. a policy of "only ever spend the subscription, never the metered key" cannot be audited from `TokenUsage` alone, and a silent internal fallback (the existing 401→API-key fallback is exactly this, done loudly on purpose) has no per-call trace once it has happened.

- **New exported `CredentialRoute = 'api-key' | 'subscription-oauth' | 'mixed'`.** `TokenUsage.route` is now required — every adapter sets it, positively, never omitted.
- **Anthropic adapter**: `route` is `'subscription-oauth'` or `'api-key'`, read from the exact point `resolveClient`/the 401-fallback path already knows the answer — no new resolution logic, just no longer discarding it. `chatWithToolLoop` and `chat`'s progress-continuation loop aggregate usage across several underlying calls that could, in principle, use different routes (a mid-session 401 fallback partway through); the aggregated `usage.route` reports `'mixed'` when the underlying calls disagreed, rather than picking one and hiding the other.
- **Google adapter + the OpenAI-compatible factory** (`/openai`, `/deepseek`, `/samba`, `/mistral`): `route` is always `'api-key'` — each has exactly one credential mechanism, so this is a constant, not a computed value.
- No behaviour change: this is additive, reporting-only. `isProviderConfigured` / `altKeyEnvs` are untouched — the configured-check and the after-the-fact report are deliberately kept separate.
- Not addressed here (a distinct, out-of-scope design question): a dual-cost figure (billed vs. notional USD) for a subscription call. `route` is the input a caller would need for that; pricing a subscription call at $0 while separately reporting what it would have cost needs its own rate-lookup design, not a consequence of this field.

## [0.21.1] — 2026-07-26

**The OAuth token now COUNTS as a configured Anthropic credential** — closing the half of the 0.21.0 subscription work that made it unusable on its own. 0.21.0 taught the **call path** to prefer `CLAUDE_CODE_OAUTH_TOKEN`, but the **credential check** still looked only at `apiKeyEnv`: `isProviderConfigured('anthropic')` returned `false` when the subscription token was the only credential set, so routing refused to pick a provider whose every call would have succeeded. Callers saw "no reasoning tier configured" and had to set a dummy `ANTHROPIC_API_KEY` purely to satisfy a check that was looking at the wrong variable. `ProviderConnection` gains an optional **`altKeyEnvs`** — additional env vars whose presence also makes a provider usable — `isProviderConfigured` consults them (blank/whitespace values don't count), and the Anthropic adapter declares `altKeyEnvs: ['CLAUDE_CODE_OAUTH_TOKEN']`. The rule this encodes: **the credential check must recognise every credential the call path accepts**, or the two disagree and the caller is told to set a key they don't need. No change for API-key-only setups, and no other adapter declares alt keys.

## [0.21.0] — 2026-07-25

**Anthropic subscription OAuth — stop paying the metered API key for local review.** The Anthropic adapter now prefers `CLAUDE_CODE_OAUTH_TOKEN` (a Claude subscription token from `claude setup-token`) over `ANTHROPIC_API_KEY`, so governed reasoning-tier calls made locally — the antagonistic reviewer, the advisor, the pre-gate panel — bill the **subscription** rather than the metered key. Credential precedence: an explicit per-call `apiKey` (BYOK) → `CLAUDE_CODE_OAUTH_TOKEN` → `ANTHROPIC_API_KEY` (the fallback, used only when not already authenticated on the subscription). The subscription token is sent as a bearer `authToken` with the `anthropic-beta` flag Anthropic requires and a Claude-Code identity as the first system block (the token is authorised only for Claude-Code-shaped requests); both are sent automatically and are overridable via `ANTHROPIC_OAUTH_BETA` / `ANTHROPIC_OAUTH_SYSTEM` should Anthropic revise them. **Load-bearing detail:** the OAuth client is constructed with `apiKey: null` so the SDK does **not** auto-read `ANTHROPIC_API_KEY` from the environment and send an `x-api-key` header beside the bearer token — which would authenticate (and bill) the metered key anyway, defeating the point. `resolveAnthropicAuth` is exported and unit-tested for the precedence; no behaviour change when only `ANTHROPIC_API_KEY` is set. **Resilient by design:** because the OAuth path leans on undocumented headers + an identity gate Anthropic can change, a **401 falls back to the metered key once, session-wide — but LOUDLY** (a one-time stderr warning that spend has moved onto `ANTHROPIC_API_KEY`), never silently resuming the cost the OAuth path exists to avoid; the fallback request is rebuilt for the key path (no identity block), and fires only for ambient OAuth (not a per-call BYOK key) when a metered key is available. The token/key is never logged (secret-handling).

**Dependency hygiene:** pinned `postcss` to `^8.5.18` via `overrides` to clear GHSA-r28c-9q8g-f849 (high — path-traversal in source-map auto-loading). postcss reaches the tree only through the dev toolchain (`vitest → vite`); llm ships no CSS and never runs postcss at runtime, so there was no runtime or published-artefact exposure — but `npm audit` is now clean (0 vulnerabilities).

## [0.20.3] — 2026-07-23

**Correct the Opus rate — every cost this package reported was 3× high** (STDIO-528). The Anthropic catalog priced `claude-opus-4-8` at `[15, 75]` per MTok — Opus-3 era pricing — against a published `[5, 25]`. Because Opus is the **reasoning tier** (the antagonistic reviewer, the advisor in the generator pair, the gate), it sits on the expensive side of every governed call, so the stale tuple scaled every `estimateCostUSD` result, every consumer's meter footer, and every spend decision taken on them. Measured against a real 7-file session (999 deduplicated usage records): the stale rate reported **$893.18** where the published rates give **$297.73**, matching an independent hand calculation of **$296.69** on the same data. Sonnet `[3, 15]` and Haiku `[1, 5]` verified correct and unchanged. The catalog test previously asserted only that a rate _existed_ and was numeric — which is exactly how a 3× error survives indefinitely — so the published tuples are now **pinned by value**: a pricing change breaks the build instead of silently rescaling every number downstream. Consumers should re-baseline any stored cost figures; nothing about token counts changed, only their conversion to USD.

## [0.20.2] — 2026-07-21

**Finalise the tool loop on cap-hit** (STDIO-594). When `chatWithToolLoop` reached its iteration cap mid-loop it returned `text: ''` — a silent empty result the caller had to treat as failure (e.g. a review lens that ran out of iterations produced no verdict at all). On hitting the cap the loop now makes one final model call **with no tools**, forcing the model to synthesise its answer from the work so far, and falls back to the previous empty-text behaviour only if that finalise call itself fails. Applied across all three adapter families — the Anthropic native path, the OpenAI-compatible factory (covering `/openai`, `/samba`, `/mistral`, `/deepseek`), and `/google` — each wrapped so a finalise failure degrades gracefully rather than throwing.

## [0.20.1] — 2026-07-15

**Fix ESM resolution of the audit-hook export** (STDIO-573). 0.18.0–0.20.0 shipped `dist/index.js` re-exporting from `'./audit-hook'` without the `.js` extension, which native ESM refuses to resolve — so any consumer importing `@verevoir/llm` under plain Node crashed with `ERR_MODULE_NOT_FOUND` (the package's own vitest suite resolved it via Vite and never saw the break). Extension added (and on `audit-hook.ts`'s type-only import of `./index`, for `.d.ts` consistency); `prepublishOnly` now runs `scripts/check-dist-esm.mjs` after `build`, importing every built `exports` entrypoint under Node's own resolver, so an unresolvable entrypoint fails the publish instead of escaping to npm.

## [0.20.0] — 2026-07-15

**Advisor-pair primitive** (STDIO-574). New core `withAdvisor(tools, executor, advisor)` — the "pair" runtime: a cheap executor model runs a tool loop carrying a `consult_advisor` tool; when it calls it, a stronger advisor model answers. The advisor **guides, it never certifies** — its reply returns as an ordinary tool result. Core stays SDK-free: the advisor is dependency-injected as a `chat` function (`AdvisorConfig`), so a caller binds any adapter's `chat`. Returns a new tools array (input never mutated; a consult-name collision throws at wrap time) plus a wrapped executor that routes consults to the advisor at `modelClass: 'reasoning'` and passes every other tool call through untouched. A failing advisor yields a legible "advisor unavailable" tool result instead of a throw, so a dead advisor never kills the work; a missing or empty question returns a legible ask-again result without calling the advisor. Optional fail-soft `onConsult` hook (`ConsultInfo`: question/context/answer/usage) for consult-rate metrics; span emission stays with each side's own adapter, so `setModelSpanSink` sees both halves of the pair.

## [0.19.0] — 2026-07-15

**Model-span emission parity across every adapter** (STDIO-574). 0.18.0 wired the model-span hook only at the Anthropic adapter, so a consumer auditing via `setModelSpanSink` missed every non-Anthropic call. The emit-then-`onUsage` choke point is now a shared **exported `fireUsageHook`** on the core (`emitModelSpan` first — independent of the caller's `onUsage` — then the fail-soft hook), and every usage-firing site routes through it: the OpenAI-compatible factory (covering `/samba` + `/mistral`, with the scope built from the config's provider name), `/google`, `/openai`, and `/deepseek` — replacing four near-identical local helpers. Spans fire once per underlying model call — one per iteration in tool loops — with scope `<provider>.<entry>` (e.g. `samba.chatWithToolLoop`). Per-adapter sink tests cover every emitting path, including fail-soft through a real tool loop; README + llms.txt now document the sink and its coverage.

## [0.18.0] — 2026-06-30

**Add an optional model-span hook** (STDIO-500). `setModelSpanSink` / `emitModelSpan` let a consumer record **every** model call as a span — not only the delegated ones — closing the audit gap where an inline coordinator burned the reasoning tier invisibly (the 494 failure mode). Fail-soft and **off by default** (a no-op unless a sink is registered, never throws); wired at the anthropic adapter's `fireUsageHook` choke point so `chat` / `chatWithTools` / `chatWithToolLoop` all emit, independent of the caller's `onUsage`. `@verevoir/llm` stays audit-agnostic — it hands a plain `ModelSpan` (a `TokenUsage` + `scope`) to whoever registers; the `@verevoir/mcp` audit and aigency-web executor become the sink. Other provider adapters to follow.

## [0.17.0] — 2026-06-28

**Fix cached-token double-count in `shapeUsage`** (STDIO-487). The OpenAI-compatible chat and tool-calling paths set `inputTokens` to the provider's full `prompt_tokens` — which **includes** cached tokens — while also reporting the cached subset as `cacheReadInputTokens`, so downstream pricing billed cached tokens twice (the ~80% metering overshoot). `inputTokens` is now `max(0, prompt_tokens − cached)`, mirroring the convention already in mcp's local `usageFromResponse`. Unblocks accurate `verbose` audit-log costs in `@verevoir/mcp`.

## [0.16.0] — 2026-06-28

**Cap HTTP client retries at 3** (STDIO-412). Every adapter's `RETRY_BACKOFFS_MS` ladder is trimmed to `[5s, 30s, 120s]` (~2 min total) from the previous five-step ladder that ran out to ~15 min. Bounded retries keep transient-failure recovery from ballooning latency under an outer retrier — consistent with the resilience practice of retrying at a single layer.

## [0.15.0] — 2026-06-17

**Resolve a model by family to a usable connection** (STDIO-378). `resolveModelByTerm(term, opts)` resolves a loose human term (`"deepseek"`) or an exact family/id to a catalog entry across providers — exact match wins over a substring, then `prefer` / cheapest / newest, configured-only by default. `modelConnection(term, opts)` goes further: it returns a ready OpenAI-compatible connection — `{ provider, modelId, baseUrl, apiKey }` — by reading the resolved provider's registered endpoint (`defaultBaseUrl`, overridable via `<PROVIDER>_BASE_URL`) and key from env. So a config can name a model **by family** and bind it to a real endpoint + current version at resolve time. `ProviderConnection` gains `defaultBaseUrl` (set for the OpenAI-compatible providers; omitted for SDK-only Anthropic/Gemini, which return no connection — a raw OpenAI-compatible caller can't drive them). The registry foundation for naming models by family in consumers (the mcp delegate worker, per-tier model slots).

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
