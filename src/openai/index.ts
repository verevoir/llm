/**
 * @verevoir/llm/openai — OpenAI SDK adapter.
 *
 * Wraps the official `openai` package via the Responses API (the
 * post-Chat-Completions canonical surface). Importing this subpath
 * requires `openai` as a peer dependency on the consumer.
 *
 * v0.5.0 ships `chat()` only — single-shot text generation. The
 * materialiser-style paths (review-repo, doc-piece, conversation-doc)
 * use just this. `chatWithTools()` and `chatWithToolLoop()` follow in
 * a subsequent release.
 */

import OpenAI from 'openai';
import { fireUsageHook } from '../audit-hook.js';
import { withGenAISpan } from '../otel.js';
import { callWithRetries } from '../retry-policy.js';
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
  localEndpointKey,
  collapseContentToText,
} from '../index.js';

// ────────────────────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────────────────────

/** Provider id reported on every {@link TokenUsage} this adapter returns. */
export const PROVIDER = 'openai';

/**
 * Concrete model id per {@link ModelClass}. Reasoning maps to the
 * current GPT-5 tier; extraction maps to GPT-5 Mini for fast/cheap
 * structured tasks.
 *
 * As of 2026-05-20 these are the GA identifiers in the gpt-5 family;
 * upgrades happen here only, no ripple through callers.
 */
export const models: Readonly<Record<ModelClass, string>> = {
  reasoning: 'gpt-5',
  // No distinct mid tier wired today — drafting resolves up to the
  // reasoning model (the tier fallback ladder, frozen statically).
  drafting: 'gpt-5',
  extraction: 'gpt-5-mini',
};

/**
 * Per-model pricing (USD per million tokens) — OpenAI-published rates
 * as of 2026-05-20.
 *
 * **Worst-case approach:** same convention as the other adapters —
 * cached input is billed cheaper than standard but the rate-tuple
 * here is the standard input rate, so pricing via this table is an
 * upper bound. Refresh this table when OpenAI publishes new
 * pricing.
 *
 * Each rate-tuple is `[input_per_million_USD, output_per_million_USD]`.
 *
 * @deprecated Part of the old static-rates cost API. Use
 * `createPriceBook(...)` / `book.costOf(...)` instead (see `src/pricing.ts`)
 * — it prices from LiteLLM's live table (the bundled snapshot as fallback)
 * and reports an unmatched model as `unpriced` rather than `0`.
 */
export const rates: RatesTable = {
  'gpt-5': [1.25, 10],
  'gpt-5-mini': [0.25, 2],
} as const;

// Register friendly labels for our models so the core's `modelLabel`
// helper returns "GPT-5" / "GPT-5 Mini" without the consumer wiring
// them manually. Import side-effect; idempotent.
registerModelLabels({
  'gpt-5': 'GPT-5',
  'gpt-5-mini': 'GPT-5 Mini',
});

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

registerProviderConnection({
  provider: PROVIDER,
  apiKeyEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_BASE_URL',
  defaultBaseUrl: 'https://api.openai.com/v1',
  // The generic OpenAI-compatible client: a base-URL override can point it at a
  // keyless local server (LM Studio / Ollama / vLLM), so it's usable key-free.
  keylessCapable: true,
});

/** A client for `apiKey`. `maxRetries: 0` turns the SDK's own retries off:
 * {@link callWithRetries} is the only retry a request gets, and covers what
 * the SDK's covered. With both on, each attempt of that policy was itself up
 * to three requests, of which `onRetry` was told nothing. */
function newClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: resolveBaseUrl('OPENAI_BASE_URL'), maxRetries: 0 });
}

let defaultClient: OpenAI | null = null;

function getDefaultClient(): OpenAI {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.OPENAI_API_KEY || localEndpointKey('OPENAI_BASE_URL');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set and no per-call apiKey was passed.');
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
  status: string;
  /** The response's own id (`resp_...`) — the SDK object's id field, not an
   * HTTP header. See {@link TokenUsage.providerRequestId}. */
  responseId?: string;
}

async function callResponsesCreate(
  client: OpenAI,
  modelId: string,
  systemPrompt: string,
  turns: ChatOptions['turns']
): Promise<RawResult> {
  return withGenAISpan({ provider: PROVIDER, requestModel: modelId }, async () => {
    // The Responses API takes `instructions` (system) + `input` (the
    // conversation). 'assistant' / 'user' roles pass through unchanged.
    const input = turns.map((t) => ({
      role: t.role as 'user' | 'assistant',
      content: collapseContentToText(PROVIDER, t.content),
    }));

    const response = await client.responses.create({
      model: modelId,
      instructions: systemPrompt,
      input,
    });

    const text = response.output_text ?? '';
    const u = response.usage;
    const cachedInputTokens = u?.input_tokens_details?.cached_tokens ?? 0;

    const result: RawResult = {
      text,
      rawUsage: {
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cachedInputTokens,
      },
      status: response.status ?? '',
      responseId: response.id,
    };

    return {
      result,
      outcome: {
        responseModel: response.model ?? modelId,
        responseId: response.id,
        inputTokens: result.rawUsage.inputTokens,
        outputTokens: result.rawUsage.outputTokens,
        cacheReadInputTokens: cachedInputTokens || undefined,
      },
    };
  });
}

function shapeUsage(
  raw: RawResult['rawUsage'],
  direction: ModelClass,
  responseId?: string
): TokenUsage {
  return {
    provider: PROVIDER,
    model: models[direction],
    direction,
    // This adapter has exactly one credential mechanism (OPENAI_API_KEY, a
    // keyless local override, or a per-call key) — there is no second route
    // to distinguish, so this is a constant rather than a computed value.
    // See CredentialRoute.
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

/** Throw the AbortSignal's reason (or a generic AbortError) when
 * the signal is aborted. No-op when no signal is provided or the
 * signal has not been aborted. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (signal.reason !== undefined) throw new Error(String(signal.reason));
  throw new DOMException('Aborted', 'AbortError');
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Single-shot text generation via the OpenAI Responses API. Same
 * surface as the Anthropic + Google adapters' `chat()`: pass turns
 * + systemPrompt, get `{ content, usage, stopReason }` back. Retry
 * on transient errors with caller-visible narration via `onRetry`.
 *
 * Not yet supported in this adapter (planned follow-up): live progress
 * narration via `onProgress`, tool calling. Aligns with the staged
 * rollout of `/google` — chat() first, tools follow.
 */
export async function chat(options: ChatOptions): Promise<ChatReply> {
  if (options.turns.length === 0) {
    throw new Error('openai.chat() requires at least one turn');
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const modelId = models[modelClass];

  const raw = await callWithRetries(
    () => callResponsesCreate(client, modelId, options.systemPrompt, options.turns),
    'OpenAI',
    options.onRetry
  );

  if (raw.status && raw.status !== 'completed') {
    console.warn(
      `openai.chat: response status=${raw.status} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(raw.rawUsage, modelClass, raw.responseId);
  await fireUsageHook(options.onUsage, usage, 'openai.chat');

  if (!raw.text) {
    throw new EmptyResponseError(
      `openai.chat: response had no text content (status=${raw.status})`
    );
  }

  return {
    content: raw.text,
    usage,
    stopReason: raw.status,
  };
}
