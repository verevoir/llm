/**
 * The Anthropic Messages implementation, shared by every route that speaks it:
 * request building, cache breakpoints, streaming, usage accounting and the tool
 * loop, with every request made under the library's one retry policy
 * (`../retry-policy.ts`). INTERNAL — not in the package `exports` map. A public subpath
 * supplies an {@link AnthropicTransport} (which client serves a call, and what
 * the call is reported as) and exports the three calls bound to it:
 * `./index.ts` for the direct API, `../vertex/index.ts` for Vertex AI.
 *
 * Nothing here constructs a client or reads a credential, and nothing here
 * knows how a route authenticated: whatever a route adds to a request because
 * of its credential comes from its transport. The SDK is imported for its types
 * only, and no route's client module is imported at all.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { fireUsageHook } from '../audit-hook.js';
import { spanInputTokensWithCache, withGenAISpan } from '../otel.js';
import { CATALOG } from './catalog.js';
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ContentBlock,
  type CredentialRoute,
  type ModelClass,
  type ProgressInfo,
  type ToolDef,
  type ToolUse,
  type TokenUsage,
  type Turn,
  EmptyResponseError,
} from '../index.js';
import { callWithRetries, throwIfAborted } from '../retry-policy.js';
import { anthropicStopKind } from './stop-kind.js';

/**
 * Concrete model id per {@link ModelClass}, derived from {@link CATALOG} — the
 * only place a call site needs. Upgrades happen in the catalog, not here.
 */
export const models: Readonly<Record<ModelClass, string>> = Object.fromEntries(
  CATALOG.filter((e) => e.modelClass).map((e) => [e.modelClass, e.currentId])
) as Record<ModelClass, string>;

// ────────────────────────────────────────────────────────────────────
// Transport — the one thing that differs between routes
// ────────────────────────────────────────────────────────────────────

/** The part of an SDK client this implementation drives. */
export type MessagesClient = { messages: Pick<Anthropic['messages'], 'stream'> };

/** A text block in a request's `system` array. */
export type SystemTextBlock = { type: 'text'; text: string };

/** The client for one call, and what the call is reported as. */
export interface ResolvedClient {
  client: MessagesClient;
  /** The credential mechanism, reported as {@link TokenUsage.route}. */
  route: CredentialRoute;
}

/** How one route reaches the Messages API. */
export interface AnthropicTransport {
  /** Reported as {@link TokenUsage.provider} and on the model span. */
  provider: string;
  /** The client for a call. Throws a plain error when the route is not
   * configured — before any request is built or sent. */
  resolveClient(perCallApiKey: string | null): ResolvedClient;
  /** The system blocks a request made on `resolved` must carry ahead of the
   * caller's system prompt, because of how that client authenticates. Asked
   * each time a request is built. A transport without one adds none. */
  systemPrefix?(resolved: ResolvedClient): readonly SystemTextBlock[];
  /** Asked once, when a call has failed for good. Returning true means the
   * transport has switched credential, and the call is made once more with a
   * freshly resolved client. A transport without one never re-resolves. */
  switchCredentialAfter?(
    failed: ResolvedClient,
    perCallApiKey: string | null,
    err: unknown
  ): boolean;
}

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

/** The provider's name in the reason `onRetry` is given, on every route. */
const RETRY_LABEL = 'Anthropic';

/**
 * Run a streamed model call on the transport's client, under the library's one
 * retry policy (`../retry-policy.ts`): the clients are built with the SDK's own
 * retries off, and nothing here retries or waits besides. `signal` is the
 * caller's `AbortSignal`, handed to the policy so that an abort ends a wait and
 * no further request is made. A request is one whole stream, and its result is
 * read only from a stream that completed ({@link callStreamed}), so a stream
 * that fails part-way contributes nothing to the answer of the retry.
 *
 * When the call fails for good, a transport that has a second credential to
 * move to ({@link AnthropicTransport.switchCredentialAfter} — the direct
 * route's OAuth→API-key fallback, in `./index.ts`) is asked once whether to
 * switch; if it does, the call is made once more. `makeRequest(systemPrefix)`
 * rebuilds the payload for the client actually used, with the system blocks the
 * transport asks for on that client ({@link AnthropicTransport.systemPrefix}),
 * so the second request is correctly shaped — not the first one replayed
 * against another credential.
 */
async function streamedCall(
  transport: AnthropicTransport,
  perCallApiKey: string | null,
  makeRequest: (systemPrefix: readonly SystemTextBlock[]) => Record<string, unknown>,
  onProgress?: (info: ProgressInfo) => Promise<void>,
  onRetry?: (info: ChatRetryInfo) => Promise<void>,
  signal?: AbortSignal
): Promise<StreamedResult & { route: CredentialRoute }> {
  const { provider } = transport;
  const prefixFor = (resolved: ResolvedClient) => transport.systemPrefix?.(resolved) ?? [];
  const first = transport.resolveClient(perCallApiKey);
  try {
    const result = await callWithRetries(
      () => callStreamed(provider, first.client, makeRequest(prefixFor(first)), onProgress),
      RETRY_LABEL,
      onRetry,
      signal
    );
    return { ...result, route: first.route };
  } catch (err) {
    if (!transport.switchCredentialAfter?.(first, perCallApiKey, err)) throw err;
    const fallback = transport.resolveClient(perCallApiKey);
    const result = await callWithRetries(
      () => callStreamed(provider, fallback.client, makeRequest(prefixFor(fallback)), onProgress),
      RETRY_LABEL,
      onRetry,
      signal
    );
    return { ...result, route: fallback.route };
  }
}

// 16384 is the next escalation after 8192 hit the cap on a real
// large-synthesis output. Anthropic Opus 4.7 supports 16k output
// tokens; raising the cap doesn't increase cost unless the response
// actually grows. This is the DEFAULT, not a ceiling on what a caller
// can ask for — a caller with its own evidence of needing more (e.g.
// aigency-governance's review panel, raised to 65536 after this exact
// default truncated four of five lenses on one real diff) can override
// it per call via ChatOptions.maxTokens, rather than every caller
// silently inheriting whatever number lives here.
const MAX_TOKENS = 16384;

// The `report_progress` tool, auto-injected when the caller provides
// `onProgress`. Description deliberately discourages over-use — the
// cost of too many narrations is chat noise, the cost of too few is
// silence.
const REPORT_PROGRESS_TOOL: ToolDef = {
  name: 'report_progress',
  description:
    'Report progress on a long-running task. Call 2-4 times during the work to keep the customer informed. percent should be 5-90 (not 0 or 100; the system handles those boundaries). message should be a short customer-facing status. Do NOT call on quick tasks or for final outputs — only mid-flight on substantive generation.',
  input_schema: {
    type: 'object',
    properties: {
      percent: {
        type: 'number',
        description: 'Progress percentage in the range 5-90.',
      },
      message: {
        type: 'string',
        description: 'Short customer-facing status message.',
      },
    },
    required: ['percent', 'message'],
  },
};

/** The `cache_control` value carried by every breakpoint in one request. */
type CacheControl = { type: 'ephemeral' };

/**
 * The breakpoint value for a call's {@link ChatOptions.cache} setting, or
 * `undefined` when the request carries no breakpoint at all.
 *
 * - `'none'` — no breakpoint: the request writes nothing to the cache.
 * - `'default'` / `'prefix'` / absent — a breakpoint with no lifetime field,
 *   which the provider reads as its default five-minute lifetime: long enough
 *   to span a tool loop's burst of correlated calls.
 *
 * Anything else (a value outside the type, from an untyped caller) is
 * treated as `'default'`. One value serves every breakpoint in a request.
 * Where the breakpoints go is {@link buildRequest}'s business: `'prefix'`
 * differs from `'default'` only in never getting one on the conversation.
 */
function cacheControlFor(cache: ChatOptions['cache']): CacheControl | undefined {
  return cache === 'none' ? undefined : { type: 'ephemeral' };
}

type WireMessage = { role: string; content: unknown };

/**
 * Attach a cache_control breakpoint to the last content block of the
 * last message, converting string content to a single text block so
 * the marker has somewhere to live.
 *
 * This is the conversation-prefix half of prompt caching, used by the
 * tool loop: each iteration re-sends a growing message history, so a
 * breakpoint at the end lets the *next* iteration read the prior
 * prefix from cache (~0.1× input cost) instead of reprocessing it at
 * full price. The system breakpoint already caches tools + system;
 * this caches the conversation that follows.
 *
 * Not used for single-shot `chat` / `chatWithTools`: there the last
 * block is the varying current question, so a breakpoint on it would
 * only write a cache entry that never gets read.
 */
function withConversationCacheBreakpoint(
  messages: WireMessage[],
  cacheControl: CacheControl
): WireMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  if (typeof last.content === 'string') {
    out[out.length - 1] = {
      ...last,
      content: [{ type: 'text', text: last.content, cache_control: cacheControl }],
    };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content;
    out[out.length - 1] = {
      ...last,
      content: blocks.map((block, i) =>
        i === blocks.length - 1 ? { ...(block as object), cache_control: cacheControl } : block
      ),
    };
  }
  return out;
}

function buildRequest({
  modelClass,
  systemPrompt,
  turns,
  tools,
  cacheConversation = false,
  cache,
  systemPrefix = [],
  model,
  maxTokens,
}: {
  modelClass: ModelClass;
  systemPrompt: string;
  turns: Turn[];
  tools?: ToolDef[];
  /** When true, place a cache_control breakpoint on the last message
   * block so a re-sent growing prefix (the tool loop) hits cache.
   * Default false — single-shot calls only benefit from the system /
   * tools breakpoint below. */
  cacheConversation?: boolean;
  /** Whether the request carries cache breakpoints — see
   * {@link ChatOptions.cache} and {@link cacheControlFor}.
   * `'none'` wins over `cacheConversation`: no breakpoint is placed
   * anywhere. `'prefix'` wins over it too: the system prompt keeps its
   * breakpoint and the conversation never gets one. */
  cache?: ChatOptions['cache'];
  /** System blocks sent ahead of the prompt block, as the transport supplied
   * them — see {@link AnthropicTransport.systemPrefix}. Default none. */
  systemPrefix?: readonly SystemTextBlock[];
  /** Exact model id to send, overriding the catalog's `models[modelClass]`
   * resolution — see {@link ChatOptions.model}'s own doc comment for why
   * this exists and when to reach for it. `undefined` uses the catalog. */
  model?: string;
  /** Overrides {@link MAX_TOKENS} for this call — see
   * {@link ChatOptions.maxTokens}. `undefined` uses the adapter default. */
  maxTokens?: number;
}): Record<string, unknown> {
  // Render order is tools → system → messages, so the breakpoint on
  // the (single) system block caches the tools + system prefix
  // together — no separate tool breakpoint needed.
  const messages: WireMessage[] = turns.map((t) => ({ role: t.role, content: t.content }));
  // Any transport-supplied blocks lead the system array; the cache breakpoint
  // stays on the prompt block, so the prefix and the prompt cache together.
  const cacheControl = cacheControlFor(cache);
  const promptBlock = cacheControl
    ? { type: 'text' as const, text: systemPrompt, cache_control: cacheControl }
    : { type: 'text' as const, text: systemPrompt };
  const base: Record<string, unknown> = {
    model: model ?? models[modelClass],
    max_tokens: maxTokens ?? MAX_TOKENS,
    system: [...systemPrefix, promptBlock],
    messages:
      cacheConversation && cacheControl && cache !== 'prefix'
        ? withConversationCacheBreakpoint(messages, cacheControl)
        : messages,
  };
  if (tools && tools.length > 0) {
    base.tools = tools;
  }
  return base;
}

interface StreamedResult {
  text: string;
  toolUses: ToolUse[];
  /** report_progress tool calls in this turn (kept separate from
   * `toolUses`, which is caller-executable tools only). Lets `chat`
   * acknowledge a progress-only turn and continue to the real answer
   * instead of failing with "no text content". */
  progressToolUses: { id: string; input: Record<string, unknown> }[];
  rawUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
    /** The extended-cache-TTL split, when Anthropic's beta reports it —
     * see {@link TokenUsage.cacheCreationEphemeral5mInputTokens}. */
    cacheCreationEphemeral5mInputTokens?: number;
    cacheCreationEphemeral1hInputTokens?: number;
  };
  stopReason: string;
  /** The message id (`msg_...`). The closest thing to a provider request id
   * this adapter can get: the streaming surface (`messages.stream`) doesn't
   * expose the raw HTTP response the way `.create().withResponse()` does,
   * so there's no `request-id` header reachable here. Real, just not a
   * header — see {@link TokenUsage.providerRequestId}. */
  responseId?: string;
}

/** The extended-cache-TTL breakdown Anthropic's beta usage shape carries as
 * `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens`. Not on
 * every SDK type version, hence the cast at the one call site that reads it. */
interface CacheCreationBreakdown {
  ephemeral_5m_input_tokens?: number;
  ephemeral_1h_input_tokens?: number;
}

async function callStreamed(
  provider: string,
  client: MessagesClient,
  request: Record<string, unknown>,
  onProgress?: (info: ProgressInfo) => Promise<void>
): Promise<StreamedResult> {
  const requestModel = typeof request.model === 'string' ? request.model : 'unknown';
  return withGenAISpan({ provider, requestModel }, async () => {
    // The cast goes through `unknown` because the SDK's MessageStreamParams
    // is a structural shape we can't match without pinning to its full
    // generic. `buildRequest` is the source of truth for valid payloads.
    const stream = client.messages.stream(
      request as unknown as Parameters<typeof client.messages.stream>[0]
    );

    if (onProgress) {
      stream.on('contentBlock', (block) => {
        if (block.type !== 'tool_use' || block.name !== 'report_progress') {
          return;
        }
        const input = block.input as { percent?: number; message?: string };
        const info: ProgressInfo = {
          percent: typeof input.percent === 'number' ? input.percent : 50,
          message: typeof input.message === 'string' ? input.message : '…',
        };
        void (async () => {
          try {
            await onProgress(info);
          } catch (err) {
            console.warn('callStreamed: onProgress callback threw', err);
          }
        })();
      });
    }

    const final = await stream.finalMessage();

    const texts: string[] = [];
    const toolUses: ToolUse[] = [];
    const progressToolUses: { id: string; input: Record<string, unknown> }[] = [];
    for (const block of final.content) {
      if (block.type === 'text') {
        texts.push(block.text);
      } else if (block.type === 'tool_use' && block.name === 'report_progress') {
        progressToolUses.push({
          id: block.id,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    // The SDK's stable Usage type has cache fields as `number | null`;
    // the beta variants have them as plain numbers. Null-coalesce to 0
    // either way so the rollup is well-formed.
    const u = final.usage;
    const cacheCreation = (u as unknown as { cache_creation?: CacheCreationBreakdown })
      .cache_creation;
    const result: StreamedResult = {
      text: texts.join('\n'),
      toolUses,
      progressToolUses,
      rawUsage: {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
        cacheCreationEphemeral5mInputTokens: cacheCreation?.ephemeral_5m_input_tokens,
        cacheCreationEphemeral1hInputTokens: cacheCreation?.ephemeral_1h_input_tokens,
      },
      stopReason: final.stop_reason ?? '',
      responseId: final.id,
    };

    return {
      result,
      outcome: {
        // providerRequestId: the request-id HTTP header isn't reachable here —
        // the Anthropic SDK's streaming surface (`messages.stream`) doesn't
        // expose the raw HTTP response the way `.create().withResponse()`
        // does. Falling back to the message id (`final.id`, same value as
        // `responseId`/gen_ai.response.id) as the next-best "the provider's
        // own id for this call" — real, just not the header.
        responseModel: final.model,
        responseId: final.id,
        providerRequestId: final.id,
        // Every input token, cached ones included: see spanInputTokensWithCache.
        inputTokens: spanInputTokensWithCache(
          u.input_tokens,
          u.cache_read_input_tokens,
          u.cache_creation_input_tokens
        ),
        // The provider's own values, not `rawUsage`'s zero-filled ones (src/otel.ts's header).
        outputTokens: u.output_tokens ?? undefined,
        cacheReadInputTokens: u.cache_read_input_tokens ?? undefined,
        cacheCreationInputTokens: u.cache_creation_input_tokens ?? undefined,
        cacheCreationEphemeral5mInputTokens: result.rawUsage.cacheCreationEphemeral5mInputTokens,
        cacheCreationEphemeral1hInputTokens: result.rawUsage.cacheCreationEphemeral1hInputTokens,
      },
    };
  });
}

function shapeUsage(
  provider: string,
  raw: StreamedResult['rawUsage'],
  direction: ModelClass,
  route: CredentialRoute,
  modelId: string,
  // Only chat()'s call sites pass this today — see chat()'s own call sites
  // for why chatWithTools / chatWithToolLoop don't yet report it.
  responseId?: string
): TokenUsage {
  return {
    provider,
    model: modelId,
    direction,
    route,
    ...raw,
    providerRequestId: responseId,
  };
}

/** Running token counts across the underlying calls of one public call. The
 * 5m/1h cache-write split stays `undefined` until a call actually reports
 * it — see {@link TokenUsage.cacheCreationEphemeral5mInputTokens}'s
 * "undefined when absent" contract: a sum defaulting to 0 would claim
 * "reported zero" for calls that never saw the field. */
type UsageCounts = StreamedResult['rawUsage'];

function emptyUsageCounts(): UsageCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationEphemeral5mInputTokens: undefined,
    cacheCreationEphemeral1hInputTokens: undefined,
  };
}

/** Add one call's counts into `total`, in place. */
function addUsageCounts(total: UsageCounts, call: UsageCounts): void {
  total.inputTokens += call.inputTokens;
  total.outputTokens += call.outputTokens;
  total.cacheCreationInputTokens += call.cacheCreationInputTokens;
  total.cacheReadInputTokens += call.cacheReadInputTokens;
  if (call.cacheCreationEphemeral5mInputTokens !== undefined) {
    total.cacheCreationEphemeral5mInputTokens =
      (total.cacheCreationEphemeral5mInputTokens ?? 0) + call.cacheCreationEphemeral5mInputTokens;
  }
  if (call.cacheCreationEphemeral1hInputTokens !== undefined) {
    total.cacheCreationEphemeral1hInputTokens =
      (total.cacheCreationEphemeral1hInputTokens ?? 0) + call.cacheCreationEphemeral1hInputTokens;
  }
}

/** Collapse the routes seen across an aggregated result's underlying calls to
 * one {@link CredentialRoute} — the single route if every call agreed, else
 * `'mixed'`, reported rather than picking one arbitrarily and hiding the
 * other. Never called with an empty array: every aggregate return site has
 * made at least one underlying call by the time it returns. */
function combineRoutes(routes: readonly CredentialRoute[]): CredentialRoute {
  const distinct = new Set(routes);
  return distinct.size === 1 ? routes[0] : 'mixed';
}

// ────────────────────────────────────────────────────────────────────
// The three calls, each taking the transport that serves it
// ────────────────────────────────────────────────────────────────────

/**
 * Single-shot LLM call. Streams the response, supports retry with
 * narration, BYOK, and live progress reporting via the auto-injected
 * `report_progress` tool when `onProgress` is set.
 */
export async function chat(
  transport: AnthropicTransport,
  options: ChatOptions
): Promise<ChatReply> {
  const scope = `${transport.provider}.chat`;
  if (options.turns.length === 0) {
    throw new Error(`${scope}() requires at least one turn`);
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  // See ChatOptions.model's doc comment: an explicit id wins over the
  // catalog's class resolution, so two transports pinned to the same
  // `model` answer with the same model regardless of what each one's
  // class table currently maps to.
  const modelId = options.model ?? models[modelClass];

  // A model given the report_progress tool (auto-injected when
  // onProgress is set) may end a turn having called ONLY that tool,
  // with no text yet — smaller models (Haiku) do this readily. That's
  // not a terminal state: acknowledge the progress call (feed a
  // tool_result back) and let the model continue to the actual answer,
  // rather than failing with "no text content". Cap the continuations
  // so a misbehaving model can't loop forever. Usage is summed across
  // the continuation calls; onUsage fires per call.
  const MAX_PROGRESS_CONTINUATIONS = 4;
  let messages: Turn[] = [...options.turns];
  const aggregate = emptyUsageCounts();
  const routesSeen: CredentialRoute[] = [];

  for (let attempt = 0; attempt <= MAX_PROGRESS_CONTINUATIONS; attempt++) {
    const streamed = await streamedCall(
      transport,
      options.apiKey ?? null,
      (systemPrefix) =>
        buildRequest({
          modelClass,
          systemPrompt: options.systemPrompt,
          turns: messages,
          tools: options.onProgress ? [REPORT_PROGRESS_TOOL] : undefined,
          // A continuation re-sends the growing history; cache its prefix.
          cacheConversation: attempt > 0,
          cache: options.cache,
          systemPrefix,
          model: options.model,
          maxTokens: options.maxTokens,
        }),
      options.onProgress,
      options.onRetry,
      options.abortSignal
    );
    routesSeen.push(streamed.route);

    addUsageCounts(aggregate, streamed.rawUsage);
    await fireUsageHook(
      options.onUsage,
      shapeUsage(
        transport.provider,
        streamed.rawUsage,
        modelClass,
        streamed.route,
        modelId,
        streamed.responseId
      ),
      scope
    );

    if (streamed.text) {
      if (streamed.stopReason && streamed.stopReason !== 'end_turn') {
        console.warn(
          `${scope}: response stop_reason=${streamed.stopReason} (model=${models[modelClass]}, output_tokens=${streamed.rawUsage.outputTokens})`
        );
      }
      return {
        content: streamed.text,
        usage: shapeUsage(
          transport.provider,
          aggregate,
          modelClass,
          combineRoutes(routesSeen),
          modelId,
          streamed.responseId
        ),
        stopReason: streamed.stopReason,
        stopKind: anthropicStopKind(streamed.stopReason),
      };
    }

    // No text. If the turn ended on a progress-only tool call and we
    // still have budget, acknowledge it and continue to the answer.
    if (
      streamed.stopReason === 'tool_use' &&
      streamed.progressToolUses.length > 0 &&
      attempt < MAX_PROGRESS_CONTINUATIONS
    ) {
      const assistantBlocks: ContentBlock[] = streamed.progressToolUses.map((p) => ({
        type: 'tool_use',
        id: p.id,
        name: 'report_progress',
        input: p.input,
      }));
      const toolResultBlocks: ContentBlock[] = streamed.progressToolUses.map((p) => ({
        type: 'tool_result',
        tool_use_id: p.id,
        content: 'ok',
      }));
      messages = [
        ...messages,
        { role: 'assistant', content: assistantBlocks },
        { role: 'user', content: toolResultBlocks },
      ];
      continue;
    }

    // No text and nothing to continue on — a genuinely empty response.
    throw new EmptyResponseError(
      `${scope}: response had no text content (stop_reason=${streamed.stopReason})`,
      { stopReason: streamed.stopReason, stopKind: anthropicStopKind(streamed.stopReason) }
    );
  }

  throw new Error(
    `${scope}: no text content after ${MAX_PROGRESS_CONTINUATIONS} progress continuations`
  );
}

/**
 * Tool-calling variant. The model decides which tools to invoke
 * against the supplied definitions; we surface every non-progress
 * tool_use to the caller for execution. Single-shot — no automated
 * multi-turn tool dance.
 */
export async function chatWithTools(
  transport: AnthropicTransport,
  options: ChatWithToolsOptions
): Promise<ChatWithToolsResult> {
  const scope = `${transport.provider}.chatWithTools`;
  if (options.turns.length === 0) {
    throw new Error(`${scope}() requires at least one turn`);
  }
  if (options.tools.length === 0) {
    throw new Error(`${scope}() requires at least one tool`);
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const modelId = options.model ?? models[modelClass];
  const augmentedTools = options.onProgress
    ? [...options.tools, REPORT_PROGRESS_TOOL]
    : options.tools;

  const streamed = await streamedCall(
    transport,
    options.apiKey ?? null,
    (systemPrefix) =>
      buildRequest({
        modelClass,
        systemPrompt: options.systemPrompt,
        turns: options.turns,
        tools: augmentedTools,
        cache: options.cache,
        systemPrefix,
        model: options.model,
        maxTokens: options.maxTokens,
      }),
    options.onProgress,
    options.onRetry,
    options.abortSignal
  );

  if (
    streamed.stopReason &&
    streamed.stopReason !== 'end_turn' &&
    streamed.stopReason !== 'tool_use'
  ) {
    console.warn(
      `${scope}: response stop_reason=${streamed.stopReason} (model=${modelId}, output_tokens=${streamed.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(
    transport.provider,
    streamed.rawUsage,
    modelClass,
    streamed.route,
    modelId
  );
  await fireUsageHook(options.onUsage, usage, scope);

  return {
    toolUses: streamed.toolUses,
    text: streamed.text,
    stopReason: streamed.stopReason,
    stopKind: anthropicStopKind(streamed.stopReason),
    usage,
  };
}

/**
 * Multi-turn tool-using chat. The caller supplies an executor; this
 * function runs the model → execute tools → feed results back loop
 * internally until the model produces a text-only response (or the
 * iteration cap fires).
 *
 * Each loop iteration is a full Anthropic call. Tool execution
 * happens between iterations; tool failures are surfaced to the model
 * as `tool_result` blocks with `is_error: true` so it can recover
 * (apologise, retry, switch approach) rather than the loop crashing.
 *
 * Usage and progress hooks fire per-iteration. Returned `usage` is
 * the sum across all iterations of the loop, so cost accounting at
 * the call site stays per-conversation-turn.
 */
export async function chatWithToolLoop(
  transport: AnthropicTransport,
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  const scope = `${transport.provider}.chatWithToolLoop`;
  if (options.turns.length === 0) {
    throw new Error(`${scope}() requires at least one turn`);
  }
  if (options.tools.length === 0) {
    throw new Error(`${scope}() requires at least one tool`);
  }
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const modelId = options.model ?? models[modelClass];
  const augmentedTools = options.onProgress
    ? [...options.tools, REPORT_PROGRESS_TOOL]
    : options.tools;
  const maxIterations = Math.max(1, options.maxIterations ?? 5);

  // Working message history: we append to this as the loop progresses.
  // The initial state mirrors what the consumer passed in.
  let messages: Turn[] = [...options.turns];

  const allToolUses: ToolUse[] = [];
  const allToolResults: ChatWithToolLoopResult['toolResults'] = [];
  const routesSeen: CredentialRoute[] = [];
  // Counts only — the full TokenUsage (provider/model/direction/route) is
  // built at each return site via shapeUsage, once the routes every
  // underlying call actually used are known.
  const aggregateUsage = emptyUsageCounts();

  let iteration = 0;
  while (iteration < maxIterations) {
    iteration += 1;

    // Abort check at the top of each iteration so the previous
    // iteration's onUsage / onIteration hook can abort cleanly via
    // its captured AbortController. The in-flight LLM call has
    // already settled and its tokens are recorded; what we prevent
    // is starting the NEXT iteration.
    throwIfAborted(options.abortSignal);

    const streamed = await streamedCall(
      transport,
      options.apiKey ?? null,
      (systemPrefix) =>
        buildRequest({
          modelClass,
          systemPrompt: options.systemPrompt,
          turns: messages,
          tools: augmentedTools,
          // Each iteration re-sends the growing history; a breakpoint on
          // the last message lets the next iteration read this prefix
          // from cache instead of reprocessing it.
          cacheConversation: true,
          cache: options.cache,
          systemPrefix,
          model: options.model,
          maxTokens: options.maxTokens,
        }),
      options.onProgress,
      options.onRetry,
      options.abortSignal
    );

    routesSeen.push(streamed.route);

    // Per-iteration usage hook + aggregate tally.
    const iterUsage = shapeUsage(
      transport.provider,
      streamed.rawUsage,
      modelClass,
      streamed.route,
      modelId
    );
    addUsageCounts(aggregateUsage, streamed.rawUsage);
    await fireUsageHook(options.onUsage, iterUsage, scope);

    if (options.onIteration) {
      try {
        await options.onIteration({
          iteration,
          toolUses: streamed.toolUses,
          stopReason: streamed.stopReason,
        });
      } catch (err) {
        console.warn('chatWithToolLoop: onIteration callback threw', err);
      }
    }

    // No more tools to call — we have the model's final answer.
    if (streamed.toolUses.length === 0) {
      return {
        text: streamed.text,
        toolUses: allToolUses,
        toolResults: allToolResults,
        iterations: iteration,
        usage: shapeUsage(
          transport.provider,
          aggregateUsage,
          modelClass,
          combineRoutes(routesSeen),
          modelId
        ),
      };
    }

    allToolUses.push(...streamed.toolUses);

    // Build the assistant content this iteration produced, including
    // both the text (if any) and the tool_use blocks. The next call
    // must include this verbatim so the model recognises the
    // tool_result blocks that follow.
    const assistantBlocks: ContentBlock[] = [];
    if (streamed.text) {
      assistantBlocks.push({ type: 'text', text: streamed.text });
    }
    for (const u of streamed.toolUses) {
      assistantBlocks.push({
        type: 'tool_use',
        id: u.id,
        name: u.name,
        input: u.input,
      });
    }

    // Execute each tool_use; collect tool_result blocks.
    const toolResultBlocks: ContentBlock[] = [];
    for (const use of streamed.toolUses) {
      // Never collapsed: this adapter's ContentBlock already mirrors
      // Anthropic's own wire shape, so an image/document block the
      // executor returns passes through unchanged into tool_result.content.
      let content: string | ContentBlock[];
      let isError = false;
      try {
        content = await options.executor(use);
      } catch (err) {
        content = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content,
        is_error: isError || undefined,
      });
      allToolResults.push({ toolUseId: use.id, content, isError });
    }

    // Append both sides to the working message history and loop.
    messages = [
      ...messages,
      { role: 'assistant', content: assistantBlocks },
      { role: 'user', content: toolResultBlocks },
    ];
  }

  // Iteration cap hit while the model was still calling tools. Rather than
  // return an empty answer (the model never wrote its final response), make
  // one FINAL call with the tools removed — forcing it to synthesise a written
  // answer from the history it built, instead of nothing. If this final call
  // itself fails, degrade to the empty text rather than throwing, unless the
  // caller has aborted: then the abort's error is thrown.
  throwIfAborted(options.abortSignal);
  try {
    const finalStreamed = await streamedCall(
      transport,
      options.apiKey ?? null,
      (systemPrefix) =>
        buildRequest({
          modelClass,
          systemPrompt: options.systemPrompt,
          turns: messages,
          tools: [], // no tools → the model must answer in text
          cacheConversation: true,
          cache: options.cache,
          systemPrefix,
          model: options.model,
          maxTokens: options.maxTokens,
        }),
      options.onProgress,
      options.onRetry,
      options.abortSignal
    );
    routesSeen.push(finalStreamed.route);
    const finalUsage = shapeUsage(
      transport.provider,
      finalStreamed.rawUsage,
      modelClass,
      finalStreamed.route,
      modelId
    );
    addUsageCounts(aggregateUsage, finalStreamed.rawUsage);
    await fireUsageHook(options.onUsage, finalUsage, scope);
    return {
      text: finalStreamed.text,
      toolUses: allToolUses,
      toolResults: allToolResults,
      iterations: iteration,
      usage: shapeUsage(
        transport.provider,
        aggregateUsage,
        modelClass,
        combineRoutes(routesSeen),
        modelId
      ),
    };
  } catch (err) {
    // An abort is the caller's, not a failure of the call: it is thrown.
    throwIfAborted(options.abortSignal);
    console.warn(`${scope}: final synthesis call failed`, err);
    return {
      text: '',
      toolUses: allToolUses,
      toolResults: allToolResults,
      iterations: iteration,
      usage: shapeUsage(
        transport.provider,
        aggregateUsage,
        modelClass,
        combineRoutes(routesSeen),
        modelId
      ),
    };
  }
}
