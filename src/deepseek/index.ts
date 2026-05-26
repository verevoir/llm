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
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ModelClass,
  type RatesTable,
  type TokenUsage,
  registerModelLabels,
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
  extraction: 'deepseek-chat',
};

/**
 * Per-model pricing (USD per million tokens) — DeepSeek-published
 * standard (cache-miss) rates as of 2026-05-26.
 *
 * **Worst-case approach:** same convention as the other adapters — cached
 * input is billed cheaper than standard but the rate-tuple here is the
 * standard input rate, so {@link estimateCostUSD} returns an upper bound.
 * Refresh this table when DeepSeek publishes new pricing.
 *
 * Each rate-tuple is `[input_per_million_USD, output_per_million_USD]`.
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

let defaultClient: OpenAI | null = null;

function getDefaultClient(): OpenAI {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set and no per-call apiKey was passed.');
  }
  defaultClient = new OpenAI({ apiKey, baseURL: BASE_URL });
  return defaultClient;
}

function getClient(apiKey: string | null): OpenAI {
  if (apiKey) return new OpenAI({ apiKey, baseURL: BASE_URL });
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
  // Chat Completions takes a single `messages` array with the system
  // prompt as the leading 'system' message. 'user' / 'assistant' roles
  // pass through unchanged.
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...turns.map((t) => ({
      role: t.role as 'user' | 'assistant',
      content: t.content as string,
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

  return {
    text,
    rawUsage: {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cachedInputTokens,
    },
    finishReason: choice?.finish_reason ?? '',
  };
}

// DeepSeek outages and rate limits are handled with the same exponential-
// backoff shape as the other adapters. Reason strings name the provider
// so retry-narration messages stay informative across providers.
const RETRY_BACKOFFS_MS = [
  5_000, //   5 sec
  30_000, //  30 sec
  120_000, // 2 min
  300_000, // 5 min
  900_000, // 15 min
];

async function callWithRetries<T>(
  call: () => Promise<T>,
  onRetry?: (info: ChatRetryInfo) => Promise<void>
): Promise<T> {
  for (let i = 0; i <= RETRY_BACKOFFS_MS.length; i++) {
    try {
      return await call();
    } catch (err) {
      const reason = retriableReason(err);
      if (!reason) throw err;
      if (i === RETRY_BACKOFFS_MS.length) throw err;
      const delayMs = RETRY_BACKOFFS_MS[i];
      if (onRetry) {
        try {
          await onRetry({
            attempt: i + 1,
            maxAttempts: RETRY_BACKOFFS_MS.length,
            delayMs,
            reason,
          });
        } catch (notifyErr) {
          console.warn('callWithRetries: onRetry callback threw', notifyErr);
        }
      }
      await delay(delayMs);
    }
  }
  throw new Error('callWithRetries: exited loop without return or throw');
}

function retriableReason(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { status?: number; message?: string };
  const status = candidate.status;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (status === 503 || /\b503\b|service[_ ]unavailable/i.test(message)) {
    return 'DeepSeek service unavailable (503)';
  }
  if (status === 500 || /\b500\b|internal_server_error/i.test(message)) {
    return 'DeepSeek internal error (500)';
  }
  if (status === 429 || /\b429\b|rate[_ ]limit/i.test(message)) {
    return 'DeepSeek rate-limited (429)';
  }
  if (status === 502 || /\b502\b|bad[_ ]gateway/i.test(message)) {
    return 'DeepSeek bad gateway (502)';
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shapeUsage(raw: RawResult['rawUsage'], direction: ModelClass): TokenUsage {
  return {
    provider: PROVIDER,
    model: models[direction],
    direction,
    // Worst-case treatment: charge cached input at the standard rate.
    // Matches the other adapters' convention.
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: raw.cachedInputTokens,
  };
}

async function fireUsageHook(
  hook: ChatOptions['onUsage'],
  usage: TokenUsage,
  scope: string
): Promise<void> {
  if (!hook) return;
  try {
    await hook(usage);
  } catch (err) {
    console.warn(`${scope}: onUsage callback threw`, err);
  }
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
  const modelId = models[modelClass];

  const raw = await callWithRetries(
    () => callChatCompletionsCreate(client, modelId, options.systemPrompt, options.turns),
    options.onRetry
  );

  if (raw.finishReason && raw.finishReason !== 'stop') {
    console.warn(
      `deepseek.chat: finish_reason=${raw.finishReason} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(raw.rawUsage, modelClass);
  await fireUsageHook(options.onUsage, usage, 'deepseek.chat');

  if (!raw.text) {
    throw new Error(
      `deepseek.chat: response had no text content (finishReason=${raw.finishReason})`
    );
  }

  return {
    content: raw.text,
    usage,
    stopReason: raw.finishReason,
  };
}
