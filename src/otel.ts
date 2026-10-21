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
 * Followed: OpenTelemetry Semantic Conventions for Generative AI, v1.37.0
 * (`gen_ai.*`, status: Development) —
 * https://github.com/open-telemetry/semantic-conventions/blob/v1.37.0/docs/gen-ai/gen-ai-spans.md
 * In that version `gen_ai.provider.name` is the current provider attribute;
 * the earlier `gen_ai.system` is deprecated in favour of it.
 *
 * Cache tokens and the provider's own request id are NOT part of that spec
 * as of v1.37.0 — there is no `gen_ai.usage.cache_*` attribute and no
 * `gen_ai.*request_id` attribute defined. The four fields below are this
 * project's own, deliberately namespaced OUTSIDE `gen_ai.*` (under
 * `verevoir.llm.*`) so a reader never mistakes them for a standard
 * attribute: `cache_read_input_tokens`, `cache_creation_input_tokens`,
 * `cache_creation.ephemeral_5m_input_tokens`,
 * `cache_creation.ephemeral_1h_input_tokens`, and `provider_request_id`.
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

// ── GenAI semantic-convention attributes (v1.37.0) — defined locally ───────

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
/** Tokens in the request (prompt). */
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
/** Tokens in the response (completion). */
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
/** General (non-GenAI-specific) semconv attribute for the type of error
 * that failed the span — the thrown error's `name`. */
export const ATTR_ERROR_TYPE = 'error.type';

// ── Custom attributes — NOT in GenAI semconv v1.37.0; namespaced outside
// `gen_ai.*` so they read unambiguously as this project's own. ─────────────

/** Tokens read from provider cache on this call. Custom: no `gen_ai.*`
 * attribute for this exists in v1.37.0. */
export const ATTR_VEREVOIR_CACHE_READ_INPUT_TOKENS = 'verevoir.llm.cache_read_input_tokens';
/** Tokens written to provider cache on this call. Custom — see above. */
export const ATTR_VEREVOIR_CACHE_CREATION_INPUT_TOKENS = 'verevoir.llm.cache_creation_input_tokens';
/** Anthropic's 5-minute-TTL slice of the cache-write tokens. Custom — see
 * above; this mirrors Anthropic's own wire field name
 * (`usage.cache_creation.ephemeral_5m_input_tokens`). */
export const ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS =
  'verevoir.llm.cache_creation.ephemeral_5m_input_tokens';
/** Anthropic's 1-hour-TTL slice of the cache-write tokens — see above. */
export const ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS =
  'verevoir.llm.cache_creation.ephemeral_1h_input_tokens';
/** The provider's own request id (its `request-id` / `x-request-id`
 * response header), when the adapter's transport exposed it. Custom: no
 * `gen_ai.*` attribute for this exists in v1.37.0. */
export const ATTR_VEREVOIR_PROVIDER_REQUEST_ID = 'verevoir.llm.provider_request_id';

const tracer = trace.getTracer('@verevoir/llm');

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
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheCreationEphemeral5mInputTokens?: number;
  cacheCreationEphemeral1hInputTokens?: number;
  providerRequestId?: string;
}

/**
 * Run `fn` inside a CLIENT span named `chat {requestModel}` — the GenAI
 * semconv span-naming convention, `{gen_ai.operation.name} {gen_ai.request
 * .model}`. `fn` receives the live span (for a caller that wants to add
 * more of its own) and returns both its own result and the
 * {@link GenAISpanOutcome} to record.
 *
 * On success, every PRESENT outcome field becomes a span attribute and the
 * span ends OK. On throw, `error.type` is set to the error's `name`, the
 * exception is recorded on the span, the span ends ERROR, and the error is
 * rethrown completely unchanged — this never swallows, wraps, or reshapes a
 * failure; it only observes it.
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
        span.setAttribute(ATTR_ERROR_TYPE, errorType);
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorType });
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
  set(ATTR_VEREVOIR_CACHE_READ_INPUT_TOKENS, outcome.cacheReadInputTokens);
  set(ATTR_VEREVOIR_CACHE_CREATION_INPUT_TOKENS, outcome.cacheCreationInputTokens);
  set(
    ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS,
    outcome.cacheCreationEphemeral5mInputTokens
  );
  set(
    ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS,
    outcome.cacheCreationEphemeral1hInputTokens
  );
  set(ATTR_VEREVOIR_PROVIDER_REQUEST_ID, outcome.providerRequestId);
}
