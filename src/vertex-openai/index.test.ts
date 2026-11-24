import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { inspect } from 'node:util';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { APIConnectionError, APIError } from 'openai';

// No module is mocked: the real `openai` SDK builds and sends every request,
// through a fake `fetch` and a fake token source handed to the client's test
// seam. So the URL, headers and body asserted are what would go on the wire.
import {
  PROVIDER,
  VertexOpenAIConfigError,
  VertexOpenAITokenError,
  chat,
  chatWithTools,
  chatWithToolLoop,
  vertexOpenAI,
} from './index.js';
import { setTransportForTests, type TokenSource } from './client.js';
import {
  classifyLlmError,
  setModelSpanSink,
  type ChatOptions,
  type ChatRetryInfo,
  type ModelSpan,
  type TokenUsage,
  type ToolDef,
} from '../index.js';
import { createPriceBook } from '../pricing.js';

const MODEL = 'google/gemini-3.5-flash';
const GLOBAL_URL =
  'https://aiplatform.googleapis.com/v1/projects/proj-a/locations/global/endpoints/openapi/chat/completions';

const TOOL: ToolDef = {
  name: 'lookup',
  description: 'look something up',
  input_schema: { type: 'object', properties: {} },
};

const BASE: ChatOptions = {
  systemPrompt: 'sys',
  turns: [{ role: 'user', content: 'hello' }],
  model: MODEL,
};

type Body = Record<string, unknown>;

function textBody(usage: Body = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }) {
  return {
    id: 'chatcmpl-1',
    model: 'answered-model',
    choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage,
  };
}

function toolCallBody(usage: Body = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) {
  return {
    id: 'chatcmpl-t',
    model: 'answered-model',
    choices: [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();
const tokenSource = vi.fn<TokenSource>();

/** Every request the SDK made, as it went to `fetch`. */
function requests() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body)) as Body,
  }));
}

/** Answer every request with a fresh copy of `body`. */
function answer(body: unknown, status = 200): void {
  fetchMock.mockImplementation(async () => json(body, status));
}

/** Answer successive requests with the given bodies, in order. */
function answerInOrder(...bodies: unknown[]): void {
  for (const body of bodies) fetchMock.mockImplementationOnce(async () => json(body));
}

const rejection = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => null,
    (e: unknown) => e
  );

type Extra = Partial<ChatOptions>;

/** The three call shapes, each making one request when the model answers in text. */
const SHAPES: [string, (extra?: Extra) => Promise<{ usage: TokenUsage }>][] = [
  ['chat', (extra) => chat({ ...BASE, ...extra })],
  ['chatWithTools', (extra) => chatWithTools({ ...BASE, ...extra, tools: [TOOL] })],
  [
    'chatWithToolLoop',
    (extra) =>
      chatWithToolLoop({ ...BASE, ...extra, tools: [TOOL], executor: async () => 'looked up' }),
  ],
];

const ENV = [
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  fetchMock.mockReset();
  tokenSource.mockReset();
  tokenSource.mockResolvedValue('tok');
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GOOGLE_CLOUD_PROJECT = 'proj-a';
  setTransportForTests({ tokenSource, fetch: fetchMock });
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setTransportForTests();
  setModelSpanSink(null);
  vi.restoreAllMocks();
});

describe('@verevoir/llm/vertex-openai — surface', () => {
  it('reports its provider id and offers the three calls, named and namespaced', () => {
    expect(PROVIDER).toBe('vertex-openai');
    expect(vertexOpenAI).toEqual({ PROVIDER, chat, chatWithTools, chatWithToolLoop });
  });
});

describe('@verevoir/llm/vertex-openai — the URL', () => {
  it('uses the global host and the global location when no location is set', async () => {
    answer(textBody());

    await chat(BASE);

    expect(requests().map((r) => r.url)).toEqual([GLOBAL_URL]);
  });

  it('uses the regional host for a location, and that location in the path', async () => {
    process.env.GOOGLE_CLOUD_LOCATION = ' europe-west4 ';
    answer(textBody());

    await chat(BASE);

    expect(requests().map((r) => r.url)).toEqual([
      'https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-a/locations/europe-west4/endpoints/openapi/chat/completions',
    ]);
  });

  it('follows the project and the location when either changes between calls', async () => {
    answer(textBody());

    await chat(BASE);
    process.env.GOOGLE_CLOUD_LOCATION = 'us-central1';
    await chat(BASE);
    process.env.GOOGLE_CLOUD_PROJECT = 'proj-b';
    await chat(BASE);

    expect(requests().map((r) => r.url)).toEqual([
      GLOBAL_URL,
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-a/locations/us-central1/endpoints/openapi/chat/completions',
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj-b/locations/us-central1/endpoints/openapi/chat/completions',
    ]);
  });

  it('does not read the Claude-on-Vertex settings or the OpenAI base URL', async () => {
    process.env.CLOUD_ML_REGION = 'us-east5';
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'other-project';
    process.env.OPENAI_BASE_URL = 'https://elsewhere.example/v1';
    answer(textBody());

    await chat(BASE);

    expect(requests().map((r) => r.url)).toEqual([GLOBAL_URL]);
  });
});

describe('@verevoir/llm/vertex-openai — the bearer token', () => {
  it('asks the token source before every call, so a replaced token is the one sent', async () => {
    tokenSource.mockReset();
    tokenSource.mockResolvedValueOnce('tok-1').mockResolvedValueOnce('tok-2');
    answer(textBody());

    await chat(BASE);
    await chat(BASE);

    expect(requests().map((r) => r.headers.get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
  });

  it('asks the token source before every request of a tool loop', async () => {
    tokenSource.mockReset();
    tokenSource
      .mockResolvedValueOnce('tok-1')
      .mockResolvedValueOnce('tok-2')
      .mockResolvedValueOnce('tok-3');
    // Two iterations that both call a tool reach the cap, so the loop makes
    // its final no-tools call: three requests in all.
    answerInOrder(toolCallBody(), toolCallBody(), textBody());

    await chatWithToolLoop({
      ...BASE,
      tools: [TOOL],
      executor: async () => 'looked up',
      maxIterations: 2,
    });

    expect(requests().map((r) => r.headers.get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
      'Bearer tok-3',
    ]);
  });

  it('sends no OpenAI organisation or project header, whatever the environment holds', async () => {
    process.env.OPENAI_ORG_ID = 'org-from-env';
    process.env.OPENAI_PROJECT_ID = 'project-from-env';
    process.env.OPENAI_API_KEY = 'sk-from-env';
    answer(textBody());

    await chat(BASE);

    const [{ headers }] = requests();
    expect(headers.get('openai-organization')).toBeNull();
    expect(headers.get('openai-project')).toBeNull();
    expect(headers.get('authorization')).toBe('Bearer tok');
  });

  it.each(SHAPES)('%s refuses a per-call apiKey, without repeating it', async (_name, call) => {
    const err = await rejection(call({ apiKey: 'sk-secret-value' }));

    expect(err).toBeInstanceOf(VertexOpenAIConfigError);
    expect((err as VertexOpenAIConfigError).setting).toBe('apiKey');
    expect((err as Error).message).toBe(
      'Vertex AI takes no API key: it authenticates with Google Cloud credentials. Remove the per-call apiKey.'
    );
    expect(tokenSource).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts apiKey: null, as on every adapter', async () => {
    answer(textBody());
    await expect(chat({ ...BASE, apiKey: null })).resolves.toMatchObject({ content: 'ok' });
  });
});

describe('@verevoir/llm/vertex-openai — the model', () => {
  it.each(SHAPES)('%s sends the named model exactly as given', async (_name, call) => {
    answer(textBody());

    const { usage } = await call({ model: 'meta/llama-4-maverick-17b-128e-instruct-maas' });

    expect(requests().map((r) => r.body.model)).toEqual([
      'meta/llama-4-maverick-17b-128e-instruct-maas',
    ]);
    expect(usage.model).toBe('meta/llama-4-maverick-17b-128e-instruct-maas');
  });

  it.each(SHAPES)(
    '%s refuses a call that names no model, before any token or request',
    async (_name, call) => {
      for (const model of [undefined, '', '   ']) {
        const err = await rejection(call({ model, modelClass: 'extraction' }));

        expect(err).toBeInstanceOf(VertexOpenAIConfigError);
        expect((err as VertexOpenAIConfigError).setting).toBe('model');
        expect((err as Error).message).toBe(
          'No model: this route has no default model. Pass `model` as <publisher>/<model>.'
        );
        expect(classifyLlmError(err)).toEqual({ kind: 'other', retryable: false });
      }
      expect(tokenSource).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('keeps the class asked for as the usage direction', async () => {
    answer(textBody());

    const withClass = await chat({ ...BASE, modelClass: 'extraction' });
    const withoutClass = await chat(BASE);

    expect(withClass.usage.direction).toBe('extraction');
    expect(withoutClass.usage.direction).toBe('reasoning');
  });
});

describe('@verevoir/llm/vertex-openai — the project and the location', () => {
  it.each([[undefined], ['   ']])(
    'refuses when the project is %j, naming the setting and nothing else',
    async (value) => {
      if (value === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = value;
      // The Claude-on-Vertex project is not a fallback.
      process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'other-project';

      for (const [, call] of SHAPES) {
        const err = await rejection(call());
        expect(err).toBeInstanceOf(VertexOpenAIConfigError);
        expect((err as VertexOpenAIConfigError).setting).toBe('GOOGLE_CLOUD_PROJECT');
        expect((err as Error).message).toBe('No Vertex AI project: set GOOGLE_CLOUD_PROJECT.');
        expect(classifyLlmError(err)).toEqual({ kind: 'other', retryable: false });
      }
      expect(tokenSource).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['GOOGLE_CLOUD_PROJECT', 'proj/../x', 'GOOGLE_CLOUD_PROJECT is not a Google Cloud project id.'],
    ['GOOGLE_CLOUD_PROJECT', 'proj?x=1', 'GOOGLE_CLOUD_PROJECT is not a Google Cloud project id.'],
    [
      'GOOGLE_CLOUD_LOCATION',
      'evil.example/x',
      'GOOGLE_CLOUD_LOCATION is not a Vertex AI location.',
    ],
    [
      'GOOGLE_CLOUD_LOCATION',
      'evil.example#',
      'GOOGLE_CLOUD_LOCATION is not a Vertex AI location.',
    ],
    ['GOOGLE_CLOUD_LOCATION', 'us@host', 'GOOGLE_CLOUD_LOCATION is not a Vertex AI location.'],
  ])(
    'refuses a %s that could change the host or the path, without repeating it',
    async (name, value, message) => {
      process.env[name] = value;

      const err = await rejection(chat(BASE));

      expect(err).toBeInstanceOf(VertexOpenAIConfigError);
      expect((err as VertexOpenAIConfigError).setting).toBe(name);
      expect((err as Error).message).toBe(message);
      expect(tokenSource).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('@verevoir/llm/vertex-openai — usage', () => {
  it('reports the provider, the route, the response id and the counts the endpoint gives', async () => {
    answer(
      textBody({
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
        prompt_tokens_details: null,
        extra_properties: { google: { traffic_type: 'ON_DEMAND' } },
      })
    );

    const { usage } = await chat(BASE);

    expect(usage).toEqual({
      provider: 'vertex-openai',
      model: MODEL,
      direction: 'reasoning',
      route: 'google-cloud',
      inputTokens: 12,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      providerRequestId: 'chatcmpl-1',
    });
  });

  it.each(SHAPES)('%s reports route google-cloud', async (_name, call) => {
    answer(textBody());
    expect((await call()).usage.route).toBe('google-cloud');
  });

  it('adds reasoning tokens to output when the total shows them outside completion_tokens', async () => {
    answer(
      textBody({
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 30 },
        prompt_tokens_details: null,
      })
    );

    const { usage } = await chat(BASE);

    expect(usage.outputTokens).toBe(38);
    expect(usage.inputTokens).toBe(12);
  });

  it('does not add reasoning tokens when the total shows them inside completion_tokens', async () => {
    answer(
      textBody({
        prompt_tokens: 12,
        completion_tokens: 38,
        total_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 30 },
      })
    );

    const { usage } = await chat(BASE);

    expect(usage.outputTokens).toBe(38);
  });

  it('does not add reasoning tokens when the response has no total', async () => {
    answer(
      textBody({
        prompt_tokens: 12,
        completion_tokens: 8,
        completion_tokens_details: { reasoning_tokens: 30 },
      })
    );

    const { usage } = await chat(BASE);

    expect(usage.outputTokens).toBe(8);
  });

  it('sums reasoning tokens across a tool loop', async () => {
    const apart = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 22,
      completion_tokens_details: { reasoning_tokens: 7 },
    };
    answerInOrder(toolCallBody(apart), textBody(apart));

    const { usage } = await chatWithToolLoop({
      ...BASE,
      tools: [TOOL],
      executor: async () => 'looked up',
    });

    expect(usage.outputTokens).toBe(24);
    expect(usage.inputTokens).toBe(20);
  });

  it('reports a cache read only when the endpoint reports one', async () => {
    answer(
      textBody({
        prompt_tokens: 12,
        completion_tokens: 8,
        total_tokens: 20,
        prompt_tokens_details: { cached_tokens: 5 },
      })
    );

    const { usage } = await chat(BASE);

    expect(usage.cacheReadInputTokens).toBe(5);
    expect(usage.inputTokens).toBe(7);
    expect(usage.cacheCreationInputTokens).toBe(0);
  });

  it('adds no price: a model name the price book does not hold is unpriced', async () => {
    answer(textBody());

    const { usage } = await chat({ ...BASE, model: 'some-publisher/a-model-in-no-price-table' });

    // The bundled price table, never refreshed.
    const book = createPriceBook({
      fetch: () => {
        throw new Error('must not fetch — this book is never start()-ed');
      },
    });
    expect(book.costOf(usage)).toEqual({
      unpriced:
        'no price entry for model "some-publisher/a-model-in-no-price-table" (provider "vertex-openai")',
    });
  });
});

describe('@verevoir/llm/vertex-openai — failures', () => {
  it.each([
    [401, 'authentication'],
    [403, 'permission'],
    [404, 'invalid-request'],
    [400, 'invalid-request'],
  ] as const)('rejects with the SDK error itself on a %i, classified %s', async (status, kind) => {
    answer({ error: { message: 'refused', status: 'REFUSED' } }, status);

    const err = await rejection(chat(BASE));

    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).status).toBe(status);
    expect(classifyLlmError(err)).toEqual({ kind, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a 429',
      () => answer({ error: { message: 'slow down', status: 'RESOURCE_EXHAUSTED' } }, 429),
      429,
      { kind: 'rate-limited', retryable: true },
    ],
    [
      'a 504',
      () => answer({ error: { message: 'gateway timeout', status: 'DEADLINE_EXCEEDED' } }, 504),
      504,
      { kind: 'unavailable', retryable: true },
    ],
    [
      'a connection failure',
      () =>
        fetchMock.mockImplementation(async () => {
          throw new TypeError('fetch failed');
        }),
      undefined,
      { kind: 'unavailable', retryable: true },
    ],
  ] as const)(
    'sends %s met every time only as often as the library retry policy allows, each request with a token freshly asked for',
    async (_name, arrange, status, failure) => {
      arrange();
      let asked = 0;
      tokenSource.mockReset();
      tokenSource.mockImplementation(async () => `tok-${++asked}`);
      const retries: ChatRetryInfo[] = [];

      // Every wait, the policy's backoffs included, runs on fake timers.
      vi.useFakeTimers();
      let err: unknown;
      try {
        const settled = rejection(
          chat({
            ...BASE,
            onRetry: async (info) => {
              retries.push(info);
            },
          })
        );
        await vi.runAllTimersAsync();
        err = await settled;
      } finally {
        vi.useRealTimers();
      }

      expect(err).toBeInstanceOf(status === undefined ? APIConnectionError : APIError);
      expect((err as APIError).status).toBe(status);
      expect(classifyLlmError(err)).toEqual(failure);

      // `callWithRetries` tells `onRetry` how many retries it allows. One
      // first attempt, then that many, and nothing from the SDK on top.
      const allowed = retries[0]?.maxAttempts ?? 0;
      expect(allowed).toBeGreaterThan(0);
      expect(retries.map((r) => r.attempt)).toEqual(
        Array.from({ length: allowed }, (_, i) => i + 1)
      );
      expect(fetchMock).toHaveBeenCalledTimes(1 + allowed);

      expect(tokenSource).toHaveBeenCalledTimes(1 + allowed);
      expect(requests().map((r) => r.headers.get('authorization'))).toEqual(
        Array.from({ length: 1 + allowed }, (_, i) => `Bearer tok-${i + 1}`)
      );
    }
  );

  it.each(SHAPES)(
    '%s sends a 400 once: one request, one token asked for, no retry',
    async (_name, call) => {
      answer({ error: { message: 'refused', status: 'INVALID_ARGUMENT' } }, 400);
      const onRetry = vi.fn(async () => {});

      const err = await rejection(call({ onRetry }));

      expect((err as APIError).status).toBe(400);
      expect(onRetry).not.toHaveBeenCalled();
      expect(tokenSource).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each(SHAPES)(
    '%s rejects with a VertexOpenAITokenError when the token source fails: other, not retryable, never retried, nothing sent',
    async (_name, call) => {
      // Text a retry rule or a status reader could mistake for the endpoint's answer.
      const cause = Object.assign(new Error('503 service unavailable, 429 rate limit'), {
        status: 400,
      });
      tokenSource.mockReset();
      tokenSource.mockRejectedValue(cause);

      const err = await rejection(call());

      expect(err).toBeInstanceOf(VertexOpenAITokenError);
      expect((err as Error).message).toBe(
        'Could not obtain a Google Cloud access token for Vertex AI. No request was sent.'
      );
      expect((err as Error).cause).toBe(cause);
      expect((err as { status?: unknown }).status).toBeUndefined();
      expect(classifyLlmError(err)).toEqual({ kind: 'other', retryable: false });
      expect(tokenSource).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([[null], [undefined], ['']])(
    'rejects with a VertexOpenAITokenError when the token source answers %j',
    async (token) => {
      tokenSource.mockReset();
      tokenSource.mockResolvedValue(token);

      const err = await rejection(chat(BASE));

      expect(err).toBeInstanceOf(VertexOpenAITokenError);
      expect((err as Error).cause).toBeUndefined();
      expect(classifyLlmError(err)).toEqual({ kind: 'other', retryable: false });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe('@verevoir/llm/vertex-openai — the token stays out of errors, spans and logs', () => {
  const CANARY = 'ya29.CANARY-TOKEN-0d4c1f';
  let exporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
  });

  afterAll(async () => {
    trace.disable();
    await tracerProvider.shutdown();
  });

  it('a seeded token reaches the Authorization header and nothing else', async () => {
    exporter.reset();
    const logged: unknown[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const modelSpans: ModelSpan[] = [];
    setModelSpanSink((s) => modelSpans.push(s));
    const hooked: TokenUsage[] = [];
    const onUsage = async (u: TokenUsage) => {
      hooked.push(u);
    };
    const results: unknown[] = [];
    const errors: unknown[] = [];

    tokenSource.mockReset();
    tokenSource.mockResolvedValue(CANARY);

    // Every shape, answered.
    answer(textBody());
    for (const [, call] of SHAPES) results.push(await call({ onUsage }));
    // A reply cut short, which the adapter logs.
    answer({ ...textBody(), choices: [{ message: { content: 'cut' }, finish_reason: 'length' }] });
    results.push(await chat({ ...BASE, onUsage }));
    // Every shape, refused by the endpoint.
    answer({ error: { message: 'refused', status: 'UNAUTHENTICATED' } }, 401);
    for (const [, call] of SHAPES) errors.push(await rejection(call({ onUsage })));
    // A loop whose final call is refused, which the adapter logs with the error.
    answerInOrder(toolCallBody());
    fetchMock.mockImplementation(async () => json({ error: { message: 'refused' } }, 403));
    results.push(
      await chatWithToolLoop({
        ...BASE,
        tools: [TOOL],
        executor: async () => 'looked up',
        maxIterations: 1,
        onUsage,
      })
    );
    // The token source failing after it has already given the token out.
    tokenSource.mockRejectedValue(new Error('refresh failed'));
    for (const [, call] of SHAPES) errors.push(await rejection(call({ onUsage })));
    // The library's own refusals.
    errors.push(await rejection(chat({ ...BASE, model: undefined })));
    delete process.env.GOOGLE_CLOUD_PROJECT;
    errors.push(await rejection(chat(BASE)));

    // The scenario ran: the token was sent, things were logged, spans ended.
    const sent = requests().map((r) => r.headers.get('authorization'));
    expect(sent.length).toBeGreaterThan(8);
    expect(new Set(sent)).toEqual(new Set([`Bearer ${CANARY}`]));
    expect(errors).toHaveLength(8);
    expect(errors.every((e) => e instanceof Error)).toBe(true);
    expect(logged.length).toBeGreaterThanOrEqual(2);
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(sent.length + 3);
    expect(modelSpans.length).toBeGreaterThan(0);

    const deep = (value: unknown) =>
      inspect(value, { depth: Infinity, showHidden: true, maxStringLength: Infinity });
    const errorText = errors.map(
      (e) => deep(e) + String((e as Error).stack) + JSON.stringify(e, Object.getOwnPropertyNames(e))
    );
    const spanText = spans.map((s) =>
      deep([s.name, s.attributes, s.events, s.status, s.resource.attributes])
    );
    for (const text of [errorText, spanText, logged, modelSpans, hooked, results].map(deep)) {
      expect(text).not.toContain('CANARY');
    }
  });
});
