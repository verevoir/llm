/**
 * @verevoir/llm/google — Google Gemini SDK adapter.
 *
 * Wraps `@google/genai` in the provider-agnostic surface defined in the
 * core. Importing this subpath requires `@google/genai` as a peer
 * dependency on the consumer.
 *
 * v0.4.0 ships `chat()` only — single-shot text generation. The
 * materialiser-style paths (review-repo, doc-piece, conversation-doc)
 * use just this. `chatWithTools()` and `chatWithToolLoop()` follow in
 * a subsequent release.
 */

import { GoogleGenAI } from '@google/genai';
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

// ────────────────────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────────────────────

/** Provider id reported on every {@link TokenUsage} this adapter returns. */
export const PROVIDER = 'google';

/**
 * Concrete model id per {@link ModelClass}. Reasoning maps to the
 * most-capable Pro tier; extraction maps to Flash, which Google
 * positions for fast/cheap structured tasks.
 *
 * As of 2026-05-20 we use 2.5-family identifiers (current general
 * availability); upgrades happen here only, no ripple through callers.
 */
export const models: Readonly<Record<ModelClass, string>> = {
  reasoning: 'gemini-2.5-pro',
  // No distinct mid tier on Gemini today — drafting resolves up to the
  // reasoning model (the tier fallback ladder, frozen statically).
  drafting: 'gemini-2.5-pro',
  extraction: 'gemini-2.5-flash',
};

/**
 * Per-model pricing (USD per million tokens) — Google-published rates
 * as of 2026-05-20.
 *
 * **Worst-case approach:** same convention as the Anthropic adapter —
 * cached input is billed cheaper than standard but the rate-tuple
 * here is the standard input rate, so {@link estimateCostUSD} returns
 * an upper bound. Refresh this table when Google publishes new
 * pricing.
 *
 * Each rate-tuple is `[input_per_million_USD, output_per_million_USD]`.
 */
export const rates: RatesTable = {
  'gemini-2.5-pro': [1.25, 10],
  'gemini-2.5-flash': [0.3, 2.5],
} as const;

// Register friendly labels for our models so the core's `modelLabel`
// helper returns "Gemini Pro" / "Gemini Flash" without the consumer
// wiring them manually. Import side-effect; idempotent.
registerModelLabels({
  'gemini-2.5-pro': 'Gemini Pro',
  'gemini-2.5-flash': 'Gemini Flash',
});

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

registerProviderConnection({
  provider: PROVIDER,
  apiKeyEnv: 'GEMINI_API_KEY',
  baseUrlEnv: 'GEMINI_BASE_URL',
});

let defaultClient: GoogleGenAI | null = null;

function getDefaultClient(): GoogleGenAI {
  if (defaultClient) return defaultClient;
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    localEndpointKey('GEMINI_BASE_URL') ||
    localEndpointKey('GOOGLE_BASE_URL');
  if (!apiKey) {
    throw new Error(
      'Neither GEMINI_API_KEY nor GOOGLE_API_KEY is set and no per-call apiKey was passed.'
    );
  }
  const baseUrl = resolveBaseUrl('GEMINI_BASE_URL') ?? resolveBaseUrl('GOOGLE_BASE_URL');
  defaultClient = new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  return defaultClient;
}

function getClient(apiKey: string | null): GoogleGenAI {
  if (apiKey) {
    const baseUrl = resolveBaseUrl('GEMINI_BASE_URL') ?? resolveBaseUrl('GOOGLE_BASE_URL');
    return new GoogleGenAI({ apiKey, ...(baseUrl ? { httpOptions: { baseUrl } } : {}) });
  }
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

async function callGenerateContent(
  client: GoogleGenAI,
  modelId: string,
  systemPrompt: string,
  turns: ChatOptions['turns']
): Promise<RawResult> {
  // Gemini doesn't use a separate `messages` channel; we feed turns
  // as a `contents` array of {role, parts}. User and model alternate;
  // 'assistant' in our surface maps to 'model' in Gemini.
  const contents = turns.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content as string }],
  }));

  const response = await client.models.generateContent({
    model: modelId,
    contents,
    config: {
      systemInstruction: systemPrompt,
    },
  });

  const text = response.text ?? '';
  const u = response.usageMetadata ?? {};
  const candidates = response.candidates ?? [];
  const finishReason = candidates[0]?.finishReason ?? '';

  return {
    text,
    rawUsage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      cachedInputTokens: u.cachedContentTokenCount ?? 0,
    },
    finishReason: String(finishReason),
  };
}

// Google outages and rate limits are handled with the same exponential-
// backoff shape as the Anthropic adapter. The reason strings are
// google-specific so customers reading retry-narration messages can
// tell which provider is unavailable.
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
    return 'Google service unavailable (503)';
  }
  if (status === 500 || /\b500\b|internal_server_error/i.test(message)) {
    return 'Google internal error (500)';
  }
  if (status === 429 || /\b429\b|rate[_ ]limit|RESOURCE_EXHAUSTED/i.test(message)) {
    return 'Google rate-limited (429)';
  }
  if (/UNAVAILABLE|DEADLINE_EXCEEDED/i.test(message)) {
    return 'Google transient error (gRPC)';
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
    // Matches the Anthropic adapter's convention.
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
 * Single-shot text generation via the Gemini API. Same surface as the
 * Anthropic adapter's `chat()`: pass turns + systemPrompt, get
 * `{ content, usage, stopReason }` back. Retry on transient errors
 * with caller-visible narration via `onRetry`.
 *
 * Not yet supported in this adapter (planned follow-up): live progress
 * narration via `onProgress` (Gemini's streaming + tool semantics need
 * a different shape from Anthropic's report_progress pattern).
 */
export async function chat(options: ChatOptions): Promise<ChatReply> {
  if (options.turns.length === 0) {
    throw new Error('google.chat() requires at least one turn');
  }
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const modelId = models[modelClass];

  const raw = await callWithRetries(
    () => callGenerateContent(client, modelId, options.systemPrompt, options.turns),
    options.onRetry
  );

  if (raw.finishReason && raw.finishReason !== 'STOP') {
    console.warn(
      `google.chat: response finish_reason=${raw.finishReason} (model=${modelId}, output_tokens=${raw.rawUsage.outputTokens})`
    );
  }

  const usage = shapeUsage(raw.rawUsage, modelClass);
  await fireUsageHook(options.onUsage, usage, 'google.chat');

  if (!raw.text) {
    throw new Error(
      `google.chat: response had no text content (finish_reason=${raw.finishReason})`
    );
  }

  return {
    content: raw.text,
    usage,
    stopReason: raw.finishReason,
  };
}

// ────────────────────────────────────────────────────────────────────
// Tool calling (STDIO-342)
// ────────────────────────────────────────────────────────────────────
//
// Gemini's function calling: declare functions in `config.tools`, read
// `response.functionCalls` back, and feed results in as `functionResponse`
// parts. Schema `type` is an uppercase `Type` enum (STRING / OBJECT / …), so we
// uppercase our JSON-schema types.

type GeminiContent = { role: string; parts: unknown[] };

/** Convert a JSON-schema-ish object to Gemini's Schema shape (uppercase types). */
function toGeminiSchema(s: unknown): unknown {
  if (!s || typeof s !== 'object') return s;
  const src = s as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };
  if (typeof out.type === 'string') out.type = (out.type as string).toUpperCase();
  if (out.properties && typeof out.properties === 'object') {
    out.properties = Object.fromEntries(
      Object.entries(out.properties as Record<string, unknown>).map(([k, v]) => [
        k,
        toGeminiSchema(v),
      ])
    );
  }
  if (out.items) out.items = toGeminiSchema(out.items);
  return out;
}

function toGeminiTools(tools: ToolDef[]) {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toGeminiSchema(t.input_schema),
      })),
    },
  ];
}

function turnsToContents(turns: ChatOptions['turns']): GeminiContent[] {
  return turns.map((t) => ({
    role: t.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: t.content as string }],
  }));
}

interface GeminiToolResult {
  text: string;
  functionCalls: { id?: string; name: string; args: Record<string, unknown> }[];
  /** The model's content turn (with functionCall parts), to append in the loop. */
  modelContent: GeminiContent | null;
  rawUsage: RawResult['rawUsage'];
  finishReason: string;
}

async function callGenerateWithTools(
  client: GoogleGenAI,
  modelId: string,
  systemPrompt: string,
  contents: GeminiContent[],
  tools: ReturnType<typeof toGeminiTools>
): Promise<GeminiToolResult> {
  const response = await client.models.generateContent({
    model: modelId,
    contents: contents as never,
    config: { systemInstruction: systemPrompt, tools: tools as never },
  });
  const u = response.usageMetadata ?? {};
  const candidates = response.candidates ?? [];
  const fcs = (response.functionCalls ?? []) as {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  }[];
  return {
    text: response.text ?? '',
    functionCalls: fcs
      .filter((f): f is { id?: string; name: string; args?: Record<string, unknown> } => !!f.name)
      .map((f) => ({ id: f.id, name: f.name, args: f.args ?? {} })),
    modelContent: (candidates[0]?.content as GeminiContent | undefined) ?? null,
    rawUsage: {
      inputTokens: u.promptTokenCount ?? 0,
      outputTokens: u.candidatesTokenCount ?? 0,
      cachedInputTokens: u.cachedContentTokenCount ?? 0,
    },
    finishReason: String(candidates[0]?.finishReason ?? ''),
  };
}

/** Single-shot tool-calling: surface the model's functionCalls for the caller
 * to execute. Mirrors the Anthropic adapter's chatWithTools. */
export async function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  if (options.turns.length === 0)
    throw new Error('google.chatWithTools() requires at least one turn');
  if (options.tools.length === 0)
    throw new Error('google.chatWithTools() requires at least one tool');
  throwIfAborted(options.abortSignal);
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const modelId = models[modelClass];

  const r = await callWithRetries(
    () =>
      callGenerateWithTools(
        client,
        modelId,
        options.systemPrompt,
        turnsToContents(options.turns),
        toGeminiTools(options.tools)
      ),
    options.onRetry
  );
  const usage = shapeUsage(r.rawUsage, modelClass);
  await fireUsageHook(options.onUsage, usage, 'google.chatWithTools');
  return {
    toolUses: r.functionCalls.map((f) => ({ id: f.id ?? f.name, name: f.name, input: f.args })),
    text: r.text,
    stopReason: r.finishReason,
    usage,
  };
}

/** Multi-turn tool loop: model → execute tools → feed functionResponse parts
 * back, until the model returns a call-free reply (or maxIterations). Mirrors
 * the Anthropic adapter's chatWithToolLoop, in Gemini's content shape. */
export async function chatWithToolLoop(
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  if (options.turns.length === 0)
    throw new Error('google.chatWithToolLoop() requires at least one turn');
  if (options.tools.length === 0)
    throw new Error('google.chatWithToolLoop() requires at least one tool');
  const modelClass: ModelClass = options.modelClass ?? 'reasoning';
  const client = getClient(options.apiKey ?? null);
  const modelId = models[modelClass];
  const tools = toGeminiTools(options.tools);
  const maxIterations = Math.max(1, options.maxIterations ?? 5);

  const contents: GeminiContent[] = turnsToContents(options.turns);
  const allToolUses: ToolUse[] = [];
  const allToolResults: ChatWithToolLoopResult['toolResults'] = [];
  const aggregate: TokenUsage = {
    provider: PROVIDER,
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
      () => callGenerateWithTools(client, modelId, options.systemPrompt, contents, tools),
      options.onRetry
    );
    aggregate.inputTokens += r.rawUsage.inputTokens;
    aggregate.outputTokens += r.rawUsage.outputTokens;
    aggregate.cacheReadInputTokens += r.rawUsage.cachedInputTokens;
    await fireUsageHook(
      options.onUsage,
      shapeUsage(r.rawUsage, modelClass),
      'google.chatWithToolLoop'
    );
    if (options.onIteration) {
      try {
        await options.onIteration({
          iteration,
          toolUses: r.functionCalls.map((f) => ({
            id: f.id ?? f.name,
            name: f.name,
            input: f.args,
          })),
          stopReason: r.finishReason,
        });
      } catch (err) {
        console.warn('google.chatWithToolLoop: onIteration callback threw', err);
      }
    }
    if (r.functionCalls.length === 0) {
      return {
        text: r.text,
        toolUses: allToolUses,
        toolResults: allToolResults,
        iterations: iteration,
        usage: aggregate,
      };
    }
    // Append the model's turn (carrying the functionCall parts) verbatim, then a
    // user turn of functionResponse parts.
    if (r.modelContent) contents.push(r.modelContent);
    const responseParts: unknown[] = [];
    for (const fc of r.functionCalls) {
      const use: ToolUse = { id: fc.id ?? fc.name, name: fc.name, input: fc.args };
      allToolUses.push(use);
      let content: string;
      let isError = false;
      try {
        content = await options.executor(use);
      } catch (err) {
        content = err instanceof Error ? err.message : String(err);
        isError = true;
      }
      responseParts.push({
        functionResponse: { id: fc.id, name: fc.name, response: { output: content } },
      });
      allToolResults.push({ toolUseId: use.id, content, isError });
    }
    contents.push({ role: 'user', parts: responseParts });
  }
  return {
    text: '',
    toolUses: allToolUses,
    toolResults: allToolResults,
    iterations: iteration,
    usage: aggregate,
  };
}
