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
 * here is the standard input rate, so {@link estimateCostUSD} returns
 * an upper bound. Refresh this table when OpenAI publishes new
 * pricing.
 *
 * Each rate-tuple is `[input_per_million_USD, output_per_million_USD]`.
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

let defaultClient: OpenAI | null = null;

function getDefaultClient(): OpenAI {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set and no per-call apiKey was passed.');
  }
  defaultClient = new OpenAI({ apiKey });
  return defaultClient;
}

function getClient(apiKey: string | null): OpenAI {
  if (apiKey) return new OpenAI({ apiKey });
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
}

async function callResponsesCreate(
  client: OpenAI,
  modelId: string,
  systemPrompt: string,
  turns: ChatOptions['turns']
): Promise<RawResult> {
  // The Responses API takes `instructions` (system) + `input` (the
  // conversation). 'assistant' / 'user' roles pass through unchanged.
  const input = turns.map((t) => ({
    role: t.role as 'user' | 'assistant',
    content: t.content as string,
  }));

  const response = await client.responses.create({
    model: modelId,
    instructions: systemPrompt,
    input,
  });

  const text = response.output_text ?? '';
  const u = response.usage;
  const cachedInputTokens = u?.input_tokens_details?.cached_tokens ?? 0;

  return {
    text,
    rawUsage: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cachedInputTokens,
    },
    status: response.status ?? '',
  };
}

// OpenAI outages and rate limits are handled with the same exponential-
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
    return 'OpenAI service unavailable (503)';
  }
  if (status === 500 || /\b500\b|internal_server_error/i.test(message)) {
    return 'OpenAI internal error (500)';
  }
  if (status === 429 || /\b429\b|rate[_ ]limit/i.test(message)) {
    return 'OpenAI rate-limited (429)';
  }
  if (status === 502 || /\b502\b|bad[_ ]gateway/i.test(message)) {
    return 'OpenAI bad gateway (502)';
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
    options.onRetry
  );

  if (raw.status && raw.status !== 'completed') {
    console.warn(
      `openai.chat: response status=${raw.status} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(raw.rawUsage, modelClass);
  await fireUsageHook(options.onUsage, usage, 'openai.chat');

  if (!raw.text) {
    throw new Error(`openai.chat: response had no text content (status=${raw.status})`);
  }

  return {
    content: raw.text,
    usage,
    stopReason: raw.status,
  };
}
