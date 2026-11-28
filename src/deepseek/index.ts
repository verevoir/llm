/**
 * @verevoir/llm/deepseek — DeepSeek SDK adapter.
 *
 * DeepSeek exposes an OpenAI-compatible API, so this adapter reuses the
 * official `openai` package (the same peer dependency as `/openai`)
 * pointed at DeepSeek's `baseURL`. It mirrors the `/openai` adapter's
 * structure but calls the **Chat Completions** API (`chat.completions
 * .create`) rather than the Responses API — DeepSeek implements the
 * former, not the latter. Importing this subpath requires `openai` as a
 * peer dependency on the consumer.
 *
 * v0.6.0 ships `chat()` only — single-shot text generation, matching the
 * staged rollout of `/openai` + `/google`. Tool calling follows later.
 */

import OpenAI from 'openai';
import { fireUsageHook } from '../audit-hook.js';
import { GEN_AI_PROVIDER_DEEPSEEK, withGenAISpan } from '../otel.js';
import { callWithRetries, throwIfAborted } from '../retry-policy.js';
import { finishReasonStopKind } from '../openai-compat.js';
import {
  type ChatOptions,
  type ChatReply,
  type ModelClass,
  type RatesTable,
  type TokenUsage,
  EmptyResponseError,
  registerModelLabels,
  registerProviderConnection,
  resolveBaseUrl,
  collapseContentToText,
} from '../index.js';

// ────────────────────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────────────────────

/** Provider id reported on every {@link TokenUsage} this adapter returns. */
export const PROVIDER = 'deepseek';

/** DeepSeek's OpenAI-compatible endpoint. */
export const BASE_URL = 'https://api.deepseek.com';

/**
 * Concrete model id per {@link ModelClass}. Reasoning maps to
 * `deepseek-reasoner` (the R1-style reasoning model); extraction maps to
 * `deepseek-chat` (the general V3 model) for fast/cheap structured tasks.
 *
 * As of 2026-05-26 these are the current GA aliases; upgrades happen here
 * only, no ripple through callers.
 */
export const models: Readonly<Record<ModelClass, string>> = {
  reasoning: 'deepseek-reasoner',
  // No distinct mid tier on DeepSeek today — drafting resolves up to the
  // reasoning model (the tier fallback ladder, frozen statically).
  drafting: 'deepseek-reasoner',
  extraction: 'deepseek-chat',
};

/**
 * Per-model pricing (USD per million tokens) — DeepSeek-published
 * standard (cache-miss) rates as of 2026-05-26.
 *
 * **Worst-case approach:** same convention as the other adapters — cached
 * input is billed cheaper than standard but the rate-tuple here is the
 * standard input rate, so pricing via this table is an upper bound.
 * Refresh this table when DeepSeek publishes new pricing.
 *
 * Each rate-tuple is `[input_per_million_USD, output_per_million_USD]`.
 *
 * @deprecated Part of the old static-rates cost API. Use
 * `createPriceBook(...)` / `book.costOf(...)` instead (see `src/pricing.ts`)
 * — it prices from LiteLLM's live table (the bundled snapshot as fallback)
 * and reports an unmatched model as `unpriced` rather than `0`.
 */
export const rates: RatesTable = {
  'deepseek-reasoner': [0.55, 2.19],
  'deepseek-chat': [0.27, 1.1],
} as const;

// Register friendly labels for our models so the core's `modelLabel`
// helper returns "DeepSeek Reasoner" / "DeepSeek Chat" without the
// consumer wiring them manually. Import side-effect; idempotent.
registerModelLabels({
  'deepseek-reasoner': 'DeepSeek Reasoner',
  'deepseek-chat': 'DeepSeek Chat',
});

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

registerProviderConnection({
  provider: PROVIDER,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseUrlEnv: 'DEEPSEEK_BASE_URL',
  defaultBaseUrl: BASE_URL,
});

/** A client for `apiKey`. `maxRetries: 0` turns the SDK's own retries off:
 * {@link callWithRetries} is the only retry a request gets. With both on, each
 * attempt of that policy would itself be up to three requests, and `onRetry`
 * would be told of none of the SDK's. */
function newClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: resolveBaseUrl('DEEPSEEK_BASE_URL', BASE_URL),
    maxRetries: 0,
  });
}

let defaultClient: OpenAI | null = null;

function getDefaultClient(): OpenAI {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set and no per-call apiKey was passed.');
  }
  defaultClient = newClient(apiKey);
  return defaultClient;
}

function getClient(apiKey: string | null): OpenAI {
  if (apiKey) return newClient(apiKey);
  return getDefaultClient();
}

interface RawResult {
  text: string;
  rawUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
  };
  finishReason: string;
  /** The response's own id (`chatcmpl-...`) — the SDK object's id field, not
   * an HTTP header. See {@link TokenUsage.providerRequestId}. */
  responseId?: string;
}

/** DeepSeek reports cache hits via the non-standard `prompt_cache_hit_tokens`
 * field; some OpenAI-compatible responses use `prompt_tokens_details
 * .cached_tokens` instead. Read whichever is present. */
interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

async function callChatCompletionsCreate(
  client: OpenAI,
  modelId: string,
  systemPrompt: string,
  turns: ChatOptions['turns']
): Promise<RawResult> {
  return withGenAISpan({ provider: GEN_AI_PROVIDER_DEEPSEEK, requestModel: modelId }, async () => {
    // Chat Completions takes a single `messages` array with the system
    // prompt as the leading 'system' message. 'user' / 'assistant' roles
    // pass through unchanged.
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...turns.map((t) => ({
        role: t.role as 'user' | 'assistant',
        content: collapseContentToText(PROVIDER, t.content),
      })),
    ];

    const response = await client.chat.completions.create({
      model: modelId,
      messages,
    });

    const choice = response.choices?.[0];
    const text = choice?.message?.content ?? '';
    const u = (response.usage ?? {}) as DeepSeekUsage;
    const cachedInputTokens =
      u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;

    const result: RawResult = {
      text,
      rawUsage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedInputTokens,
      },
      finishReason: choice?.finish_reason ?? '',
      responseId: response.id,
    };

    return {
      result,
      outcome: {
        responseModel: response.model ?? modelId,
        responseId: response.id,
        // The provider's own values, not `rawUsage`'s zero-filled ones (src/otel.ts's header).
        inputTokens: u.prompt_tokens ?? undefined,
        outputTokens: u.completion_tokens ?? undefined,
        cacheReadInputTokens:
          u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? undefined,
      },
    };
  });
}

/** `modelId` is the id that was sent: the caller's `model` when given,
 * otherwise `models[direction]`. `direction` stays the class. */
function shapeUsage(
  raw: RawResult['rawUsage'],
  direction: ModelClass,
  modelId: string,
  responseId?: string
): TokenUsage {
  return {
    provider: PROVIDER,
    model: modelId,
    direction,
    // This adapter has exactly one credential mechanism (DEEPSEEK_API_KEY, or
    // a per-call key) — there is no second route to distinguish, so this is
    // a constant rather than a computed value. See CredentialRoute.
    route: 'api-key',
    // Worst-case treatment: charge cached input at the standard rate.
    // Matches the other adapters' convention.
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: raw.cachedInputTokens,
    // The response object's own id (not an HTTP header) — see RawResult's
    // own doc comment on `responseId`.
    providerRequestId: responseId,
  };
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Single-shot text generation via the DeepSeek Chat Completions API.
 * Same surface as the Anthropic + Google + OpenAI adapters' `chat()`:
 * pass turns + systemPrompt, get `{ content, usage, stopReason }` back.
 * Retry on transient errors with caller-visible narration via `onRetry`.
 *
 * Not yet supported in this adapter (planned follow-up): live progress
 * narration via `onProgress`, tool calling. Aligns with the staged
 * rollout of `/openai` + `/google` — chat() first, tools follow.
 */
export async function chat(options: ChatOptions): Promise<ChatReply> {
  if (options.turns.length === 0) {
    throw new Error('deepseek.chat() requires at least one turn');
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  // A caller's `model` is sent exactly as given; without one, the class's
  // id. See ChatOptions.model.
  const modelId = options.model ?? models[modelClass];

  const raw = await callWithRetries(
    () => callChatCompletionsCreate(client, modelId, options.systemPrompt, options.turns),
    'DeepSeek',
    options.onRetry,
    options.abortSignal
  );

  if (raw.finishReason && raw.finishReason !== 'stop') {
    console.warn(
      `deepseek.chat: finish_reason=${raw.finishReason} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(raw.rawUsage, modelClass, modelId, raw.responseId);
  await fireUsageHook(options.onUsage, usage, 'deepseek.chat');

  if (!raw.text) {
    throw new EmptyResponseError(
      `deepseek.chat: response had no text content (finishReason=${raw.finishReason})`,
      { stopReason: raw.finishReason, stopKind: finishReasonStopKind(raw.finishReason) }
    );
  }

  return {
    content: raw.text,
    usage,
    stopReason: raw.finishReason,
    stopKind: finishReasonStopKind(raw.finishReason),
  };
}
