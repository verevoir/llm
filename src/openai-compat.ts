/**
 * @verevoir/llm — shared OpenAI-compatible adapter factory.
 *
 * Many providers (DeepSeek, SambaNova, Mistral, …) expose an OpenAI-compatible
 * Chat Completions API: same `openai` SDK, just a different `baseURL`, API key,
 * and model catalogue. Rather than copy the adapter per provider, this factory
 * builds one from a small config — a provider id, base URL, key env var, and a
 * **model catalogue** (provider/family entries, the de-brittle model identity
 * from STDIO-332). `models` / `rates` / labels all derive from the catalogue,
 * so a version bump is a one-line `currentId` change and decisions key on
 * `provider/family`, never on the exact version.
 *
 * Importing a subpath built on this factory requires `openai` as a peer
 * dependency on the consumer (the same one `/openai` + `/deepseek` already use).
 *
 * Ships `chat()` only — single-shot text generation — matching the staged
 * rollout of the other OpenAI-compatible adapters. Tool calling follows later.
 */

import OpenAI from 'openai';
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ModelCatalogEntry,
  type ModelClass,
  type RatesTable,
  type TokenUsage,
  registerModelCatalog,
} from './index.js';

/** Config for one OpenAI-compatible provider. */
export interface OpenAICompatConfig {
  /** Provider id reported on every {@link TokenUsage}, e.g. `mistral`. */
  provider: string;
  /** The provider's OpenAI-compatible base URL. */
  baseURL: string;
  /** Env var holding the default API key when no per-call key is passed. */
  apiKeyEnv: string;
  /** The model catalogue — provider/family entries; `models`/`rates`/labels
   * derive from it. Each entry's `modelClass` (when set) places it in the
   * class→model map. */
  catalog: ModelCatalogEntry[];
}

/** A built OpenAI-compatible adapter. */
export interface OpenAICompatAdapter {
  PROVIDER: string;
  BASE_URL: string;
  models: Readonly<Record<ModelClass, string>>;
  rates: RatesTable;
  chat: (options: ChatOptions) => Promise<ChatReply>;
}

// Same exponential-backoff shape as the other adapters; reason strings name the
// provider so retry narration stays informative across providers.
const RETRY_BACKOFFS_MS = [5_000, 30_000, 120_000, 300_000, 900_000];

/** Derive the class→model map from the catalogue, filling the tier ladder so
 * every class resolves: a missing `drafting` falls **up** to reasoning; a
 * missing tier borrows the nearest declared one. (Mirrors the DeepSeek
 * adapter's "drafting resolves up to the reasoning model" note.) */
function deriveModels(catalog: ModelCatalogEntry[]): Record<ModelClass, string> {
  const explicit: Partial<Record<ModelClass, string>> = {};
  for (const e of catalog) if (e.modelClass) explicit[e.modelClass] = e.currentId;
  const reasoning = explicit.reasoning ?? explicit.drafting ?? explicit.extraction;
  if (!reasoning) {
    throw new Error('OpenAI-compat catalog must declare at least one entry with a modelClass');
  }
  return {
    reasoning,
    drafting: explicit.drafting ?? reasoning,
    extraction: explicit.extraction ?? explicit.drafting ?? reasoning,
  };
}

interface RawResult {
  text: string;
  rawUsage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
  finishReason: string;
}

/** OpenAI-compatible usage shape, including the cache fields some providers
 * report (DeepSeek's `prompt_cache_hit_tokens`, or the standard
 * `prompt_tokens_details.cached_tokens`). */
interface CompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retriableReason(err: unknown, provider: string): string | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { status?: number; message?: string };
  const status = candidate.status;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (status === 503 || /\b503\b|service[_ ]unavailable/i.test(message)) {
    return `${provider} service unavailable (503)`;
  }
  if (status === 500 || /\b500\b|internal_server_error/i.test(message)) {
    return `${provider} internal error (500)`;
  }
  if (status === 429 || /\b429\b|rate[_ ]limit/i.test(message)) {
    return `${provider} rate-limited (429)`;
  }
  if (status === 502 || /\b502\b|bad[_ ]gateway/i.test(message)) {
    return `${provider} bad gateway (502)`;
  }
  return null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (signal.reason !== undefined) throw new Error(String(signal.reason));
  throw new DOMException('Aborted', 'AbortError');
}

/** Build an OpenAI-compatible adapter for one provider. Registers the model
 * catalogue (decisions key on provider/family; labels + family pricing become
 * available) as an import side-effect, the same way the bespoke adapters
 * register their labels. */
export function createOpenAICompatAdapter(config: OpenAICompatConfig): OpenAICompatAdapter {
  const { provider, baseURL, apiKeyEnv, catalog } = config;

  // Derive (and validate) before the register side-effect, so a malformed
  // catalogue throws rather than half-registering.
  const models = deriveModels(catalog);
  const rates: RatesTable = Object.fromEntries(catalog.map((e) => [e.currentId, e.rates]));
  registerModelCatalog(catalog);

  let defaultClient: OpenAI | null = null;
  function getClient(apiKey: string | null): OpenAI {
    if (apiKey) return new OpenAI({ apiKey, baseURL });
    if (defaultClient) return defaultClient;
    const env = process.env[apiKeyEnv];
    if (!env) {
      throw new Error(`${apiKeyEnv} is not set and no per-call apiKey was passed.`);
    }
    defaultClient = new OpenAI({ apiKey: env, baseURL });
    return defaultClient;
  }

  async function callChatCompletionsCreate(
    client: OpenAI,
    modelId: string,
    systemPrompt: string,
    turns: ChatOptions['turns']
  ): Promise<RawResult> {
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...turns.map((t) => ({ role: t.role as 'user' | 'assistant', content: t.content as string })),
    ];
    const response = await client.chat.completions.create({ model: modelId, messages });
    const choice = response.choices?.[0];
    const u = (response.usage ?? {}) as CompatUsage;
    const cachedInputTokens =
      u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: choice?.message?.content ?? '',
      rawUsage: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedInputTokens,
      },
      finishReason: choice?.finish_reason ?? '',
    };
  }

  async function callWithRetries<T>(
    call: () => Promise<T>,
    onRetry?: (info: ChatRetryInfo) => Promise<void>
  ): Promise<T> {
    for (let i = 0; i <= RETRY_BACKOFFS_MS.length; i++) {
      try {
        return await call();
      } catch (err) {
        const reason = retriableReason(err, provider);
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

  function shapeUsage(raw: RawResult['rawUsage'], direction: ModelClass): TokenUsage {
    return {
      provider,
      model: models[direction],
      direction,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: raw.cachedInputTokens,
    };
  }

  async function chat(options: ChatOptions): Promise<ChatReply> {
    if (options.turns.length === 0) {
      throw new Error(`${provider}.chat() requires at least one turn`);
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
        `${provider}.chat: finish_reason=${raw.finishReason} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
      );
    }

    const usage = shapeUsage(raw.rawUsage, modelClass);
    if (options.onUsage) {
      try {
        await options.onUsage(usage);
      } catch (err) {
        console.warn(`${provider}.chat: onUsage callback threw`, err);
      }
    }

    if (!raw.text) {
      throw new Error(
        `${provider}.chat: response had no text content (finishReason=${raw.finishReason})`
      );
    }

    return { content: raw.text, usage, stopReason: raw.finishReason };
  }

  return { PROVIDER: provider, BASE_URL: baseURL, models, rates, chat };
}
