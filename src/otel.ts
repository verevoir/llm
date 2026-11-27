/**
 * @verevoir/llm — OpenTelemetry GenAI client spans.
 *
 * One CLIENT span per provider call, named `chat {model}`, carrying the
 * OpenTelemetry Semantic Conventions for Generative AI attributes this file
 * defines as local string constants — NOT imported from
 * `@opentelemetry/semantic-conventions/incubating`. Per OTel's own guidance
 * for conventions still in the Development state, an instrumentation
 * library pins the attribute *names* it needs locally rather than taking a
 * dependency on an incubating entry point whose shape is still moving
 * (https://opentelemetry.io/docs/specs/semconv/general/attribute-naming/).
 *
 * Followed: OpenTelemetry Semantic Conventions for Generative AI, in their
 * own repository `open-telemetry/semantic-conventions-genai`, tag `v0.1.0`
 * (status: Development; it lists its changes since
 * `open-telemetry/semantic-conventions` v1.41.0) —
 * https://github.com/open-telemetry/semantic-conventions-genai/tree/v0.1.0
 * `gen_ai.provider.name` is the provider attribute; `gen_ai.system` is
 * deprecated in favour of it. The cache-write attribute is named
 * `gen_ai.usage.cache_creation.input_tokens` in semantic-conventions
 * v1.41.0 and `gen_ai.usage.cache_write.input_tokens` in
 * semantic-conventions-genai v0.1.0, which is why these names are held
 * here, where one edit moves them.
 *
 * `gen_ai.usage.input_tokens` on the span is every input token of the call,
 * those read from and written to a provider cache included, as v0.1.0 says
 * it SHOULD be. Providers differ in what their own input count holds, so
 * each adapter passes the span the count that means that. `chat()`'s
 * returned `TokenUsage` (its counts and its cost) is NOT changed by it:
 *
 *   Adapter                 | Provider's input count has cached tokens?   | Span input
 *   ------------------------|---------------------------------------------|----------------------------------
 *   /anthropic, /vertex     | No                                          | `input_tokens` + cache read
 *                           |                                             |   + cache write
 *   /claude-cli             | No: its `input_tokens` is as Anthropic's    | `input_tokens` + cache read
 *                           |                                             |   + cache write
 *   /deepseek               | Yes: `prompt_tokens` is                     | `prompt_tokens` as given
 *                           |   `prompt_cache_hit_tokens` +               |
 *                           |   `prompt_cache_miss_tokens`                |
 *   /openai                 | Yes: `input_tokens_details.cached_tokens`   | `input_tokens` as given
 *                           |   is a breakdown of `input_tokens`          |
 *   /google                 | Yes: `promptTokenCount` includes the        | `promptTokenCount` as given
 *                           |   cached content's tokens                   |
 *   /samba, /mistral,       | Yes: `prompt_tokens` (the returned count is | `prompt_tokens` as given
 *   /vertex-openai          |   `prompt_tokens` less cached tokens)       |
 *
 * With no input count from the provider the attribute is unset, as every
 * usage attribute is when the provider gave no value for it (see
 * {@link GenAISpanOutcome}): the input is never made from the cache counts
 * alone, and an unset cache count adds nothing (see
 * {@link spanInputTokensWithCache}).
 *
 * What the conventions have no attribute for at v0.1.0 — how long a cache
 * write is kept, the provider's own request id, a cost in money — keeps this
 * project's own names, deliberately namespaced OUTSIDE `gen_ai.*` (under
 * `verevoir.llm.*`) so a reader never mistakes them for a standard
 * attribute: `cache_creation.ephemeral_5m_input_tokens`,
 * `cache_creation.ephemeral_1h_input_tokens`, `provider_request_id`,
 * `session_id`, `cost_usd_reported` and `cost_usd_reported_invalid_type`.
 *
 * This module depends only on `@opentelemetry/api` — never an SDK. With no
 * SDK/exporter installed by the consuming application, `trace.getTracer()`
 * returns the API's own no-op tracer, so every span created here costs
 * nothing and changes no behaviour until an application wires up a real
 * provider — see `otel.test.ts`'s "no SDK installed" case. v5 of this
 * monorepo is where an SDK + exporter gets installed (ADR 046: this package
 * is the only one that talks to a provider SDK, so it is the right place
 * for the per-call span).
 */

import { SpanKind, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { CostInvalidKind } from './index.js';

// ── GenAI semantic-convention attributes (semantic-conventions-genai v0.1.0)
// — defined locally ───────────────────────────────────────────────────────

/** The kind of GenAI operation this span represents. Every call this
 * package instruments is a `"chat"` operation. */
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
/** The GenAI provider, e.g. `anthropic`, `openai`, `google`. Replaces the
 * now-deprecated `gen_ai.system` as of semconv v1.37.0. */
export const ATTR_GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
/** The model id requested. */
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';
/** The model id the provider actually answered with — may differ from the
 * request (e.g. an alias resolving to a dated snapshot). */
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';
/** The provider's own id for this response. */
export const ATTR_GEN_AI_RESPONSE_ID = 'gen_ai.response.id';
/** Every input token of the call, those read from and written to a
 * provider cache included — see this file's header table for what each
 * adapter passes. */
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
/** Tokens in the response (completion). */
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
/** "The number of input tokens served from a provider-managed cache." */
export const ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS = 'gen_ai.usage.cache_read.input_tokens';
/** "The number of input tokens written to a provider-managed cache." Named
 * `gen_ai.usage.cache_creation.input_tokens` in semantic-conventions
 * v1.41.0; this is its name in semantic-conventions-genai v0.1.0. */
export const ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS = 'gen_ai.usage.cache_write.input_tokens';
/** General (non-GenAI-specific) semconv attribute for the type of error
 * that failed the span — the thrown error's `name`. */
export const ATTR_ERROR_TYPE = 'error.type';

// ── Custom attributes — NOT in semantic-conventions-genai v0.1.0; namespaced
// outside `gen_ai.*` so they read unambiguously as this project's own. ─────

/** Anthropic's 5-minute-TTL slice of the cache-write tokens. Custom: no
 * `gen_ai.*` attribute for how long a cache write is kept exists in v0.1.0;
 * this mirrors Anthropic's own wire field name
 * (`usage.cache_creation.ephemeral_5m_input_tokens`). */
export const ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS =
  'verevoir.llm.cache_creation.ephemeral_5m_input_tokens';
/** Anthropic's 1-hour-TTL slice of the cache-write tokens — see above. */
export const ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS =
  'verevoir.llm.cache_creation.ephemeral_1h_input_tokens';
/** The provider's own id for this call — an HTTP `request-id` header where
 * reachable, or the SDK response object's own id field otherwise (see
 * `TokenUsage.providerRequestId` in src/index.ts for which adapters set
 * which). Custom: no `gen_ai.*` attribute for this exists in v0.1.0. */
export const ATTR_VEREVOIR_PROVIDER_REQUEST_ID = 'verevoir.llm.provider_request_id';
/** claude-cli only: the CLI's own session id, kept for correlation — NOT
 * a per-call request id. A held session reuses this across every turn;
 * see `TokenUsage.sessionId`'s own doc comment for why it is a separate
 * field from {@link ATTR_VEREVOIR_PROVIDER_REQUEST_ID}. */
export const ATTR_VEREVOIR_SESSION_ID = 'verevoir.llm.session_id';
/** The provider's own reported cost for this call, in USD. Custom: no
 * `gen_ai.*` cost attribute exists in v0.1.0, and this is deliberately
 * the provider's own relayed figure, never a value this library computed
 * from a price table. */
export const ATTR_VEREVOIR_COST_USD_REPORTED = 'verevoir.llm.cost_usd_reported';

/** The kind of malformation of a provider cost that was not a finite,
 * non-negative number: `negative`, `non-finite`, or the type name for a
 * non-number (`string`, `null`, ...) — never the value itself. Its
 * presence IS the "this cost was malformed" signal (there is no separate
 * boolean), so a malformed cost is distinguishable from a missing one;
 * {@link ATTR_VEREVOIR_COST_USD_REPORTED} is absent in that case. */
export const ATTR_VEREVOIR_COST_USD_REPORTED_INVALID_TYPE =
  'verevoir.llm.cost_usd_reported_invalid_type';

const tracer = trace.getTracer('@verevoir/llm');

/**
 * The span's input count for a provider whose own input count leaves cached
 * tokens out (the Anthropic shape): that count plus the cache-read count
 * plus the cache-write count. With no input count the result is
 * `undefined` — never a sum of the cache counts alone — and an absent
 * (`undefined` or `null`) cache count adds nothing.
 */
export function spanInputTokensWithCache(
  inputTokens: number | null | undefined,
  cacheReadInputTokens: number | null | undefined,
  cacheWriteInputTokens: number | null | undefined
): number | undefined {
  if (inputTokens === undefined || inputTokens === null) return undefined;
  return inputTokens + (cacheReadInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
}

/** What identifies the call before it's made. */
export interface GenAISpanRequest {
  provider: string;
  requestModel: string;
}

/**
 * What the call reports back, once it's known. Every field is optional and
 * left UNSET — never `null` or zero-filled — when the provider didn't
 * supply it, so a span never claims knowledge it doesn't have.
 */
export interface GenAISpanOutcome {
  responseModel?: string;
  responseId?: string;
  /** Every input token of the call, cached ones included: not necessarily
   * the adapter's returned `TokenUsage.inputTokens` — see the header table. */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreationEphemeral5mInputTokens?: number;
  cacheCreationEphemeral1hInputTokens?: number;
  /** claude-cli only: session id for correlation, not a per-call id —
   * see {@link ATTR_VEREVOIR_SESSION_ID}. */
  sessionId?: string;
  providerRequestId?: string;
  /** The provider's own reported cost for this call, in USD — never
   * computed, only ever relayed from the provider's payload when present.
   * See {@link ATTR_VEREVOIR_COST_USD_REPORTED}. */
  costUsdReported?: number;
  /** The kind of a malformed provider cost (`negative`, `non-finite` or a
   * type name); see
   * {@link ATTR_VEREVOIR_COST_USD_REPORTED_INVALID_TYPE}. */
  costUsdReportedInvalidType?: CostInvalidKind;
}

/**
 * ══════════════════════════════════════════════════════════════════════
 * WHY SPANS NEVER CARRY ERROR MESSAGES.
 * ══════════════════════════════════════════════════════════════════════
 * A privacy audit (2026-10-22) found three real paths for provider or
 * response text to reach a span through the raw error object
 * `recordException` used to record verbatim:
 *   - claude-cli's `is_error: true` throws embed the CLI's own response
 *     text (`parsed.result`) directly in the error message — see
 *     src/claude-cli/index.ts's one-shot path and src/claude-cli/
 *     session.ts's held-session path, both around their `is_error`
 *     check. That text can be the model's own output for the call.
 *   - every other adapter rethrows its SDK's own error unchanged out of
 *     its `callWithRetries`; this library does not control what those
 *     SDKs put in `.message`, which can include a copy of the request or
 *     response body.
 *   - `recordException`'s standard behaviour also captures the error's
 *     `.stack`, which — being a Node stack trace — carries local
 *     filesystem paths.
 * `withGenAISpan` below records a SANITIZED stand-in instead of the raw
 * error: the error's `name`, plus a numeric HTTP status if the error
 * happens to carry one (`.status`/`.statusCode`, as the OpenAI/Anthropic
 * SDKs set) — never the error's own `.message` and never `.stack`. The
 * error rethrown to the CALLER below is the original, untouched object;
 * only what reaches the span is sanitized.
 */

/** Best-effort numeric HTTP status off an error, if the SDK that threw it
 * sets one (OpenAI/Anthropic-shaped errors use `.status`; some others use
 * `.statusCode`). `undefined` when neither is a number — never guessed,
 * and never derived from the error's message text. */
function extractHttpStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const status = (err as { status?: unknown }).status;
  if (typeof status === 'number') return status;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  return undefined;
}

/**
 * Run `fn` inside a CLIENT span named `chat {requestModel}` — the GenAI
 * semconv span-naming convention, `{gen_ai.operation.name} {gen_ai.request
 * .model}`. `fn` receives the live span (for a caller that wants to add
 * more of its own) and returns both its own result and the
 * {@link GenAISpanOutcome} to record.
 *
 * On success, every PRESENT outcome field becomes a span attribute and the
 * span ends OK. On throw, `error.type` is set to the error's `name`, a
 * SANITIZED exception (name + a content-free summary, never the error's
 * own message or stack — see WHY SPANS NEVER CARRY ERROR MESSAGES above)
 * is recorded on the span, the span ends ERROR with that same sanitized
 * message, and the error is rethrown to the CALLER completely unchanged —
 * this never swallows, wraps, or reshapes a failure for the caller; it
 * only changes what the span itself is allowed to observe.
 */
export async function withGenAISpan<T>(
  request: GenAISpanRequest,
  fn: (span: Span) => Promise<{ result: T; outcome: GenAISpanOutcome }>
): Promise<T> {
  return tracer.startActiveSpan(
    `chat ${request.requestModel}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
        [ATTR_GEN_AI_PROVIDER_NAME]: request.provider,
        [ATTR_GEN_AI_REQUEST_MODEL]: request.requestModel,
      },
    },
    async (span) => {
      try {
        const { result, outcome } = await fn(span);
        applyOutcome(span, outcome);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const errorType = err instanceof Error && err.name ? err.name : 'Error';
        const httpStatus = extractHttpStatus(err);
        const sanitizedMessage =
          httpStatus !== undefined ? `${errorType} (status ${httpStatus})` : errorType;
        span.setAttribute(ATTR_ERROR_TYPE, errorType);
        // SANITIZED exception — never the real error's message or stack.
        // See "WHY SPANS NEVER CARRY ERROR MESSAGES" above. The error
        // rethrown to the caller below is the original, untouched object.
        span.recordException({ name: errorType, message: sanitizedMessage });
        span.setStatus({ code: SpanStatusCode.ERROR, message: sanitizedMessage });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

function applyOutcome(span: Span, outcome: GenAISpanOutcome): void {
  const set = (key: string, value: string | number | undefined): void => {
    if (value !== undefined) span.setAttribute(key, value);
  };
  set(ATTR_GEN_AI_RESPONSE_MODEL, outcome.responseModel);
  set(ATTR_GEN_AI_RESPONSE_ID, outcome.responseId);
  set(ATTR_GEN_AI_USAGE_INPUT_TOKENS, outcome.inputTokens);
  set(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, outcome.outputTokens);
  set(ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, outcome.cacheReadInputTokens);
  set(ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS, outcome.cacheCreationInputTokens);
  set(
    ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS,
    outcome.cacheCreationEphemeral5mInputTokens
  );
  set(
    ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS,
    outcome.cacheCreationEphemeral1hInputTokens
  );
  set(ATTR_VEREVOIR_SESSION_ID, outcome.sessionId);
  set(ATTR_VEREVOIR_PROVIDER_REQUEST_ID, outcome.providerRequestId);
  set(ATTR_VEREVOIR_COST_USD_REPORTED, outcome.costUsdReported);
  if (outcome.costUsdReportedInvalidType !== undefined) {
    set(ATTR_VEREVOIR_COST_USD_REPORTED_INVALID_TYPE, outcome.costUsdReportedInvalidType);
  }
}
