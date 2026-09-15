/**
 * @verevoir/llm/openai — OpenAI SDK adapter.
 *
 * Wraps the official `openai` package via the Responses API (the
 * post-Chat-Completions canonical surface). Importing this subpath
 * requires `openai` as a peer dependency on the consumer.
 *
 * Ships `chat()`, `chatWithTools()` and `chatWithToolLoop()`. The tool-calling
 * pair is a bespoke implementation on the Responses API's own `tools` /
 * `function_call` / `function_call_output` shape — NOT the shared
 * `createOpenAICompatAdapter` factory `/deepseek`, `/samba` and `/mistral` are
 * built from, because that factory speaks OpenAI's older Chat Completions API
 * (`chat.completions.create`) and this adapter deliberately speaks the newer
 * Responses API instead (see the `chat()` doc comment above this one, carried
 * from 0.5.0). The two APIs' tool shapes are not interchangeable: Chat
 * Completions nests a function under `{type:'function', function:{name,...}}`
 * and reads `tool_calls` off the response; Responses declares a flat
 * `{type:'function', name,...}` and reads `function_call` items off
 * `response.output`, correlated by `call_id` rather than Chat Completions'
 * `id`. Semantics (real tool-call ids, cap-hit finalise-without-tools) match
 * the factory and every other adapter regardless of the wire-shape
 * difference — see the tool-calling section below for where that's done.
 */

import OpenAI from 'openai';
import { fireUsageHook } from '../audit-hook.js';
import {
  type ChatOptions,
  type ChatReply,
  type ChatRetryInfo,
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ModelClass,
  type RatesTable,
  type ToolDef,
  type ToolUse,
  type TokenUsage,
  registerModelLabels,
  registerProviderConnection,
  resolveBaseUrl,
  localEndpointKey,
} from '../index.js';

// ────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────

registerProviderConnection({
  provider: PROVIDER,
  apiKeyEnv: 'OPENAI_API_KEY',
  baseUrlEnv: 'OPENAI_BASE_URL',
  defaultBaseUrl: 'https://api.openai.com/v1',
  // The generic OpenAI-compatible client: a base-URL override can point it at a
  // keyless local server (LM Studio / Ollama / vLLM), so it's usable key-free.
  keylessCapable: true,
});

let defaultClient: OpenAI | null = null;

function getDefaultClient(): OpenAI {
  if (defaultClient) return defaultClient;
  const apiKey = process.env.OPENAI_API_KEY || localEndpointKey('OPENAI_BASE_URL');
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set and no per-call apiKey was passed.');
  }
  defaultClient = new OpenAI({ apiKey, baseURL: resolveBaseUrl('OPENAI_BASE_URL') });
  return defaultClient;
}

function getClient(apiKey: string | null): OpenAI {
  if (apiKey) return new OpenAI({ apiKey, baseURL: resolveBaseUrl('OPENAI_BASE_URL') });
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

/** Turn our provider-agnostic `Turn[]` into Responses-API `input` items —
 * `{role, content}`, 'assistant' / 'user' passed through unchanged. Shared by
 * `chat()` and the tool-calling entry points below so the mapping stays in
 * one place. */
function turnsToItems(
  turns: ChatOptions['turns']
): { role: 'user' | 'assistant'; content: string }[] {
  return turns.map((t) => ({
    role: t.role as 'user' | 'assistant',
    content: t.content as string,
  }));
}

async function callResponsesCreate(
  client: OpenAI,
  modelId: string,
  systemPrompt: string,
  turns: ChatOptions['turns']
): Promise<RawResult> {
  // The Responses API takes `instructions` (system) + `input` (the
  // conversation). 'assistant' / 'user' roles pass through unchanged.
  const input = turnsToItems(turns);

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
// so retry-narration messages stay informative across providers. Capped at 3
// retries (~2 min total).
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

// ────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────

/**
 * Single-shot text generation via the OpenAI Responses API. Same
 * surface as the Anthropic + Google adapters' `chat()`: pass turns
 * + systemPrompt, get `{ content, usage, stopReason }` back. Retry
 * on transient errors with caller-visible narration via `onRetry`.
 *
 * `onProgress` is not read here — still Anthropic-only across this whole
 * package; see the `report_progress` auto-injection in `/anthropic` and the
 * package-level note that no other route reads this field.
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

// ────────────────────────────────────────────────────
// Tool calling — Responses API shape (STDIO-342 parity for /openai)
// ────────────────────────────────────────────────────
//
// The Responses API declares a function tool FLAT — `{type:'function', name,
// description, parameters}` — unlike Chat Completions' `{type:'function',
// function:{name,...}}` nesting the factory uses. A tool call arrives as a
// `function_call` item on `response.output` (not a `tool_calls` array on a
// message), carrying its own `call_id` — the value that must be echoed back
// on the matching `function_call_output` item. That `call_id` is this
// adapter's ToolUse.id: the provider's own correlation key, never a
// name-derived fallback (see Gemini's `id: f.id ?? f.name`, which collides
// when two parallel calls to the same tool name land in one turn — #47).
//
// Conversation state is managed by this adapter, not `previous_response_id` —
// each call resends the full `input` array, the same stateless-history
// convention `chat()` and every other adapter already follow, rather than
// leaning on OpenAI's server-side conversation storage.

/** One function-call item read off `response.output`. */
interface OpenAIFunctionCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
}

function isFunctionCallItem(item: unknown): item is OpenAIFunctionCall {
  return (
    !!item &&
    typeof item === 'object' &&
    (item as { type?: unknown }).type === 'function_call' &&
    typeof (item as { call_id?: unknown }).call_id === 'string' &&
    typeof (item as { name?: unknown }).name === 'string'
  );
}

function toResponsesTools(tools: ToolDef[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

function parseToolUse(fc: OpenAIFunctionCall): ToolUse {
  let input: Record<string, unknown> = {};
  try {
    input = fc.arguments ? (JSON.parse(fc.arguments) as Record<string, unknown>) : {};
  } catch {
    input = { _raw: fc.arguments };
  }
  return { id: fc.call_id, name: fc.name, input };
}

interface ResponsesToolResult {
  text: string;
  rawCalls: OpenAIFunctionCall[];
  /** The full `response.output` array, verbatim — pushed onto the next
   * call's `input` so the model's own function_call items line up against
   * the `function_call_output` items that follow them. */
  outputItems: unknown[];
  raw: RawResult['rawUsage'];
  status: string;
}

// One tool-enabled Responses call: assistant text + the function calls it
// emitted + usage. `tools` omitted (not sent as `[]`) on a no-tools finalise
// call, matching the factory's + Gemini's convention for the same case.
async function createWithTools(
  client: OpenAI,
  modelId: string,
  systemPrompt: string,
  items: unknown[],
  tools: ReturnType<typeof toResponsesTools>
): Promise<ResponsesToolResult> {
  const response = await client.responses.create({
    model: modelId,
    instructions: systemPrompt,
    input: items as never,
    tools: tools.length > 0 ? (tools as never) : undefined,
  });
  const outputItems = (response.output ?? []) as unknown[];
  const u = response.usage;
  return {
    text: response.output_text ?? '',
    rawCalls: outputItems.filter(isFunctionCallItem),
    outputItems,
    raw: {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cachedInputTokens: u?.input_tokens_details?.cached_tokens ?? 0,
    },
    status: response.status ?? '',
  };
}

/** Single-shot tool-calling: surface the model's function calls for the
 * caller to execute (no automated loop). Mirrors the Anthropic adapter's
 * chatWithTools and the OpenAI-compatible factory's chatWithTools. */
export async function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  if (options.turns.length === 0) {
    throw new Error('openai.chatWithTools() requires at least one turn');
  }
  if (options.tools.length === 0) {
    throw new Error('openai.chatWithTools() requires at least one tool');
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const modelId = models[modelClass];
  const tools = toResponsesTools(options.tools);

  const r = await callWithRetries(
    () =>
      createWithTools(client, modelId, options.systemPrompt, turnsToItems(options.turns), tools),
    options.onRetry
  );
  const usage = shapeUsage(r.raw, modelClass);
  await fireUsageHook(options.onUsage, usage, 'openai.chatWithTools');
  return {
    toolUses: r.rawCalls.map(parseToolUse),
    text: r.text,
    stopReason: r.status,
    usage,
  };
}

/** Multi-turn tool loop: model → execute tools → feed function_call_output
 * items back, until the model returns a call-free reply (or maxIterations).
 * Mirrors the Anthropic adapter's chatWithToolLoop, in Responses-API shape.
 * On cap-hit, one final no-tools call forces a written answer synthesised
 * from the history — matching Anthropic, Gemini, and the OpenAI-compatible
 * factory — rather than returning nothing. */
export async function chatWithToolLoop(
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  if (options.turns.length === 0) {
    throw new Error('openai.chatWithToolLoop() requires at least one turn');
  }
  if (options.tools.length === 0) {
    throw new Error('openai.chatWithToolLoop() requires at least one tool');
  }
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const modelId = models[modelClass];
  const tools = toResponsesTools(options.tools);
  const maxIterations = Math.max(1, options.maxIterations ?? 5);

  const items: unknown[] = turnsToItems(options.turns);
  const allToolUses: ToolUse[] = [];
  const allToolResults: ChatWithToolLoopResult['toolResults'] = [];
  const aggregate: TokenUsage = {
    provider: PROVIDER,
    model: modelId,
    direction: modelClass,
    // Single credential mechanism — see shapeUsage's comment above.
    route: 'api-key',
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
      () => createWithTools(client, modelId, options.systemPrompt, items, tools),
      options.onRetry
    );
    aggregate.inputTokens += r.raw.inputTokens;
    aggregate.outputTokens += r.raw.outputTokens;
    aggregate.cacheReadInputTokens += r.raw.cachedInputTokens;
    await fireUsageHook(options.onUsage, shapeUsage(r.raw, modelClass), 'openai.chatWithToolLoop');
    if (options.onIteration) {
      try {
        await options.onIteration({
          iteration,
          toolUses: r.rawCalls.map(parseToolUse),
          stopReason: r.status,
        });
      } catch (err) {
        console.warn('openai.chatWithToolLoop: onIteration threw', err);
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
    // Append the model's output items verbatim (the function_call items plus
    // any message/reasoning items alongside them) so the follow-up
    // function_call_output items line up against the call_ids the model
    // actually emitted this turn — mirrors the factory pushing the assistant
    // tool_calls turn verbatim before its tool results.
    items.push(...r.outputItems);
    for (const fc of r.rawCalls) {
      const use = parseToolUse(fc);
      allToolUses.push(use);
      let content: string;
      let isError = false;
      try {
        content = await options.executor(use);
      } catch (err) {
        content = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      // TOOL OUTPUT RE-ENTERS MODEL CONTEXT HERE: `content` — the executor's
      // return value, which may carry untrusted data the tool itself fetched
      // (a file, a search result, another service's response) — is pushed
      // verbatim into `items` and sent back to the model on the next
      // iteration's `input`. No sanitisation happens at this layer; noted for
      // the prompt-injection sweep, not defended against here.
      items.push({ type: 'function_call_output', call_id: fc.call_id, output: content });
      allToolResults.push({ toolUseId: use.id, content, isError });
    }
  }
  // Iteration cap hit while the model was still calling tools. One FINAL
  // no-tools call forces a written answer synthesised from the history,
  // instead of returning nothing. Degrade to empty text if it fails.
  throwIfAborted(options.abortSignal);
  try {
    const fin = await callWithRetries(
      () => createWithTools(client, modelId, options.systemPrompt, items, toResponsesTools([])),
      options.onRetry
    );
    aggregate.inputTokens += fin.raw.inputTokens;
    aggregate.outputTokens += fin.raw.outputTokens;
    aggregate.cacheReadInputTokens += fin.raw.cachedInputTokens;
    await fireUsageHook(
      options.onUsage,
      shapeUsage(fin.raw, modelClass),
      'openai.chatWithToolLoop'
    );
    return {
      text: fin.text,
      toolUses: allToolUses,
      toolResults: allToolResults,
      iterations: iteration,
      usage: aggregate,
    };
  } catch (err) {
    console.warn('openai.chatWithToolLoop: final synthesis call failed', err);
    return {
      text: '',
      toolUses: allToolUses,
      toolResults: allToolResults,
      iterations: iteration,
      usage: aggregate,
    };
  }
}
