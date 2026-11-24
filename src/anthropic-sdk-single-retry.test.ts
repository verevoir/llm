/**
 * The adapters that send through the Anthropic SDK (`/anthropic` and
 * `/vertex`) retry at one layer only: the library's own policy, which each is
 * handed its caller's `abortSignal`. Each test counts the requests that reach
 * `fetch`, with the real SDK client in between (the real `Anthropic`, and the
 * real `AnthropicVertex`), so a retry the SDK made on its own would be counted
 * too. (The adapters' other tests replace the SDK's `messages.stream`, and so
 * cannot see what the SDK does beneath it.) Every request these adapters make
 * is streamed: `chat`, `chatWithTools` and `chatWithToolLoop` all go through
 * `messages.stream`, so there is no call shape that is not. No network; every
 * wait, the SDK's request timeout included, runs on fake timers.
 *
 * The Vertex client is the real one, built by `./vertex/client.ts` with the
 * options that module gives it. Only its credential is replaced: the module
 * builds the client with no credential option, which sends the SDK to Google
 * Cloud's credentials flow, and that flow reaches the network through its own
 * HTTP client, which no fake `fetch` given here would stand in for. So the
 * class is wrapped to add a fake `authClient`, and nothing else.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const vertexOptions = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('@anthropic-ai/vertex-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@anthropic-ai/vertex-sdk')>();
  type Options = ConstructorParameters<typeof actual.AnthropicVertex>[0];
  const authClient = {
    getRequestHeaders: async () => new Headers({ authorization: 'Bearer fake-token' }),
  } as unknown as NonNullable<Options>['authClient'];
  class AnthropicVertex extends actual.AnthropicVertex {
    constructor(options: Options = {}) {
      vertexOptions.push({ ...options });
      super({ ...options, authClient });
    }
  }
  return { ...actual, AnthropicVertex };
});

import Anthropic from '@anthropic-ai/sdk';
import type { ChatRetryInfo, ToolDef } from './index.js';
import * as anthropic from './anthropic/index.js';
import { resetClientStateForTests } from './anthropic/client.js';
import * as vertex from './vertex/index.js';
import { resetClientForTests } from './vertex/client.js';
import { RETRY_BACKOFFS_MS, TIMEOUT_RETRIES } from './retry-policy.js';

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

type StreamEvent = { type: string } & Record<string, unknown>;

/** A 200 whose body is these server-sent events, then the end of the stream;
 * or, with `cutOff`, the connection failing where the events stop. */
function eventStream(events: StreamEvent[], cutOff = false): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        );
      }
      if (cutOff) controller.error(new TypeError('terminated'));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** The events of a stream up to and including `text`, with no end. */
const opening = (text: string): StreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
];

/** A whole streamed answer in text, with no tool call. */
const answered = (text: string): Response =>
  eventStream([
    ...opening(text),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]);

/** A stream that opens with a 200, delivers `text`, and then reports an error
 * of this type: how the API reports a failure part-way through an answer. */
const failedPartWay = (text: string, errorType: string): Response =>
  eventStream([
    ...opening(text),
    { type: 'error', error: { type: errorType, message: 'the stream failed' } },
  ]);

const ANSWER = 'the whole answer';
const PARTIAL = 'half an ans';

const BASE = { systemPrompt: 'sys', turns: [{ role: 'user' as const, content: 'hi' }] };
const TOOL: ToolDef = {
  name: 'lookup',
  description: 'Look something up',
  input_schema: { type: 'object', properties: {} },
};

type Extra = {
  apiKey?: string;
  onRetry?: (info: ChatRetryInfo) => Promise<void>;
  abortSignal?: AbortSignal;
};
/** Make a call of one shape, and give back the text it answered with. */
type Call = (extra: Extra) => Promise<string>;

/** The three call shapes of an adapter built on the shared implementation. */
const shapes = (a: typeof anthropic | typeof vertex): [string, Call][] => [
  ['chat', async (extra) => (await a.chat({ ...BASE, ...extra })).content],
  [
    'chatWithTools',
    async (extra) => (await a.chatWithTools({ ...BASE, ...extra, tools: [TOOL] })).text,
  ],
  [
    'chatWithToolLoop',
    async (extra) =>
      (
        await a.chatWithToolLoop({
          ...BASE,
          ...extra,
          tools: [TOOL],
          executor: async () => 'looked up',
        })
      ).text,
  ],
];

/** Every way a client is built. The direct route builds one per call for a
 * per-call key and keeps one for the environment's credential, which is an
 * API key or a subscription token; the Vertex route keeps one. */
const ROUTES: {
  name: string;
  env: Record<string, string>;
  key: Extra;
  shapes: [string, Call][];
}[] = [
  { name: 'anthropic', env: {}, key: { apiKey: 'per-call-key' }, shapes: shapes(anthropic) },
  {
    name: 'anthropic',
    env: { ANTHROPIC_API_KEY: 'environment-key' },
    key: {},
    shapes: shapes(anthropic),
  },
  {
    name: 'anthropic',
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'environment-token' },
    key: {},
    shapes: shapes(anthropic),
  },
  {
    name: 'vertex',
    env: { ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLOUD_ML_REGION: 'region' },
    key: {},
    shapes: shapes(vertex),
  },
];

const credentialOf = (env: Record<string, string>, key: Extra): string =>
  key.apiKey ? 'a per-call key' : `${Object.keys(env).join(' and ')} set`;

const CASES = ROUTES.flatMap(({ name, env, key, shapes: routeShapes }) =>
  routeShapes.map(([shape, call]) => ({
    title: `${name}.${shape} with ${credentialOf(env, key)}`,
    env,
    key,
    call,
  }))
);

const ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLOUD_ML_REGION',
];
const saved: Record<string, string | undefined> = {};

// A client takes the global `fetch` when it is built: the fake is in place
// for the whole file, and each test starts with no kept client.
beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockReset();
  vertexOptions.length = 0;
  resetClientStateForTests();
  resetClientForTests();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const refuse = (status: number, headers?: Record<string, string>) => () =>
  fetchMock.mockImplementation(async () =>
    json({ type: 'error', error: { type: 'refused_error', message: 'refused' } }, status, headers)
  );

/** `fetch` rejects, as it does when no connection can be made. */
function failToConnect(): void {
  fetchMock.mockImplementation(async () => {
    throw new TypeError('fetch failed');
  });
}

/** `fetch` never answers. It rejects only when the SDK aborts the request,
 * which the SDK does when its own request timeout runs out. */
function neverAnswer(): void {
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      })
  );
}

interface Outcome {
  resolved: boolean;
  text?: string;
  error?: unknown;
  retries: ChatRetryInfo[];
}

/** Make the call, run every wait it starts on the fake clock, and say how it
 * ended and what `onRetry` was told. */
async function run(call: Call, key: Extra): Promise<Outcome> {
  const retries: ChatRetryInfo[] = [];
  let outcome: Outcome | undefined;
  void call({
    ...key,
    onRetry: async (info) => {
      retries.push(info);
    },
  }).then(
    (text) => (outcome = { resolved: true, text, retries }),
    (error: unknown) => (outcome = { resolved: false, error, retries })
  );
  do {
    await vi.runAllTimersAsync();
  } while (!outcome);
  return outcome;
}

const statusOf = (error: unknown) => (error as { status?: number }).status;
const typeOf = (error: unknown) => (error as { type?: unknown }).type;
const classOf = (error: unknown) => (error as Error).constructor.name;

/** The retries the policy allows, from its own list of waits. */
const RETRIES = RETRY_BACKOFFS_MS.length;

type Row = [name: string, arrange: () => void, thrown: (error: unknown) => void];

/** Every failure the policy retries on its list of waits: how to produce it,
 * and what is thrown once the retries are spent. */
const RETRIED: Row[] = [
  ...[408, 409, 429, 500, 502, 503, 504, 529].map((status): Row => [
    `a ${status}`,
    refuse(status),
    (error) => expect(statusOf(error)).toBe(status),
  ]),
  [
    'a connection failure (fetch rejects)',
    failToConnect,
    (error) => expect(classOf(error)).toBe('APIConnectionError'),
  ],
  [
    'a 400 with x-should-retry: true',
    refuse(400, { 'x-should-retry': 'true' }),
    (error) => expect(statusOf(error)).toBe(400),
  ],
  ...['overloaded_error', 'rate_limit_error', 'api_error', 'timeout_error'].map((type): Row => [
    `a stream that fails part-way with ${type}`,
    () => fetchMock.mockImplementation(async () => failedPartWay(PARTIAL, type)),
    (error) => {
      expect(statusOf(error)).toBeUndefined();
      expect(typeOf(error)).toBe(type);
    },
  ]),
];

/** Every failure sent once and thrown. */
const NOT_RETRIED: Row[] = [
  ...[400, 401, 403, 404, 422].map((status): Row => [
    `a ${status}`,
    refuse(status),
    (error) => expect(statusOf(error)).toBe(status),
  ]),
  ...[429, 503].map((status): Row => [
    `a ${status} with x-should-retry: false`,
    refuse(status, { 'x-should-retry': 'false' }),
    (error) => expect(statusOf(error)).toBe(status),
  ]),
  [
    'a stream that fails part-way with invalid_request_error',
    () => fetchMock.mockImplementation(async () => failedPartWay(PARTIAL, 'invalid_request_error')),
    (error) => expect(typeOf(error)).toBe('invalid_request_error'),
  ],
  [
    'a stream cut off part-way with no error event',
    () => fetchMock.mockImplementation(async () => eventStream(opening(PARTIAL), true)),
    (error) => expect(classOf(error)).toBe('AnthropicError'),
  ],
];

it('the policy allows at least one retry, so no count below is vacuous', () => {
  expect(RETRIES).toBeGreaterThan(0);
});

describe.each(CASES)('$title: the library retry policy is the only one', ({ env, key, call }) => {
  beforeEach(() => {
    Object.assign(process.env, env);
  });

  it.each(RETRIED)(
    'sends %s answered every time once, then once per retry the policy allows, telling onRetry of each',
    async (_name, arrange, thrown) => {
      arrange();

      const { resolved, error, retries } = await run(call, key);

      expect(resolved).toBe(false);
      thrown(error);
      expect(fetchMock).toHaveBeenCalledTimes(1 + RETRIES);
      expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
        RETRY_BACKOFFS_MS.map((delayMs, i) => [i + 1, RETRIES, delayMs])
      );
    }
  );

  it.each(NOT_RETRIED)(
    'sends %s once, and onRetry is not called',
    async (_name, arrange, thrown) => {
      arrange();

      const { resolved, error, retries } = await run(call, key);

      expect(resolved).toBe(false);
      thrown(error);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(retries).toEqual([]);
    }
  );

  it.each([
    ['a 429', () => json({ type: 'error', error: { type: 'e', message: 'slow down' } }, 429)],
    ['a 529', () => json({ type: 'error', error: { type: 'e', message: 'overloaded' } }, 529)],
    [
      'a connection failure',
      (): Response => {
        throw new TypeError('fetch failed');
      },
    ],
  ])(
    'sends a request that meets %s and then succeeds twice, and delivers one answer',
    async (_name, firstAnswer) => {
      fetchMock.mockImplementation(async () => answered(ANSWER));
      fetchMock.mockImplementationOnce(async () => firstAnswer());

      const { resolved, text, retries } = await run(call, key);

      expect(resolved).toBe(true);
      expect(text).toBe(ANSWER);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(retries.map((r) => r.attempt)).toEqual([1]);
    }
  );

  it('answers with the retry alone when the first stream delivered part of an answer and then failed', async () => {
    fetchMock.mockImplementation(async () => answered(ANSWER));
    fetchMock.mockImplementationOnce(async () => failedPartWay(PARTIAL, 'overloaded_error'));

    const { resolved, text, retries } = await run(call, key);

    expect(resolved).toBe(true);
    expect(text).toBe(ANSWER);
    expect(text).not.toContain(PARTIAL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries.map((r) => [r.attempt, r.delayMs])).toEqual([[1, RETRY_BACKOFFS_MS[0]]]);
  });

  it("sends a request never answered once, then TIMEOUT_RETRIES times more with no wait: the SDK's request timeout each time, and nothing between", async () => {
    neverAnswer();
    const began = Date.now();

    const { resolved, error, retries } = await run(call, key);

    expect(resolved).toBe(false);
    expect(classOf(error)).toBe('APIConnectionTimeoutError');
    expect(fetchMock).toHaveBeenCalledTimes(1 + TIMEOUT_RETRIES);
    expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
      Array.from({ length: TIMEOUT_RETRIES }, (_, i) => [i + 1, RETRIES, 0])
    );
    expect(Date.now() - began).toBe((1 + TIMEOUT_RETRIES) * Anthropic.DEFAULT_TIMEOUT);
  });

  it.each(RETRY_BACKOFFS_MS.map((ms, i) => [i + 1, ms / 1000, i] as const))(
    "an abort of the caller's signal during wait %i (%i s) ends the call at once with the signal's reason, and no further request is sent",
    async (_n, _seconds, i) => {
      refuse(503)();
      const controller = new AbortController();
      const reason = new Error('the caller gave up');
      let ended: { error: unknown } | undefined;
      void call({ ...key, abortSignal: controller.signal }).then(
        () => (ended = { error: undefined }),
        (error: unknown) => (ended = { error })
      );

      // To the middle of this wait: every wait before it has run out.
      const waited = RETRY_BACKOFFS_MS.slice(0, i).reduce((a, b) => a + b, 0);
      await vi.advanceTimersByTimeAsync(waited + RETRY_BACKOFFS_MS[i] / 2);
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      expect(ended).toBeUndefined();

      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(ended).toEqual({ error: reason });
      expect(ended?.error).toBe(reason);
      await vi.runAllTimersAsync();
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
    }
  );

  it("sends nothing when the caller's signal is aborted before the call", async () => {
    fetchMock.mockImplementation(async () => answered(ANSWER));
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    controller.abort(reason);

    const { resolved, error, retries } = await run(call, {
      ...key,
      abortSignal: controller.signal,
    });

    expect(resolved).toBe(false);
    expect(error).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(retries).toEqual([]);
  });
});

describe('the real clients these counts are taken through', () => {
  it("the Vertex client is built by the route's own module, with the SDK's retries off, and reaches Vertex AI's address", async () => {
    Object.assign(process.env, { ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLOUD_ML_REGION: 'region' });
    fetchMock.mockImplementation(async () => answered(ANSWER));

    await run(shapes(vertex)[0][1], {});

    expect(vertexOptions).toEqual([{ projectId: 'proj', region: 'region', maxRetries: 0 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(
      /^https:\/\/region-aiplatform\.googleapis\.com\/.*\/projects\/proj\/locations\/region\/.*:streamRawPredict$/
    );
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-token');
  });

  it("the direct client reaches the Messages API's address", async () => {
    process.env.ANTHROPIC_API_KEY = 'environment-key';
    fetchMock.mockImplementation(async () => answered(ANSWER));

    await run(shapes(anthropic)[0][1], {});

    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages');
  });

  it('a progress report the failed stream completed is reported then, and again by the retry: the one thing a retry can deliver twice', async () => {
    process.env.ANTHROPIC_API_KEY = 'environment-key';
    const [start, textStart, textDelta] = opening(ANSWER);
    const progress: StreamEvent[] = [
      start,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'report_progress', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"percent":40,"message":"working"}' },
      },
      { type: 'content_block_stop', index: 0 },
    ];
    fetchMock.mockImplementation(async () =>
      eventStream([
        ...progress,
        { ...textStart, index: 1 },
        { ...textDelta, index: 1 },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ])
    );
    fetchMock.mockImplementationOnce(async () =>
      eventStream([
        ...progress,
        { type: 'error', error: { type: 'overloaded_error', message: 'the stream failed' } },
      ])
    );
    const reported: unknown[] = [];
    const call: Call = async (extra) =>
      (
        await anthropic.chat({
          ...BASE,
          ...extra,
          onProgress: async (info) => {
            reported.push(info);
          },
        })
      ).content;

    const { resolved, text } = await run(call, {});

    expect(resolved).toBe(true);
    expect(text).toBe(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reported).toEqual([
      { percent: 40, message: 'working' },
      { percent: 40, message: 'working' },
    ]);
  });

  it('a subscription token rejected with a 401 is sent once, and the call is made once more on the metered key', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-token';
    process.env.ANTHROPIC_API_KEY = 'environment-key';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchMock.mockImplementation(async () => answered(ANSWER));
    fetchMock.mockImplementationOnce(async () =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'no' } }, 401)
    );

    const { resolved, text, retries } = await run(shapes(anthropic)[0][1], {});
    stderr.mockRestore();

    expect(resolved).toBe(true);
    expect(text).toBe(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([]);
  });
});
