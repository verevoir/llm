import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Mock the openai SDK so usage tests run with canned responses (no network).
const { chatCreateMock } = vi.hoisted(() => ({ chatCreateMock: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: chatCreateMock } };
    constructor(_opts: unknown) {}
  },
}));

import { createOpenAICompatAdapter } from './openai-compat.js';
import {
  classifyLlmError,
  EmptyResponseError,
  normalizeModelId,
  modelLabel,
  estimateCostUSD,
  setModelSpanSink,
  type ModelCatalogEntry,
  type ModelSpan,
} from './index.js';
import { ATTR_GEN_AI_PROVIDER_NAME } from './otel.js';

// One tracer for the file: OpenTelemetry takes a global provider only once.
const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(() => {
  trace.setGlobalTracerProvider(tracerProvider);
});
afterAll(async () => {
  await tracerProvider.shutdown();
});

describe('createOpenAICompatAdapter', () => {
  const catalog: ModelCatalogEntry[] = [
    {
      provider: 'testco',
      family: 'big',
      modelClass: 'reasoning',
      currentId: 'testco-big-1',
      rates: [1, 2],
      label: 'Big',
      prefixes: ['testco-big'],
    },
    {
      provider: 'testco',
      family: 'small',
      modelClass: 'extraction',
      currentId: 'testco-small-1',
      rates: [0.1, 0.2],
      label: 'Small',
      prefixes: ['testco-small'],
    },
  ];
  const a = createOpenAICompatAdapter({
    provider: 'testco',
    spanProvider: 'testco-span',
    baseURL: 'https://x/v1',
    apiKeyEnv: 'TESTCO_KEY',
    catalog,
  });

  it('exposes the provider id, base URL, and a chat fn', () => {
    expect(a.PROVIDER).toBe('testco');
    expect(a.BASE_URL).toBe('https://x/v1');
    expect(typeof a.chat).toBe('function');
  });

  it('derives the class map with the tier ladder — drafting falls up to reasoning', () => {
    expect(a.models.reasoning).toBe('testco-big-1');
    expect(a.models.extraction).toBe('testco-small-1');
    expect(a.models.drafting).toBe('testco-big-1');
  });

  it('derives rates keyed by the current id', () => {
    expect(a.rates['testco-big-1']).toEqual([1, 2]);
  });

  it('registers the catalogue so decisions key on provider/family', () => {
    expect(normalizeModelId('testco-big-1')).toEqual({ provider: 'testco', family: 'big' });
    // a new, unseen version still normalises via the prefix
    expect(normalizeModelId('testco-big-2-20990101')).toEqual({
      provider: 'testco',
      family: 'big',
    });
    expect(modelLabel('testco-big-1')).toBe('Big');
    // family pricing covers a drifted id with no explicit rates table
    expect(estimateCostUSD({ 'testco-big-9': { in: 1_000_000, out: 1_000_000 } }, {})).toBeCloseTo(
      3,
      5
    );
  });

  it('emits a model span scoped with the factory config provider name, not a literal', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));
    try {
      await a.chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'go' }], apiKey: 'k' });
    } finally {
      setModelSpanSink(null);
    }
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ scope: 'testco.chat', provider: 'testco' });
  });

  it('chat: the span says the config spanProvider; the usage and the sink say its provider', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    exporter.reset();
    const sunk: ModelSpan[] = [];
    setModelSpanSink((s) => sunk.push(s));
    try {
      const reply = await a.chat({
        systemPrompt: 's',
        turns: [{ role: 'user', content: 'go' }],
        apiKey: 'k',
      });
      expect({
        span: exporter.getFinishedSpans().map((s) => s.attributes[ATTR_GEN_AI_PROVIDER_NAME]),
        usage: reply.usage.provider,
        sink: sunk.map((s) => s.provider),
      }).toEqual({ span: ['testco-span'], usage: 'testco', sink: ['testco'] });
    } finally {
      setModelSpanSink(null);
    }
  });

  // route was hardcoded as a constant in shapeUsage() when this factory
  // gained the field, but nothing in this suite ever asserted it — a review
  // found the whole PR's route field shipped with the coverage its own body
  // claimed, but did not actually have, across every adapter built on this
  // factory (deepseek, samba, mistral).
  it('reports route "api-key" — the sole credential mechanism every adapter built on this factory has', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const result = await a.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
    });
    expect(result.usage.route).toBe('api-key');
  });

  it("reports providerRequestId from the response object's own id field (#70 honesty fix)", async () => {
    chatCreateMock.mockResolvedValueOnce({
      id: 'chatcmpl-honest123',
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const result = await a.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
    });
    expect(result.usage.providerRequestId).toBe('chatcmpl-honest123');
  });

  it('leaves providerRequestId undefined when the response has no id (#70 honesty fix)', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const result = await a.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
    });
    expect(result.usage.providerRequestId).toBeUndefined();
  });

  it('chat: a response with no text rejects with an EmptyResponseError whose message and name are the plain error it always was', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: '' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    const rejection = await a
      .chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'go' }], apiKey: 'k' })
      .catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(EmptyResponseError);
    expect((rejection as Error).name).toBe('Error');
    expect((rejection as Error).message).toBe(
      'testco.chat: response had no text content (finishReason=length)'
    );
    expect(classifyLlmError(rejection)).toEqual({ kind: 'empty-response', retryable: false });
  });

  it('throws when the catalogue declares no modelClass anywhere', () => {
    expect(() =>
      createOpenAICompatAdapter({
        provider: 'p',
        spanProvider: 'p-span',
        baseURL: 'u',
        apiKeyEnv: 'K',
        catalog: [{ provider: 'p', family: 'f', currentId: 'p-x', rates: [1, 1], label: 'X' }],
      })
    ).toThrow(/modelClass/);
  });
});

// ── Cached-token usage (STDIO-487 regression) ────────────────────────────────
// prompt_tokens is the TOTAL including the cached subset.  inputTokens must be
// the non-cached portion only; cacheReadInputTokens carries the cached count.
// Double-counting both was the bug — these tests would have caught it.

describe('cached-token usage — no double-count (STDIO-487)', () => {
  const usageCatalog: ModelCatalogEntry[] = [
    {
      provider: 'cachetest',
      family: 'm',
      modelClass: 'reasoning',
      currentId: 'cachetest-m',
      rates: [1, 1],
      label: 'M',
    },
  ];
  const adapter = createOpenAICompatAdapter({
    provider: 'cachetest',
    spanProvider: 'cachetest-span',
    baseURL: 'https://x/v1',
    apiKeyEnv: 'CACHETEST_KEY',
    catalog: usageCatalog,
  });

  it('chat: prompt_tokens_details.cached_tokens is excluded from inputTokens', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    let captured: import('./index.js').TokenUsage | undefined;
    await adapter.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
      onUsage: async (u) => {
        captured = u;
      },
    });
    expect(captured?.inputTokens).toBe(200); // 1000 - 800
    expect(captured?.cacheReadInputTokens).toBe(800); // unchanged
  });

  it('chat: DeepSeek prompt_cache_hit_tokens is excluded from inputTokens', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 800,
      },
    });
    let captured: import('./index.js').TokenUsage | undefined;
    await adapter.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
      onUsage: async (u) => {
        captured = u;
      },
    });
    expect(captured?.inputTokens).toBe(200);
    expect(captured?.cacheReadInputTokens).toBe(800);
  });

  it('chat: no cache fields — inputTokens equals prompt_tokens', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 20 },
    });
    let captured: import('./index.js').TokenUsage | undefined;
    await adapter.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
      onUsage: async (u) => {
        captured = u;
      },
    });
    expect(captured?.inputTokens).toBe(500);
    expect(captured?.cacheReadInputTokens).toBe(0);
  });
});
