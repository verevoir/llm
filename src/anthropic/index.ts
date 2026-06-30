/**
 * @verevoir/llm/anthropic — Anthropic SDK adapter.
 *
 * Wraps `@anthropic-ai/sdk` in the provider-agnostic surface defined in
 * the core. Importing this subpath requires `@anthropic-ai/sdk` as a
 * peer dependency on the consumer.
 */

import Anthropic from '@anthropic-ai/sdk';
import { emitModelSpan } from '../audit-hook';
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ContentBlock,
  type ModelCatalogEntry,
  type ModelClass,
  type ProgressInfo,
  type RatesTable,
  type ToolDef,
  type ToolUse,
  type TokenUsage,
  type Turn,
  registerModelCatalog,
  registerProviderConnection,
  resolveBaseUrl,
} from '../index.js';

// ────────────────────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────────────────────

/** Provider id reported on every {@link TokenUsage} this adapter returns. */
export const PROVIDER = 'anthropic';

/**
 * The Anthropic model catalog — the **single source of truth**. Each family
 * declares the class it serves, the concrete versioned id used for the call,
 * its pricing (at the family level), a label, and the alias / prefix rules
 * that let any version of the family normalise back to it. `models`, `rates`
 * and the labels below all derive from this, so a version bump is a one-line
 * `currentId` change — and **decisions key on `provider/family`, never on the
 * version string** (the version is reporting metadata only).
 *
 * Pricing is Anthropic-published rates as of 2026-05-16; each tuple is
 * `[input_per_million_USD, output_per_million_USD]`. Refresh `rates` here when
 * Anthropic publishes new pricing.
 */
const CATALOG: readonly ModelCatalogEntry[] = [
  {
    provider: PROVIDER,
    family: 'opus',
    modelClass: 'reasoning',
    currentId: 'claude-opus-4-8',
    rates: [15, 75],
    label: 'Opus',
    aliases: ['claude-opus-4-7'],
    prefixes: ['claude-opus-'],
  },
  {
    provider: PROVIDER,
    family: 'sonnet',
    modelClass: 'drafting',
    currentId: 'claude-sonnet-4-6',
    rates: [3, 15],
    label: 'Sonnet',
    prefixes: ['claude-sonnet-'],
  },
  {
    provider: PROVIDER,
    family: 'haiku',
    modelClass: 'extraction',
    currentId: 'claude-haiku-4-5-20251001',
    rates: [1, 5],
    label: 'Haiku',
    aliases: ['claude-haiku-4-5'],
    prefixes: ['claude-haiku-'],
  },
];

// Register the catalog into the core so normalisation, family-level pricing,
// and labels work for any consumer (and any future version of these families).
// Import side-effect; idempotent. Also registers currentId + aliases as labels.
registerModelCatalog([...CATALOG]);

/**
 * Concrete model id per {@link ModelClass}, derived from {@link CATALOG} — the
 * only place a call site needs. Upgrades happen in the catalog, not here.
 */
export const models: Readonly<Record<ModelClass, string>> = Object.fromEntries(
  CATALOG.filter((e) => e.modelClass).map((e) => [e.modelClass, e.currentId])
) as Record<ModelClass, string>;

/**
 * Per-model pricing keyed by the concrete current id, derived from
 * {@link CATALOG}. Kept for back-compat with consumers that look pricing up by
 * exact id; the core's {@link estimateCostUSD} also falls back to the family
 * catalog, so a *new* version of a family prices even before this map lists it.
 */
export const rates: RatesTable = Object.fromEntries(CATALOG.map((e) => [e.currentId, e.rates]));

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

registerProviderConnection({
  provider: PROVIDER,
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  baseUrlEnv: 'ANTHROPIC_BASE_URL',
});

let defaultClient: Anthropic | null = null;

function getDefaultClient(): Anthropic {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set and no per-call apiKey was passed.');
  }
  defaultClient = new Anthropic({ apiKey, baseURL: resolveBaseUrl('ANTHROPIC_BASE_URL') });
  return defaultClient;
}

function getClient(apiKey: string | null): Anthropic {
  if (apiKey) return new Anthropic({ apiKey, baseURL: resolveBaseUrl('ANTHROPIC_BASE_URL') });
  return getDefaultClient();
}

// 16384 is the next escalation after 8192 hit the cap on a real
// large-synthesis output. Anthropic Opus 4.7 supports 16k output
// tokens; raising the cap doesn't increase cost unless the response
// actually grows.
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

// One ephemeral breakpoint shape, reused for every cache_control we
// place. 5-minute TTL (the default) — long enough to span a tool
// loop's burst of correlated calls.
const EPHEMERAL_CACHE = { type: 'ephemeral' as const };

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
function withConversationCacheBreakpoint(messages: WireMessage[]): WireMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  if (typeof last.content === 'string') {
    out[out.length - 1] = {
      ...last,
      content: [{ type: 'text', text: last.content, cache_control: EPHEMERAL_CACHE }],
    };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const blocks = last.content;
    out[out.length - 1] = {
      ...last,
      content: blocks.map((block, i) =>
        i === blocks.length - 1 ? { ...(block as object), cache_control: EPHEMERAL_CACHE } : block
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
}): Record<string, unknown> {
  // Render order is tools → system → messages, so the breakpoint on
  // the (single) system block caches the tools + system prefix
  // together — no separate tool breakpoint needed.
  const messages: WireMessage[] = turns.map((t) => ({ role: t.role, content: t.content }));
  const base: Record<string, unknown> = {
    model: models[modelClass],
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text' as const,
        text: systemPrompt,
        cache_control: EPHEMERAL_CACHE,
      },
    ],
    messages: cacheConversation ? withConversationCacheBreakpoint(messages) : messages,
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
  };
  stopReason: string;
}

async function callStreamed(
  client: Anthropic,
  request: Record<string, unknown>,
  onProgress?: (info: ProgressInfo) => Promise<void>
): Promise<StreamedResult> {
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
  return {
    text: texts.join('\n'),
    toolUses,
    progressToolUses,
    rawUsage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    },
    stopReason: final.stop_reason ?? '',
  };
}

// Anthropic outages of ~1 hour are real. Single-shot retry isn't
// enough — keep trying with exponential backoff so the caller can
// narrate the wait. Total budget ~2 min, comfortably under typical
// serverless request timeouts. Outages longer than this exhaust the
// budget and the underlying error surfaces.
const RETRY_BACKOFFS_MS = [
  5_000, //   5 sec
  30_000, //  30 sec
  120_000, // 2 min
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
  if (status === 529 || /\b529\b|overloaded_error/i.test(message)) {
    return 'Anthropic overloaded (529)';
  }
  if (status === 503 || /\b503\b|service[_ ]unavailable/i.test(message)) {
    return 'Anthropic service unavailable (503)';
  }
  if (status === 500 || /\b500\b|internal_server_error/i.test(message)) {
    return 'Anthropic internal error (500)';
  }
  if (status === 429 || /\b429\b|rate[_ ]limit/i.test(message)) {
    return 'Anthropic rate-limited (429)';
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shapeUsage(raw: StreamedResult['rawUsage'], direction: ModelClass): TokenUsage {
  return {
    provider: PROVIDER,
    model: models[direction],
    direction,
    ...raw,
  };
}

async function fireUsageHook(
  hook: ChatOptions['onUsage'],
  usage: TokenUsage,
  scope: string
): Promise<void> {
  // Emit the model-span first, independent of the caller's onUsage: the audit
  // sink (STDIO-500) must see EVERY model call, including inline coordinator
  // turns whose caller passes no onUsage. No-op unless a sink is registered.
  emitModelSpan({ ...usage, scope });
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
 * Single-shot LLM call. Streams the response, supports retry with
 * narration, BYOK, and live progress reporting via the auto-injected
 * `report_progress` tool when `onProgress` is set.
 */
export async function chat(options: ChatOptions): Promise<ChatReply> {
  if (options.turns.length === 0) {
    throw new Error('anthropic.chat() requires at least one turn');
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);

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
  const aggregate = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  for (let attempt = 0; attempt <= MAX_PROGRESS_CONTINUATIONS; attempt++) {
    const request = buildRequest({
      modelClass,
      systemPrompt: options.systemPrompt,
      turns: messages,
      tools: options.onProgress ? [REPORT_PROGRESS_TOOL] : undefined,
      // A continuation re-sends the growing history; cache its prefix.
      cacheConversation: attempt > 0,
    });

    const streamed = await callWithRetries(
      () => callStreamed(client, request, options.onProgress),
      options.onRetry
    );

    aggregate.inputTokens += streamed.rawUsage.inputTokens;
    aggregate.outputTokens += streamed.rawUsage.outputTokens;
    aggregate.cacheCreationInputTokens += streamed.rawUsage.cacheCreationInputTokens;
    aggregate.cacheReadInputTokens += streamed.rawUsage.cacheReadInputTokens;
    await fireUsageHook(
      options.onUsage,
      shapeUsage(streamed.rawUsage, modelClass),
      'anthropic.chat'
    );

    if (streamed.text) {
      if (streamed.stopReason && streamed.stopReason !== 'end_turn') {
        console.warn(
          `anthropic.chat: response stop_reason=${streamed.stopReason} (model=${models[modelClass]}, output_tokens=${streamed.rawUsage.outputTokens})`
        );
      }
      return {
        content: streamed.text,
        usage: shapeUsage(aggregate, modelClass),
        stopReason: streamed.stopReason,
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
    throw new Error(
      `anthropic.chat: response had no text content (stop_reason=${streamed.stopReason})`
    );
  }

  throw new Error(
    `anthropic.chat: no text content after ${MAX_PROGRESS_CONTINUATIONS} progress continuations`
  );
}

/**
 * Tool-calling variant. The model decides which tools to invoke
 * against the supplied definitions; we surface every non-progress
 * tool_use to the caller for execution. Single-shot — no automated
 * multi-turn tool dance.
 */
export async function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  if (options.turns.length === 0) {
    throw new Error('anthropic.chatWithTools() requires at least one turn');
  }
  if (options.tools.length === 0) {
    throw new Error('anthropic.chatWithTools() requires at least one tool');
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const augmentedTools = options.onProgress
    ? [...options.tools, REPORT_PROGRESS_TOOL]
    : options.tools;
  const request = buildRequest({
    modelClass,
    systemPrompt: options.systemPrompt,
    turns: options.turns,
    tools: augmentedTools,
  });

  const streamed = await callWithRetries(
    () => callStreamed(client, request, options.onProgress),
    options.onRetry
  );

  if (
    streamed.stopReason &&
    streamed.stopReason !== 'end_turn' &&
    streamed.stopReason !== 'tool_use'
  ) {
    console.warn(
      `anthropic.chatWithTools: response stop_reason=${streamed.stopReason} (model=${models[modelClass]}, output_tokens=${streamed.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(streamed.rawUsage, modelClass);
  await fireUsageHook(options.onUsage, usage, 'anthropic.chatWithTools');

  return {
    toolUses: streamed.toolUses,
    text: streamed.text,
    stopReason: streamed.stopReason,
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
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  if (options.turns.length === 0) {
    throw new Error('anthropic.chatWithToolLoop() requires at least one turn');
  }
  if (options.tools.length === 0) {
    throw new Error('anthropic.chatWithToolLoop() requires at least one tool');
  }
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const augmentedTools = options.onProgress
    ? [...options.tools, REPORT_PROGRESS_TOOL]
    : options.tools;
  const maxIterations = Math.max(1, options.maxIterations ?? 5);

  // Working message history: we append to this as the loop progresses.
  // The initial state mirrors what the consumer passed in.
  let messages: Turn[] = [...options.turns];

  const allToolUses: ToolUse[] = [];
  const allToolResults: ChatWithToolLoopResult['toolResults'] = [];
  const aggregateUsage: TokenUsage = {
    provider: PROVIDER,
    model: models[modelClass],
    direction: modelClass,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  let iteration = 0;
  while (iteration < maxIterations) {
    iteration += 1;

    // Abort check at the top of each iteration so the previous
    // iteration's onUsage / onIteration hook can abort cleanly via
    // its captured AbortController. The in-flight LLM call has
    // already settled and its tokens are recorded; what we prevent
    // is starting the NEXT iteration.
    throwIfAborted(options.abortSignal);

    const request = buildRequest({
      modelClass,
      systemPrompt: options.systemPrompt,
      turns: messages,
      tools: augmentedTools,
      // Each iteration re-sends the growing history; a breakpoint on
      // the last message lets the next iteration read this prefix
      // from cache instead of reprocessing it.
      cacheConversation: true,
    });

    const streamed = await callWithRetries(
      () => callStreamed(client, request, options.onProgress),
      options.onRetry
    );

    // Per-iteration usage hook + aggregate tally.
    const iterUsage = shapeUsage(streamed.rawUsage, modelClass);
    aggregateUsage.inputTokens += iterUsage.inputTokens;
    aggregateUsage.outputTokens += iterUsage.outputTokens;
    aggregateUsage.cacheCreationInputTokens += iterUsage.cacheCreationInputTokens;
    aggregateUsage.cacheReadInputTokens += iterUsage.cacheReadInputTokens;
    await fireUsageHook(options.onUsage, iterUsage, 'anthropic.chatWithToolLoop');

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
        usage: aggregateUsage,
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
      let content: string;
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

  // Iteration cap hit. Return what we have so the consumer can
  // narrate progress; the text may be empty if the model never got
  // to a final response.
  return {
    text: '',
    toolUses: allToolUses,
    toolResults: allToolResults,
    iterations: iteration,
    usage: aggregateUsage,
  };
}

/**
 * Namespaced re-export for callers that prefer the namespace form
 * (`anthropic.chat(...)`) over named imports.
 */
export const anthropic = {
  PROVIDER,
  models,
  rates,
  chat,
  chatWithTools,
  chatWithToolLoop,
};
