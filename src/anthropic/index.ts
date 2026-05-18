/**
 * @verevoir/llm/anthropic — Anthropic SDK adapter.
 *
 * Wraps `@anthropic-ai/sdk` in the provider-agnostic surface defined in
 * the core. Importing this subpath requires `@anthropic-ai/sdk` as a
 * peer dependency on the consumer.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ContentBlock,
  type ModelClass,
  type ProgressInfo,
  type RatesTable,
  type ToolDef,
  type ToolUse,
  type TokenUsage,
  type Turn,
  registerModelLabels,
} from '../index.js';

// ────────────────────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────────────────────

/** Provider id reported on every {@link TokenUsage} this adapter returns. */
export const PROVIDER = 'anthropic';

/**
 * Concrete model id per {@link ModelClass}. Callers pick the class
 * that fits the task; this map is the only place model ids appear, so
 * upgrades don't need to ripple through call sites.
 */
export const models: Readonly<Record<ModelClass, string>> = {
  reasoning: 'claude-opus-4-7',
  extraction: 'claude-haiku-4-5-20251001',
};

/**
 * Per-model pricing (USD per million tokens) — Anthropic-published
 * rates as of 2026-05-16.
 *
 * **Worst-case approach:** cache reads are billed by Anthropic at
 * roughly 10× cheaper than standard input, but the rate-tuple here is
 * the standard input rate. {@link estimateCostUSD} in the core
 * therefore returns an upper bound on the real bill. Refresh this
 * table when Anthropic publishes new pricing.
 *
 * Each rate-tuple is `[input_per_million_USD, output_per_million_USD]`.
 */
export const rates: RatesTable = {
  'claude-opus-4-7': [15, 75],
  'claude-haiku-4-5-20251001': [1, 5],
} as const;

// Register friendly labels for our models so the core's `modelLabel`
// helper returns "Opus" / "Haiku" without the consumer wiring them
// manually. Import side-effect; idempotent.
registerModelLabels({
  'claude-opus-4-7': 'Opus',
  'claude-haiku-4-5-20251001': 'Haiku',
});

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

let defaultClient: Anthropic | null = null;

function getDefaultClient(): Anthropic {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set and no per-call apiKey was passed.');
  }
  defaultClient = new Anthropic({ apiKey });
  return defaultClient;
}

function getClient(apiKey: string | null): Anthropic {
  if (apiKey) return new Anthropic({ apiKey });
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

function buildRequest({
  modelClass,
  systemPrompt,
  turns,
  tools,
}: {
  modelClass: ModelClass;
  systemPrompt: string;
  turns: Turn[];
  tools?: ToolDef[];
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    model: models[modelClass],
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text' as const,
        text: systemPrompt,
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: turns.map((t) => ({ role: t.role, content: t.content })),
  };
  if (tools && tools.length > 0) {
    base.tools = tools;
  }
  return base;
}

interface StreamedResult {
  text: string;
  toolUses: ToolUse[];
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
  for (const block of final.content) {
    if (block.type === 'text') {
      texts.push(block.text);
    } else if (block.type === 'tool_use' && block.name !== 'report_progress') {
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
// narrate the wait. Total budget ~22 min, comfortably under typical
// serverless request timeouts. Outages longer than this exhaust the
// budget and the underlying error surfaces.
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
  if (!hook) return;
  try {
    await hook(usage);
  } catch (err) {
    console.warn(`${scope}: onUsage callback threw`, err);
  }
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
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const request = buildRequest({
    modelClass,
    systemPrompt: options.systemPrompt,
    turns: options.turns,
    tools: options.onProgress ? [REPORT_PROGRESS_TOOL] : undefined,
  });

  const streamed = await callWithRetries(
    () => callStreamed(client, request, options.onProgress),
    options.onRetry
  );

  if (streamed.stopReason && streamed.stopReason !== 'end_turn') {
    console.warn(
      `anthropic.chat: response stop_reason=${streamed.stopReason} (model=${models[modelClass]}, output_tokens=${streamed.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(streamed.rawUsage, modelClass);
  await fireUsageHook(options.onUsage, usage, 'anthropic.chat');

  if (!streamed.text) {
    throw new Error(
      `anthropic.chat: response had no text content (stop_reason=${streamed.stopReason})`
    );
  }

  return {
    content: streamed.text,
    usage,
    stopReason: streamed.stopReason,
  };
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

    const request = buildRequest({
      modelClass,
      systemPrompt: options.systemPrompt,
      turns: messages,
      tools: augmentedTools,
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
