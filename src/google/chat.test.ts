import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Mock the Google GenAI SDK before importing the adapter. Each test
// sets up the fake `models.generateContent` to return a controlled
// response shape; `sdk.vertexai` is the `vertexai` the fake client reports.
vi.mock('@google/genai', () => import('../test-support/google-genai.js'));

import {
  generateContent as mockGenerateContent,
  genaiCtor as mockClientCtor,
  genaiClient as sdk,
  geminiReply,
} from '../test-support/google-genai.js';
import { chat, chatWithTools, chatWithToolLoop } from './index.js';
import {
  classifyLlmError,
  EmptyResponseError,
  setModelSpanSink,
  type ModelSpan,
  type TokenUsage,
} from '../index.js';

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

/** A reply with no content parts, finishing on `STOP` with no tokens unless given. */
const fakeResponse = (
  text: string,
  finishReason = 'STOP',
  usage: Record<string, unknown> = { promptTokenCount: 0, candidatesTokenCount: 0 }
) => geminiReply({ text, finishReason, usage });

describe('google.chat', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockClientCtor.mockReset();
  });

  afterEach(() => setModelSpanSink(null));

  it('emits a model span to the registered sink with scope google.chat', async () => {
    mockGenerateContent.mockResolvedValue(
      fakeResponse('reply', 'STOP', { promptTokenCount: 12, candidatesTokenCount: 8 })
    );
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'google.chat',
      provider: 'google',
      inputTokens: 12,
      outputTokens: 8,
    });
  });

  it('returns the model text + usage from a single-shot call', async () => {
    mockGenerateContent.mockResolvedValue(
      fakeResponse('Hello from Gemini.', 'STOP', {
        promptTokenCount: 12,
        candidatesTokenCount: 8,
      })
    );

    const result = await chat({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });

    expect(result.content).toBe('Hello from Gemini.');
    expect(result.stopReason).toBe('STOP');
    expect(result.usage.provider).toBe('google');
    expect(result.usage.model).toBe('gemini-2.5-pro');
    expect(result.usage.direction).toBe('reasoning');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(8);
    // Single credential mechanism for this adapter — route is a constant,
    // not computed, but the caller-visible field must still be checked.
    expect(result.usage.route).toBe('api-key');
  });

  it('passes turn role + content through to generateContent (assistant → model)', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('ok'));

    await chat({
      systemPrompt: 'sys',
      turns: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      apiKey: 'sk-test',
    });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'reply' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
    expect(call.config?.systemInstruction).toBe('sys');
  });

  it('picks the extraction model when modelClass is extraction', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('ok'));

    const result = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
    });

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-2.5-flash');
    expect(result.usage.model).toBe('gemini-2.5-flash');
    expect(result.usage.direction).toBe('extraction');
  });

  it('fires onUsage with the shaped usage record', async () => {
    mockGenerateContent.mockResolvedValue(
      fakeResponse('reply', 'STOP', {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 30,
      })
    );
    const onUsage = vi.fn<(u: TokenUsage) => Promise<void>>(async () => {});

    await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledTimes(1);
    const usage = onUsage.mock.calls[0][0];
    expect(usage.provider).toBe('google');
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadInputTokens).toBe(30);
  });

  it('throws when the response has no text content', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('', 'SAFETY'));

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(/no text content.*SAFETY/);
  });

  it('that empty-response error keeps its message and name, and is recognisable without reading either', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('', 'SAFETY'));

    const rejection = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
    }).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(EmptyResponseError);
    expect((rejection as Error).name).toBe('Error');
    expect((rejection as Error).message).toBe(
      'google.chat: response had no text content (finish_reason=SAFETY)'
    );
    expect(classifyLlmError(rejection)).toEqual({ kind: 'empty-response', retryable: false });
  });

  it('throws the abort reason when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('budget exceeded before call');
    controller.abort(reason);

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        apiKey: 'sk-test',
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);

    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('throws when no turns are supplied', async () => {
    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [],
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(/at least one turn/);
  });

  it('retries on a 503 then succeeds', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }))
      .mockResolvedValueOnce(fakeResponse('finally', 'STOP'));

    // Stub setTimeout so we don't wait the full 5s in tests.
    vi.useFakeTimers();
    const promise = chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.content).toBe('finally');
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});

// `promptTokenCount` includes the cached content (src/otel.ts's header). Both of
// this adapter's spans: chat()'s, and the one chatWithTools and chatWithToolLoop share.
describe('google — the span input with cached content', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    exporter.reset();
  });

  const BASE = { systemPrompt: 's', turns: [{ role: 'user' as const, content: 'q' }], apiKey: 'k' };
  const TOOL = {
    name: 'record',
    description: 'record a thing',
    input_schema: { type: 'object' as const, properties: {} },
  };

  it.each([
    { site: 'chat', run: () => chat(BASE) },
    { site: 'chatWithTools', run: () => chatWithTools({ ...BASE, tools: [TOOL] }) },
  ])(
    '$site: is promptTokenCount as given, the cached content under the cache-read attribute',
    async ({ run }) => {
      mockGenerateContent.mockResolvedValueOnce(
        fakeResponse('ok', 'STOP', {
          promptTokenCount: 1000,
          candidatesTokenCount: 50,
          cachedContentTokenCount: 800,
        })
      );

      await run();

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0].attributes['gen_ai.usage.input_tokens']).toBe(1000);
      expect(spans[0].attributes['gen_ai.usage.cache_read.input_tokens']).toBe(800);
    }
  );
});

// The span names the endpoint the client calls; the returned usage and the
// sink keep the adapter's own id. Every span site: chat()'s, chatWithTools',
// and chatWithToolLoop's per-iteration and final no-tools calls.
describe('google — the span names the endpoint its client calls', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    exporter.reset();
  });

  afterEach(() => {
    sdk.vertexai = false;
    setModelSpanSink(null);
  });

  const BASE = { systemPrompt: 's', turns: [{ role: 'user' as const, content: 'q' }], apiKey: 'k' };
  const TOOL = {
    name: 'record',
    description: 'record a thing',
    input_schema: { type: 'object' as const, properties: {} },
  };
  const toolCall = {
    functionCalls: [{ id: 'c1', name: 'record', args: {} }],
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name: 'record', args: {} } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    text: '',
  };

  const SITES = [
    {
      site: 'chat',
      calls: 1,
      run: async () => (await chat(BASE)).usage.provider,
    },
    {
      site: 'chatWithTools',
      calls: 1,
      run: async () => (await chatWithTools({ ...BASE, tools: [TOOL] })).usage.provider,
    },
    {
      site: 'chatWithToolLoop (an iteration, then the final no-tools call)',
      calls: 2,
      run: async () => {
        mockGenerateContent.mockResolvedValueOnce(toolCall);
        const result = await chatWithToolLoop({
          ...BASE,
          tools: [TOOL],
          executor: async () => 'ok',
          maxIterations: 1,
        });
        return result.usage.provider;
      },
    },
  ];
  const ENDPOINTS = [
    { endpoint: 'Vertex AI', vertexai: true, spanProvider: 'gcp.vertex_ai' },
    { endpoint: 'AI Studio', vertexai: false, spanProvider: 'gcp.gemini' },
  ];

  it.each(SITES.flatMap((s) => ENDPOINTS.map((e) => ({ ...s, ...e }))))(
    '$site on $endpoint: the span says $spanProvider; the usage and the sink say google',
    async ({ run, calls, vertexai, spanProvider }) => {
      sdk.vertexai = vertexai;
      mockGenerateContent.mockResolvedValue(fakeResponse('ok'));
      const sunk: ModelSpan[] = [];
      setModelSpanSink((span) => sunk.push(span));

      const returnedProvider = await run();

      expect({
        span: exporter.getFinishedSpans().map((span) => span.attributes['gen_ai.provider.name']),
        usage: returnedProvider,
        sink: sunk.map((span) => span.provider),
      }).toEqual({
        span: Array(calls).fill(spanProvider),
        usage: 'google',
        sink: Array(calls).fill('google'),
      });
    }
  );
});
