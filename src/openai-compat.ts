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
import { fireUsageHook } from './audit-hook.js';
import { withGenAISpan, type GenAISpanOutcome } from './otel.js';
import { collapseContentToText } from './index.js';
import { callWithRetries as callWithPolicy, throwIfAborted } from './retry-policy.js';
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type CredentialRoute,
  type ModelCatalogEntry,
  type ModelClass,
  type RatesTable,
  type StopKind,
  type ToolDef,
  type ToolUse,
  type TokenUsage,
  EmptyResponseError,
  registerModelCatalog,
  registerProviderConnection,
  resolveBaseUrl,
  localEndpointKey,
} from './index.js';

/** Chat Completions `finish_reason` words, as `openai` 6.49.0 declares them.
 * A word a compatible provider sends beyond OpenAI's set is unverified, and
 * falls to `other`. */
const FINISH_REASON_KINDS: Readonly<Record<string, StopKind>> = {
  stop: 'finished',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refused',
};

/** The {@link StopKind} for a Chat Completions `finish_reason`, for every
 * adapter that reads one (`/deepseek` included). Never throws. */
export function finishReasonStopKind(finishReason: string): StopKind {
  return Object.hasOwn(FINISH_REASON_KINDS, finishReason)
    ? FINISH_REASON_KINDS[finishReason]
    : 'other';
}

/** Config for one OpenAI-compatible provider. */
export interface OpenAICompatConfig {
  /** Provider id reported on every {@link TokenUsage}, e.g. `mistral`. */
  provider: string;
  /** The provider's OpenAI-compatible base URL. */
  baseURL: string;
  /** Env var that overrides `baseURL` at runtime (a gateway/proxy/regional/
   * self-hosted endpoint), e.g. `SAMBA_NOVA_BASE_URL`. Optional. */
  baseUrlEnv?: string;
  /** Whether a base-URL override without a key makes this usable — true only
   * for a generic OpenAI-compatible client pointed at a keyless local server.
   * Hosted providers (SambaNova, Mistral, …) leave it false: they need a key. */
  keylessCapable?: boolean;
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

/** The three call shapes, as every adapter built here exposes them. */
export type OpenAICompatCalls = Pick<
  OpenAICompatAdapter,
  'chat' | 'chatWithTools' | 'chatWithToolLoop'
>;

/** What the call shapes need from the adapter they are built for: its id, its
 * credential route, where a client comes from and which model id a call sends.
 * {@link createOpenAICompatAdapter} fills this from a key, a base URL and a
 * catalogue; an adapter with none of those fills it itself and calls
 * {@link createOpenAICompatCalls} directly. */
export interface OpenAICompatCallsConfig {
  /** Provider id reported on every {@link TokenUsage}. */
  provider: string;
  /** The credential mechanism reported on every {@link TokenUsage}. */
  route: CredentialRoute;
  /** The client for one call, given its per-call `apiKey` (or null). May throw
   * to refuse the call; nothing has been sent at that point. */
  getClient: (perCallApiKey: string | null) => OpenAI;
  /** The model id to send, given the caller's `model` (if any) and the class
   * asked for. May throw to refuse the call. */
  modelFor: (named: string | undefined, modelClass: ModelClass) => string;
  /** Output tokens for one response's usage. Default: `completion_tokens`. */
  outputTokensOf?: (usage: CompatUsage) => number;
}

/** OpenAI Chat Completions tool-call shape we read off a response. */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

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
  /** The response's own id (`chatcmpl-...`) — the SDK object's id field, not
   * an HTTP header. See {@link TokenUsage.providerRequestId}. */
  responseId?: string;
}

/** OpenAI-compatible usage shape, including the cache fields some providers
 * report (DeepSeek's `prompt_cache_hit_tokens`, or the standard
 * `prompt_tokens_details.cached_tokens`). A details member may be null. */
export interface CompatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  completion_tokens_details?: { reasoning_tokens?: number } | null;
}

/** Build an OpenAI-compatible adapter for one provider. Registers the model
 * catalogue (decisions key on provider/family; labels + family pricing become
 * available) as an import side-effect, the same way the bespoke adapters
 * register their labels. */
export function createOpenAICompatAdapter(config: OpenAICompatConfig): OpenAICompatAdapter {
  const { provider, baseURL, baseUrlEnv, keylessCapable, apiKeyEnv, catalog } = config;

  // Derive (and validate) before the register side-effect, so a malformed
  // catalogue throws rather than half-registering.
  const models = deriveModels(catalog);
  const rates: RatesTable = Object.fromEntries(catalog.map((e) => [e.currentId, e.rates]));
  registerModelCatalog(catalog);
  registerProviderConnection({
    provider,
    apiKeyEnv,
    baseUrlEnv,
    keylessCapable,
    defaultBaseUrl: baseURL,
  });

  /** A client for `apiKey`. `maxRetries: 0` turns the SDK's own retries off:
   * `callWithRetries` in `./retry-policy.js` is the only retry a request gets.
   * With both on, each attempt of that policy would itself be up to three
   * requests, and `onRetry` would be told of none of the SDK's. */
  function newClient(apiKey: string): OpenAI {
    return new OpenAI({ apiKey, baseURL: resolveBaseUrl(baseUrlEnv, baseURL), maxRetries: 0 });
  }

  let defaultClient: OpenAI | null = null;
  function getClient(apiKey: string | null): OpenAI {
    if (apiKey) return newClient(apiKey);
    if (defaultClient) return defaultClient;
    const env =
      process.env[apiKeyEnv] || (keylessCapable ? localEndpointKey(baseUrlEnv) : undefined);
    if (!env) {
      throw new Error(`${apiKeyEnv} is not set and no per-call apiKey was passed.`);
    }
    defaultClient = newClient(env);
    return defaultClient;
  }

  const calls = createOpenAICompatCalls({
    provider,
    // This factory has exactly one credential mechanism (apiKeyEnv, or a
    // per-call key) — there is no second route to distinguish, so this is
    // a constant rather than a computed value. See CredentialRoute.
    route: 'api-key',
    getClient,
    // A caller's `model` is sent exactly as given (no catalogue lookup);
    // without one, the catalogue's id for the class. See ChatOptions.model.
    modelFor: (named, modelClass) => named ?? models[modelClass],
  });

  return {
    PROVIDER: provider,
    BASE_URL: baseURL,
    models,
    rates,
    ...calls,
  };
}

/** Build the three call shapes — `chat`, `chatWithTools`, `chatWithToolLoop` —
 * over the Chat Completions API. Registers nothing and reads no environment
 * variable: the client and the model id come from `config`. */
export function createOpenAICompatCalls(config: OpenAICompatCallsConfig): OpenAICompatCalls {
  const { provider, route, getClient, modelFor } = config;
  const outputTokensOf = config.outputTokensOf ?? ((u: CompatUsage) => u.completion_tokens ?? 0);

  /** The span's usage counts, from the provider's own fields — not the
   * returned counts, which fill a missing field with 0 — so a count the
   * reply didn't carry leaves its attribute unset and a 0 it did carry is a
   * 0. The input is `prompt_tokens` as it is: it already includes the cached
   * tokens, which is what the span's input is (semantic-conventions-genai
   * v0.1.0), not the returned count, which subtracts them. The output is
   * {@link outputTokensOf} when the reply carried a count this adapter
   * counts as output: `completion_tokens`, or a reasoning count where the
   * adapter has its own `outputTokensOf`. Otherwise it is unset. */
  function spanUsageOf(u: CompatUsage): GenAISpanOutcome {
    const countsReasoning = config.outputTokensOf !== undefined;
    const hasOutput =
      u.completion_tokens != null ||
      (countsReasoning && u.completion_tokens_details?.reasoning_tokens != null);
    return {
      inputTokens: u.prompt_tokens ?? undefined,
      outputTokens: hasOutput ? outputTokensOf(u) : undefined,
      cacheReadInputTokens:
        u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? undefined,
    };
  }

  async function callChatCompletionsCreate(
    client: OpenAI,
    modelId: string,
    systemPrompt: string,
    turns: ChatOptions['turns']
  ): Promise<RawResult> {
    return withGenAISpan({ provider, requestModel: modelId }, async () => {
      const messages = [
        { role: 'system' as const, content: systemPrompt },
        ...turns.map((t) => ({
          role: t.role as 'user' | 'assistant',
          content: collapseContentToText(provider, t.content),
        })),
      ];
      const response = await client.chat.completions.create({ model: modelId, messages });
      const choice = response.choices?.[0];
      const u = (response.usage ?? {}) as CompatUsage;
      const cachedInputTokens =
        u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      const result: RawResult = {
        text: choice?.message?.content ?? '',
        rawUsage: {
          inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cachedInputTokens),
          outputTokens: outputTokensOf(u),
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
          ...spanUsageOf(u),
        },
      };
    });
  }

  /** The shared policy, with this provider's name in the reasons it gives.
   * `signal` is required, so that no call site can leave the caller's out. */
  const callWithRetries = <T>(
    call: () => Promise<T>,
    onRetry: ((info: ChatRetryInfo) => Promise<void>) | undefined,
    signal: AbortSignal | undefined
  ): Promise<T> => callWithPolicy(call, provider, onRetry, signal);

  /** `modelId` is the id that was sent: the caller's `model` when given,
   * otherwise the catalogue's id for the class. `direction` stays the class. */
  function shapeUsage(
    raw: RawResult['rawUsage'],
    direction: ModelClass,
    modelId: string,
    responseId?: string
  ): TokenUsage {
    return {
      provider,
      model: modelId,
      direction,
      route,
      inputTokens: raw.inputTokens,
      outputTokens: raw.outputTokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: raw.cachedInputTokens,
      // The response object's own id (not an HTTP header) — see RawResult's
      // own doc comment on `responseId`.
      providerRequestId: responseId,
    };
  }

  async function chat(options: ChatOptions): Promise<ChatReply> {
    if (options.turns.length === 0) {
      throw new Error(`${provider}.chat() requires at least one turn`);
    }
    throwIfAborted(options.abortSignal);
    const modelClass: ModelClass = options.modelClass ?? 'reasoning';
    const client = getClient(options.apiKey ?? null);
    const modelId = modelFor(options.model, modelClass);

    const raw = await callWithRetries(
      () => callChatCompletionsCreate(client, modelId, options.systemPrompt, options.turns),
      options.onRetry,
      options.abortSignal
    );

    if (raw.finishReason && raw.finishReason !== 'stop') {
      console.warn(
        `${provider}.chat: finish_reason=${raw.finishReason} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
      );
    }

    const usage = shapeUsage(raw.rawUsage, modelClass, modelId, raw.responseId);
    await fireUsageHook(options.onUsage, usage, `${provider}.chat`);

    if (!raw.text) {
      throw new EmptyResponseError(
        `${provider}.chat: response had no text content (finishReason=${raw.finishReason})`,
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
      ...turns.map((t) => ({ role: t.role, content: collapseContentToText(provider, t.content) })),
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
    return withGenAISpan({ provider, requestModel: modelId }, async () => {
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
      const cachedInputTokens =
        u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
      const result = {
        text: msg.content ?? '',
        rawCalls: msg.tool_calls ?? [],
        raw: {
          inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cachedInputTokens),
          outputTokens: outputTokensOf(u),
          cachedInputTokens,
        },
        finishReason: choice?.finish_reason ?? '',
      };
      return {
        result,
        outcome: {
          responseModel: response.model ?? modelId,
          responseId: response.id,
          ...spanUsageOf(u),
        },
      };
    });
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
    const modelId = modelFor(options.model, modelClass);
    const tools = toOpenAITools(options.tools);

    const r = await callWithRetries(
      () =>
        createWithTools(client, modelId, baseMessages(options.systemPrompt, options.turns), tools),
      options.onRetry,
      options.abortSignal
    );
    const usage = shapeUsage(r.raw, modelClass, modelId);
    await fireUsageHook(options.onUsage, usage, `${provider}.chatWithTools`);
    return {
      toolUses: r.rawCalls.map(parseToolUse),
      text: r.text,
      stopReason: r.finishReason,
      stopKind: finishReasonStopKind(r.finishReason),
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
    const modelId = modelFor(options.model, modelClass);
    const tools = toOpenAITools(options.tools);
    const maxIterations = Math.max(1, options.maxIterations ?? 5);

    const messages: unknown[] = baseMessages(options.systemPrompt, options.turns);
    const allToolUses: ToolUse[] = [];
    const allToolResults: ChatWithToolLoopResult['toolResults'] = [];
    const aggregate: TokenUsage = {
      provider,
      model: modelId,
      direction: modelClass,
      route,
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
        options.onRetry,
        options.abortSignal
      );
      aggregate.inputTokens += r.raw.inputTokens;
      aggregate.outputTokens += r.raw.outputTokens;
      aggregate.cacheReadInputTokens += r.raw.cachedInputTokens;
      await fireUsageHook(
        options.onUsage,
        shapeUsage(r.raw, modelClass, modelId),
        `${provider}.chatWithToolLoop`
      );
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
          content = collapseContentToText(provider, await options.executor(use));
        } catch (err) {
          // An UnsupportedContentBlockError from the executor (an image/document
          // block this provider cannot carry) becomes a named is_error
          // tool_result, same as every other executor failure and the same
          // rule mcp-bridge.ts already follows -- the model sees the named
          // refusal and the loop continues. An unsupported block in a USER
          // TURN the caller built is a different case (collapseContentToText
          // called outside this try/catch, on turn content) and still throws.
          content = err instanceof Error ? err.message : String(err);
          isError = true;
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content });
        allToolResults.push({ toolUseId: tc.id, content, isError });
      }
    }
    // Iteration cap hit while the model was still calling tools. One FINAL
    // no-tools call forces a written answer synthesised from the history,
    // instead of returning nothing. Degrade to empty text if it fails.
    throwIfAborted(options.abortSignal);
    try {
      const fin = await callWithRetries(
        () => createWithTools(client, modelId, messages, toOpenAITools([])),
        options.onRetry,
        options.abortSignal
      );
      aggregate.inputTokens += fin.raw.inputTokens;
      aggregate.outputTokens += fin.raw.outputTokens;
      aggregate.cacheReadInputTokens += fin.raw.cachedInputTokens;
      await fireUsageHook(
        options.onUsage,
        shapeUsage(fin.raw, modelClass, modelId),
        `${provider}.chatWithToolLoop`
      );
      return {
        text: fin.text,
        toolUses: allToolUses,
        toolResults: allToolResults,
        iterations: iteration,
        usage: aggregate,
      };
    } catch (err) {
      console.warn(`${provider}.chatWithToolLoop: final synthesis call failed`, err);
      return {
        text: '',
        toolUses: allToolUses,
        toolResults: allToolResults,
        iterations: iteration,
        usage: aggregate,
      };
    }
  }

  return { chat, chatWithTools, chatWithToolLoop };
}
