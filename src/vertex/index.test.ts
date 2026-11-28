import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Both SDKs are mocked before the adapters are imported, at the constructor —
// the same seam the Anthropic adapter's tests use. The Vertex mock stands in for
// the client this route builds; the direct SDK's mock is here to hold that this
// route never builds one, and to compare the two routes' requests. No test in
// this file reaches a network or needs a Google credential.
const vertexStream = vi.fn();
const vertexCtor = vi.fn();
const directStream = vi.fn();
const directCtor = vi.fn();

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class AnthropicVertex {
    messages = { stream: vertexStream };
    constructor(opts: unknown) {
      vertexCtor(opts);
    }
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { stream: directStream };
    constructor(opts: unknown) {
      directCtor(opts);
    }
  },
}));

import { PROVIDER, chat, chatWithTools, chatWithToolLoop, vertex } from './index.js';
import { resetClientForTests } from './client.js';
import * as direct from '../anthropic/index.js';
import { resetClientStateForTests } from '../anthropic/client.js';
import { models } from '../anthropic/adapter.js';
import {
  classifyLlmError,
  setModelSpanSink,
  type ChatOptions,
  type ModelSpan,
  type TokenUsage,
  type ToolDef,
} from '../index.js';
import { createPriceBook } from '../pricing.js';
import { ATTR_GEN_AI_PROVIDER_NAME } from '../otel.js';

type FakeBlock = Record<string, unknown>;

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function fakeStream(
  blocks: FakeBlock[],
  stopReason: string,
  usage: Record<string, unknown> = ZERO_USAGE
) {
  return {
    on: () => {},
    finalMessage: async () => ({
      id: 'msg_1',
      model: 'answered-model',
      content: blocks,
      stop_reason: stopReason,
      usage,
    }),
  };
}

const text = (t = 'ok') => fakeStream([{ type: 'text', text: t }], 'end_turn');

const TOOL: ToolDef = {
  name: 'lookup',
  description: 'look something up',
  input_schema: { type: 'object', properties: {} },
};

const BASE: ChatOptions = { systemPrompt: 'sys', turns: [{ role: 'user', content: 'hello' }] };

const ENV = [
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const mock of [vertexStream, vertexCtor, directStream, directCtor]) mock.mockReset();
  resetClientForTests();
  resetClientStateForTests();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'proj-a';
  process.env.CLOUD_ML_REGION = 'region-a';
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setModelSpanSink(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('@verevoir/llm/vertex — surface', () => {
  it('reports the vertex provider id and offers the three calls, named and namespaced', () => {
    expect(PROVIDER).toBe('vertex');
    expect(vertex).toEqual({ PROVIDER, chat, chatWithTools, chatWithToolLoop });
  });
});

describe('@verevoir/llm/vertex — credentials and addressing', () => {
  it("builds the Vertex client from the project and region, with the SDK's own retries off and no credential option", async () => {
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = '  proj-a ';
    process.env.CLOUD_ML_REGION = ' region-a  ';
    vertexStream.mockReturnValue(text());

    const reply = await chat(BASE);

    expect(reply.content).toBe('ok');
    expect(vertexCtor.mock.calls).toEqual([
      [{ projectId: 'proj-a', region: 'region-a', maxRetries: 0 }],
    ]);
    expect(directCtor).not.toHaveBeenCalled();
  });

  it.each([
    ['chat', () => chat(BASE)],
    ['chatWithTools', () => chatWithTools({ ...BASE, tools: [TOOL] })],
    ['chatWithToolLoop', () => chatWithToolLoop({ ...BASE, tools: [TOOL], executor: vi.fn() })],
  ])(
    '%s ignores the direct route credentials: no direct client, no identity block, route google-cloud',
    async (_name, call) => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-value';
      process.env.ANTHROPIC_API_KEY = 'api-key-value';
      vertexStream.mockReturnValue(text());

      const result = await call();

      expect(directCtor).not.toHaveBeenCalled();
      expect(vertexCtor).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(vertexCtor.mock.calls)).not.toMatch(/oauth-token-value|api-key-value/);
      const request = vertexStream.mock.calls[0][0];
      expect(request.system).toEqual([
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
      ]);
      expect(result.usage.route).toBe('google-cloud');
    }
  );

  it.each([
    [
      'ANTHROPIC_VERTEX_PROJECT_ID',
      undefined,
      'No Vertex AI project: set ANTHROPIC_VERTEX_PROJECT_ID.',
    ],
    [
      'ANTHROPIC_VERTEX_PROJECT_ID',
      '   ',
      'No Vertex AI project: set ANTHROPIC_VERTEX_PROJECT_ID.',
    ],
    ['CLOUD_ML_REGION', undefined, 'No Vertex AI region: set CLOUD_ML_REGION.'],
    ['CLOUD_ML_REGION', '   ', 'No Vertex AI region: set CLOUD_ML_REGION.'],
  ])('refuses before any call when %s is %j', async (name, value, message) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;

    for (const call of [
      () => chat(BASE),
      () => chatWithTools({ ...BASE, tools: [TOOL] }),
      () => chatWithToolLoop({ ...BASE, tools: [TOOL], executor: vi.fn() }),
    ]) {
      const err = await call().then(
        () => null,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(Error);
      // Exactly the setting's name: neither setting's value appears.
      expect((err as Error).message).toBe(message);
    }
    expect(vertexCtor).not.toHaveBeenCalled();
    expect(vertexStream).not.toHaveBeenCalled();
  });

  it('refuses a per-call apiKey before any call, without repeating it', async () => {
    const err = await chat({ ...BASE, apiKey: 'sk-secret-value' }).then(
      () => null,
      (e: unknown) => e
    );

    expect((err as Error).message).toBe(
      'Vertex AI takes no API key: it authenticates with Google Cloud credentials. Remove the per-call apiKey.'
    );
    expect(vertexCtor).not.toHaveBeenCalled();
    expect(directCtor).not.toHaveBeenCalled();
    expect(vertexStream).not.toHaveBeenCalled();
  });

  it('accepts apiKey: null, as on every adapter', async () => {
    vertexStream.mockReturnValue(text());
    await expect(chat({ ...BASE, apiKey: null })).resolves.toMatchObject({ content: 'ok' });
  });

  it('keeps one client while the project and region stand, and builds another when either changes', async () => {
    vertexStream.mockReturnValue(text());

    await chat(BASE);
    await chat(BASE);
    expect(vertexCtor).toHaveBeenCalledTimes(1);

    process.env.CLOUD_ML_REGION = 'region-b';
    await chat(BASE);
    expect(vertexCtor).toHaveBeenLastCalledWith({
      projectId: 'proj-a',
      region: 'region-b',
      maxRetries: 0,
    });
    expect(vertexCtor).toHaveBeenCalledTimes(2);

    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'proj-b';
    await chat(BASE);
    expect(vertexCtor).toHaveBeenLastCalledWith({
      projectId: 'proj-b',
      region: 'region-b',
      maxRetries: 0,
    });
    expect(vertexCtor).toHaveBeenCalledTimes(3);
  });
});

describe('@verevoir/llm/vertex — sends what the direct adapter sends', () => {
  // The same options through both routes (the direct one on a plain API key),
  // each scripted with the same replies. Every request must match exactly:
  // there is one request builder and one tool loop.
  const toolTurn = () =>
    fakeStream([{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: { q: 'x' } }], 'tool_use');
  const progressTurn = () =>
    fakeStream(
      [{ type: 'tool_use', id: 'tu_p', name: 'report_progress', input: { percent: 50 } }],
      'tool_use'
    );

  const cases: [
    string,
    (api: typeof direct | typeof vertex, o: ChatOptions) => Promise<unknown>,
    (() => unknown)[],
  ][] = [
    ['chat', (api, o) => api.chat(o), [text]],
    [
      'chat with a progress continuation',
      (api, o) => api.chat({ ...o, onProgress: async () => {} }),
      [progressTurn, text],
    ],
    ['chatWithTools', (api, o) => api.chatWithTools({ ...o, tools: [TOOL] }), [toolTurn]],
    [
      'chatWithToolLoop',
      (api, o) => api.chatWithToolLoop({ ...o, tools: [TOOL], executor: async () => 'found' }),
      [toolTurn, text],
    ],
    [
      'chatWithToolLoop at its iteration cap',
      (api, o) =>
        api.chatWithToolLoop({
          ...o,
          tools: [TOOL],
          executor: async () => 'found',
          maxIterations: 1,
        }),
      [toolTurn, text],
    ],
    [
      'chatWithToolLoop whose tool returns an image and a document block',
      (api, o) =>
        api.chatWithToolLoop({
          ...o,
          tools: [TOOL],
          executor: async () => [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' },
            },
          ],
        }),
      [toolTurn, text],
    ],
  ];

  it('the tool loop carries image and document blocks through to the model', async () => {
    vertexStream.mockReturnValueOnce(toolTurn()).mockReturnValueOnce(text());
    const [, run] = cases[cases.length - 1];

    await run(vertex, BASE);

    const sent = JSON.stringify(vertexStream.mock.calls[1][0].messages);
    expect(sent).toContain('"type":"image"');
    expect(sent).toContain('"type":"document"');
  });

  describe.each([undefined, 'none', 'default', 'prefix'] as const)('cache: %s', (cache) => {
    it.each(cases)('%s', async (_name, run, replies) => {
      for (const reply of replies) {
        vertexStream.mockReturnValueOnce(reply());
        directStream.mockReturnValueOnce(reply());
      }
      const options: ChatOptions = { ...BASE, cache, maxTokens: 321 };

      await run(vertex, options);
      await run(direct, { ...options, apiKey: 'sk-test' });

      expect(vertexStream).toHaveBeenCalledTimes(replies.length);
      expect(JSON.stringify(vertexStream.mock.calls)).toBe(JSON.stringify(directStream.mock.calls));
    });
  });
});

describe('@verevoir/llm/vertex — model names', () => {
  it('sends the Anthropic catalogue id for the class when no model is given, unchanged', async () => {
    vertexStream.mockReturnValue(text());

    const reply = await chat({ ...BASE, modelClass: 'extraction' });

    expect(vertexStream.mock.calls[0][0].model).toBe(models.extraction);
    expect(reply.usage.model).toBe(models.extraction);
  });

  it.each([
    ['chat', (model: string) => chat({ ...BASE, model })],
    ['chatWithTools', (model: string) => chatWithTools({ ...BASE, model, tools: [TOOL] })],
    [
      'chatWithToolLoop',
      (model: string) => chatWithToolLoop({ ...BASE, model, tools: [TOOL], executor: vi.fn() }),
    ],
  ])('%s sends an explicit model name exactly as given', async (_name, call) => {
    vertexStream.mockReturnValue(text());

    const result = await call('some-model@20990101');

    expect(vertexStream.mock.calls[0][0].model).toBe('some-model@20990101');
    expect(result.usage.model).toBe('some-model@20990101');
  });
});

describe('@verevoir/llm/vertex — OpenTelemetry span', () => {
  // Registered once for the block: the API's global tracer provider takes one
  // registration per process (see otel.test.ts).
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  beforeAll(() => void trace.setGlobalTracerProvider(tracerProvider));
  afterAll(async () => {
    trace.disable();
    await tracerProvider.shutdown();
  });

  it('names the provider of each route on its own span', async () => {
    vertexStream.mockReturnValue(text());
    directStream.mockReturnValue(text());

    await chat(BASE);
    await direct.chat({ ...BASE, apiKey: 'sk-test' });

    expect(exporter.getFinishedSpans().map((s) => s.attributes[ATTR_GEN_AI_PROVIDER_NAME])).toEqual(
      ['gcp.vertex_ai', 'anthropic']
    );
  });

  // Both routes share src/anthropic/adapter.ts. Anthropic's `input_tokens`
  // leaves cached tokens out; the span's input is every input token.
  const ROUTES = [
    { route: 'vertex', stream: vertexStream, call: (o: ChatOptions) => chat(o) },
    {
      route: 'anthropic',
      stream: directStream,
      call: (o: ChatOptions) => direct.chat({ ...o, apiKey: 'sk-test' }),
    },
  ];
  const SPAN_USAGE = {
    input_tokens: 11,
    output_tokens: 7,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
  };
  const lastSpan = () => exporter.getFinishedSpans().at(-1)!;

  it.each(ROUTES)(
    '$route: the span input is input + cache read + cache write, the cache counts under the conventions’ names, the verevoir.llm.* attributes kept and no verevoir.llm.* name for the cache counts',
    async ({ stream, call }) => {
      stream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn', SPAN_USAGE));

      await call(BASE);

      const attributes = lastSpan().attributes;
      expect(attributes).toMatchObject({
        'gen_ai.usage.input_tokens': 81,
        'gen_ai.usage.cache_read.input_tokens': 40,
        'gen_ai.usage.cache_write.input_tokens': 30,
        'verevoir.llm.cache_creation.ephemeral_5m_input_tokens': 10,
        'verevoir.llm.cache_creation.ephemeral_1h_input_tokens': 20,
        'verevoir.llm.provider_request_id': 'msg_1',
      });
      expect(Object.keys(attributes)).not.toContain('verevoir.llm.cache_read_input_tokens');
      expect(Object.keys(attributes)).not.toContain('verevoir.llm.cache_creation_input_tokens');
    }
  );

  it.each(ROUTES)(
    '$route: with no input_tokens the span input is left unset, not made from the cache counts',
    async ({ stream, call }) => {
      const { input_tokens: _omitted, ...noInput } = SPAN_USAGE;
      stream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn', noInput));

      await call(BASE);

      expect(Object.keys(lastSpan().attributes)).not.toContain('gen_ai.usage.input_tokens');
    }
  );

  it.each(ROUTES)(
    "$route: chat()'s returned counts and cost are the provider's own, whatever the span's input",
    async ({ stream, call }) => {
      stream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn', SPAN_USAGE));
      const book = createPriceBook({
        snapshot: {
          [models.reasoning]: {
            inputCostPerToken: 1e-6,
            outputCostPerToken: 2e-6,
            cacheReadInputTokenCost: 1e-7,
            cacheCreationInputTokenCost: 1.25e-6,
          },
        },
        fetch: () => {
          throw new Error('must not fetch — this book is never start()-ed');
        },
      });

      const reply = await call(BASE);

      expect(reply.usage).toMatchObject({
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 30,
        cacheCreationEphemeral5mInputTokens: 10,
        cacheCreationEphemeral1hInputTokens: 20,
      });
      expect(lastSpan().attributes['gen_ai.usage.input_tokens']).toBe(81);
      expect(book.costOf(reply.usage)).toHaveProperty('usdMicros');
      expect(book.costOf(reply.usage)).toEqual(
        book.costOf({
          provider: reply.usage.provider,
          model: reply.usage.model,
          inputTokens: 11,
          outputTokens: 7,
          cacheReadInputTokens: 40,
          cacheCreationInputTokens: 30,
          cacheCreationEphemeral5mInputTokens: 10,
          cacheCreationEphemeral1hInputTokens: 20,
        })
      );
    }
  );
});

describe('@verevoir/llm/vertex — usage', () => {
  const CACHE_USAGE = {
    input_tokens: 11,
    output_tokens: 7,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
  };

  it('reports tokens, cache writes and reads and the 5m/1h split, as provider vertex', async () => {
    vertexStream.mockReturnValue(
      fakeStream([{ type: 'text', text: 'ok' }], 'end_turn', CACHE_USAGE)
    );
    const hooked: TokenUsage[] = [];
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    const reply = await chat({ ...BASE, onUsage: async (u) => void hooked.push(u) });

    const expected = {
      provider: 'vertex',
      model: models.reasoning,
      direction: 'reasoning',
      route: 'google-cloud',
      inputTokens: 11,
      outputTokens: 7,
      cacheCreationInputTokens: 30,
      cacheReadInputTokens: 40,
      cacheCreationEphemeral5mInputTokens: 10,
      cacheCreationEphemeral1hInputTokens: 20,
    };
    expect(reply.usage).toMatchObject(expected);
    expect(hooked).toHaveLength(1);
    expect(hooked[0]).toMatchObject(expected);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ scope: 'vertex.chat', provider: 'vertex', inputTokens: 11 });
  });

  it('sums the tool loop, cache split included', async () => {
    vertexStream.mockReturnValueOnce(
      fakeStream(
        [{ type: 'tool_use', id: 'tu_1', name: 'lookup', input: {} }],
        'tool_use',
        CACHE_USAGE
      )
    );
    vertexStream.mockReturnValueOnce(
      fakeStream([{ type: 'text', text: 'done' }], 'end_turn', CACHE_USAGE)
    );

    const result = await chatWithToolLoop({ ...BASE, tools: [TOOL], executor: async () => 'r' });

    expect(result.usage).toMatchObject({
      provider: 'vertex',
      route: 'google-cloud',
      inputTokens: 22,
      outputTokens: 14,
      cacheCreationInputTokens: 60,
      cacheReadInputTokens: 80,
      cacheCreationEphemeral5mInputTokens: 20,
      cacheCreationEphemeral1hInputTokens: 40,
    });
  });

  it('is priced by the price book only where the book has an entry for the model name sent', async () => {
    // The book looks a usage up by its exact model name, then by
    // `provider/model`; it has no entry of its own for provider `vertex`.
    const book = createPriceBook({
      snapshot: { 'listed-model': { inputCostPerToken: 1e-6, outputCostPerToken: 1e-6 } },
      fetch: () => {
        throw new Error('must not fetch — this book is never start()-ed');
      },
    });
    vertexStream.mockReturnValue(
      fakeStream([{ type: 'text', text: 'ok' }], 'end_turn', { ...ZERO_USAGE, input_tokens: 5 })
    );

    const listed = await chat({ ...BASE, model: 'listed-model' });
    const unlisted = await chat({ ...BASE, model: 'listed-model@20990101' });

    expect(book.costOf(listed.usage)).toMatchObject({ usdMicros: 5 });
    expect(book.costOf(unlisted.usage)).toEqual({
      unpriced: 'no price entry for model "listed-model@20990101" (provider "vertex")',
    });
  });
});

describe('@verevoir/llm/vertex — failures', () => {
  const withStatus = (status: number) => Object.assign(new Error('provider said no'), { status });

  it.each([
    [401, 'authentication'],
    [403, 'permission'],
    [400, 'invalid-request'],
    [404, 'invalid-request'],
  ])('rejects with the SDK error itself on a %i, classified %s', async (status, kind) => {
    const thrown = withStatus(status);
    vertexStream.mockReturnValue({ on: () => {}, finalMessage: () => Promise.reject(thrown) });

    const err = await chat(BASE).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBe(thrown);
    expect(classifyLlmError(err)).toEqual({ kind, retryable: false });
  });

  it('a 401 is final: no second attempt on a direct-route credential, and no fallback notice', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-value';
    process.env.ANTHROPIC_API_KEY = 'api-key-value';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const thrown = withStatus(401);
    vertexStream.mockReturnValue({ on: () => {}, finalMessage: () => Promise.reject(thrown) });

    await expect(chat(BASE)).rejects.toBe(thrown);

    expect(vertexStream).toHaveBeenCalledTimes(1);
    expect(vertexCtor).toHaveBeenCalledTimes(1);
    expect(directCtor).not.toHaveBeenCalled();
    expect(directStream).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    [429, 'rate-limited'],
    [529, 'overloaded'],
    [503, 'unavailable'],
  ])('retries a %i (%s) on the shared ladder, then answers', async (status, kind) => {
    vi.useFakeTimers();
    const thrown = withStatus(status);
    expect(classifyLlmError(thrown)).toEqual({ kind, retryable: true });
    vertexStream.mockReturnValueOnce({ on: () => {}, finalMessage: () => Promise.reject(thrown) });
    vertexStream.mockReturnValueOnce(text('after retry'));
    const onRetry = vi.fn(async () => {});

    const pending = chat({ ...BASE, onRetry });
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pending).resolves.toMatchObject({ content: 'after retry' });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(vertexStream).toHaveBeenCalledTimes(2);
    expect(vertexCtor).toHaveBeenCalledTimes(1);
  });

  it('names the call in its own errors as vertex, not anthropic', async () => {
    await expect(chat({ ...BASE, turns: [] })).rejects.toThrow(
      'vertex.chat() requires at least one turn'
    );
    vertexStream.mockReturnValue(fakeStream([], 'end_turn'));
    const err = await chat(BASE).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as Error).message).toBe(
      'vertex.chat: response had no text content (stop_reason=end_turn)'
    );
    expect(classifyLlmError(err)).toEqual({ kind: 'empty-response', retryable: false });
  });
});
