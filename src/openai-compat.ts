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
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ModelCatalogEntry,
  type ModelClass,
  type RatesTable,
  type ToolDef,
  type ToolUse,
  type TokenUsage,
  registerModelCatalog,
  registerProviderConnection,
  resolveBaseUrl,
} from './index.js';

/** Config for one OpenAI-compatible provider. */
export interface OpenAICompatConfig {
  /** Provider id reported on every {@link TokenUsage}, e.g. `mistral`. */
  provider: string;
  /** The provider's OpenAI-compatible base URL. */
  baseURL: string;
  /** Env var that overrides `baseURL` at runtime (a gateway/proxy/regional/
   * self-hosted endpoint), e.g. `SAMBA_NOVA_BASE_URL`. Optional. */
  baseUrlEnv?: string;
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
  chatWithTools: (options: ChatWithToolsOptions) => Promise<ChatWithToolsResult>;
  chatWithToolLoop: (options: ChatWithToolLoopOptions) => Promise<ChatWithToolLoopResult>;
}

/** OpenAI Chat Completions tool-call shape we read off a response. */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
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
  const { provider, baseURL, baseUrlEnv, apiKeyEnv, catalog } = config;

  // Derive (and validate) before the register side-effect, so a malformed
  // catalogue throws rather than half-registering.
  const models = deriveModels(catalog);
  const rates: RatesTable = Object.fromEntries(catalog.map((e) => [e.currentId, e.rates]));
  registerModelCatalog(catalog);
  registerProviderConnection({ provider, apiKeyEnv, baseUrlEnv });

  let defaultClient: OpenAI | null = null;
  function getClient(apiKey: string | null): OpenAI {
    const url = resolveBaseUrl(baseUrlEnv, baseURL);
    if (apiKey) return new OpenAI({ apiKey, baseURL: url });
    if (defaultClient) return defaultClient;
    const env = process.env[apiKeyEnv];
    if (!env) {
      throw new Error(`${apiKeyEnv} is not set and no per-call apiKey was passed.`);
    }
    defaultClient = new OpenAI({ apiKey: env, baseURL: url });
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

  // ── Tool calling (STDIO-342) ───────────────────────────────────────────────
  // OpenAI Chat Completions exposes native function/tool calling. Map our
  // provider-agnostic ToolDef → OpenAI `tools`, and read `tool_calls` back.
  // This is what makes the providers usable for enactment (a tool-driven loop),
  // not just plain chat.

  function toOpenAITools(tools: ToolDef[]) {
    return tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  function parseToolUse(tc: OpenAIToolCall): ToolUse {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments
        ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
        : {};
    } catch {
      input = { _raw: tc.function.arguments };
    }
    return { id: tc.id, name: tc.function.name, input };
  }

  function baseMessages(systemPrompt: string, turns: ChatOptions['turns']): unknown[] {
    return [
      { role: 'system', content: systemPrompt },
      ...turns.map((t) => ({ role: t.role, content: t.content as string })),
    ];
  }

  // One tool-enabled completion: assistant text + the tool calls it emitted + usage.
  async function createWithTools(
    client: OpenAI,
    modelId: string,
    messages: unknown[],
    tools: ReturnType<typeof toOpenAITools>
  ): Promise<{
    text: string;
    rawCalls: OpenAIToolCall[];
    raw: RawResult['rawUsage'];
    finishReason: string;
  }> {
    const response = await client.chat.completions.create({
      model: modelId,
      messages: messages as never,
      tools: tools.length > 0 ? (tools as never) : undefined,
    });
    const choice = response.choices?.[0];
    const msg = (choice?.message ?? {}) as {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    const u = (response.usage ?? {}) as CompatUsage;
    return {
      text: msg.content ?? '',
      rawCalls: msg.tool_calls ?? [],
      raw: {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cachedInputTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? '',
    };
  }

  /** Single-shot tool-calling: surface the model's tool_calls for the caller to
   * execute (no automated loop). Mirrors the Anthropic adapter's chatWithTools. */
  async function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
    if (options.turns.length === 0)
      throw new Error(`${provider}.chatWithTools() requires at least one turn`);
    if (options.tools.length === 0)
      throw new Error(`${provider}.chatWithTools() requires at least one tool`);
    throwIfAborted(options.abortSignal);
    const modelClass: ModelClass = options.modelClass ?? 'reasoning';
    const client = getClient(options.apiKey ?? null);
    const modelId = models[modelClass];
    const tools = toOpenAITools(options.tools);

    const r = await callWithRetries(
      () =>
        createWithTools(client, modelId, baseMessages(options.systemPrompt, options.turns), tools),
      options.onRetry
    );
    const usage = shapeUsage(r.raw, modelClass);
    if (options.onUsage) {
      try {
        await options.onUsage(usage);
      } catch (err) {
        console.warn(`${provider}.chatWithTools: onUsage threw`, err);
      }
    }
    return {
      toolUses: r.rawCalls.map(parseToolUse),
      text: r.text,
      stopReason: r.finishReason,
      usage,
    };
  }

  /** Multi-turn tool loop: model → execute tools → feed tool results back, until
   * the model returns a tool-free message (or maxIterations). Mirrors the
   * Anthropic adapter's chatWithToolLoop, in OpenAI message shape. */
  async function chatWithToolLoop(
    options: ChatWithToolLoopOptions
  ): Promise<ChatWithToolLoopResult> {
    if (options.turns.length === 0)
      throw new Error(`${provider}.chatWithToolLoop() requires at least one turn`);
    if (options.tools.length === 0)
      throw new Error(`${provider}.chatWithToolLoop() requires at least one tool`);
    const modelClass: ModelClass = options.modelClass ?? 'reasoning';
    const client = getClient(options.apiKey ?? null);
    const modelId = models[modelClass];
    const tools = toOpenAITools(options.tools);
    const maxIterations = Math.max(1, options.maxIterations ?? 5);

    const messages: unknown[] = baseMessages(options.systemPrompt, options.turns);
    const allToolUses: ToolUse[] = [];
    const allToolResults: ChatWithToolLoopResult['toolResults'] = [];
    const aggregate: TokenUsage = {
      provider,
      model: modelId,
      direction: modelClass,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    let iteration = 0;
    while (iteration < maxIterations) {
      iteration += 1;
      throwIfAborted(options.abortSignal);
      const r = await callWithRetries(
        () => createWithTools(client, modelId, messages, tools),
        options.onRetry
      );
      aggregate.inputTokens += r.raw.inputTokens;
      aggregate.outputTokens += r.raw.outputTokens;
      aggregate.cacheReadInputTokens += r.raw.cachedInputTokens;
      if (options.onUsage) {
        try {
          await options.onUsage(shapeUsage(r.raw, modelClass));
        } catch (err) {
          console.warn(`${provider}.chatWithToolLoop: onUsage threw`, err);
        }
      }
      if (options.onIteration) {
        try {
          await options.onIteration({
            iteration,
            toolUses: r.rawCalls.map(parseToolUse),
            stopReason: r.finishReason,
          });
        } catch (err) {
          console.warn(`${provider}.chatWithToolLoop: onIteration threw`, err);
        }
      }
      if (r.rawCalls.length === 0) {
        return {
          text: r.text,
          toolUses: allToolUses,
          toolResults: allToolResults,
          iterations: iteration,
          usage: aggregate,
        };
      }
      // Append the assistant turn verbatim (text + tool_calls) so the model
      // recognises the tool results that follow.
      messages.push({ role: 'assistant', content: r.text || null, tool_calls: r.rawCalls });
      for (const tc of r.rawCalls) {
        const use = parseToolUse(tc);
        allToolUses.push(use);
        let content: string;
        let isError = false;
        try {
          content = await options.executor(use);
        } catch (err) {
          content = err instanceof Error ? err.message : String(err);
          isError = true;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
        allToolResults.push({ toolUseId: tc.id, content, isError });
      }
    }
    return {
      text: '',
      toolUses: allToolUses,
      toolResults: allToolResults,
      iterations: iteration,
      usage: aggregate,
    };
  }

  return {
    PROVIDER: provider,
    BASE_URL: baseURL,
    models,
    rates,
    chat,
    chatWithTools,
    chatWithToolLoop,
  };
}
