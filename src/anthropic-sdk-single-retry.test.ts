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
 * Two SDK paths are here: the direct `Anthropic` client and `AnthropicVertex`.
 * The full-row site of each, marked by `fullRows` on its route, runs every row
 * of the shared driver, all the stream failures with them: every call shape
 * consumes its stream through one function (`callStreamed` in
 * `./anthropic/adapter.ts`), so a stream failure is classified per path. Every
 * other credential route and call shape runs the rows a site can break on its
 * own, with a stream that fails part-way with a retried error among them, and
 * every site answers with the retry alone after a stream that failed part-way.
 *
 * The Vertex client is the real one, built by `./vertex/client.ts` with the
 * options that module gives it. Only its credential is replaced: the module
 * builds the client with no credential option, which sends the SDK to Google
 * Cloud's credentials flow, and that flow reaches the network through its own
 * HTTP client, which no fake `fetch` given here would stand in for. So the
 * class is wrapped to add a fake `authClient`, and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { ToolDef } from './index.js';
import * as anthropic from './anthropic/index.js';
import { resetClientStateForTests } from './anthropic/client.js';
import * as vertex from './vertex/index.js';
import { resetClientForTests } from './vertex/client.js';
import { RETRY_BACKOFFS_MS } from './retry-policy.js';
import {
  classOf,
  fetchMock,
  isolateEnv,
  json,
  pathRows,
  run,
  siteRows,
  statusOf,
  useFakeFetch,
  type Call,
  type Extra,
  type Row,
  type Site,
} from './test-support/fetch-driver.js';

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

/** A whole streamed answer that asks for the tool, and says nothing. */
const toolAsked = (id: string): Response =>
  eventStream([
    opening('')[0],
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name: 'lookup', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]);

const ANSWER = 'the whole answer';
const PARTIAL = 'half an ans';

const BASE = { systemPrompt: 'sys', turns: [{ role: 'user' as const, content: 'hi' }] };
const TOOL: ToolDef = {
  name: 'lookup',
  description: 'Look something up',
  input_schema: { type: 'object', properties: {} },
};

type Shape = 'chat' | 'chatWithTools' | 'chatWithToolLoop';

/** The three call shapes of an adapter built on the shared implementation. */
const shapes = (a: typeof anthropic | typeof vertex): Record<Shape, Call> => ({
  chat: async (extra) => (await a.chat({ ...BASE, ...extra })).content,
  chatWithTools: async (extra) =>
    (await a.chatWithTools({ ...BASE, ...extra, tools: [TOOL] })).text,
  chatWithToolLoop: async (extra) =>
    (
      await a.chatWithToolLoop({
        ...BASE,
        ...extra,
        tools: [TOOL],
        executor: async () => 'looked up',
      })
    ).text,
});

/** The SDK paths here: the direct `Anthropic` client, and `AnthropicVertex`. */
const SDK_PATHS = ['Anthropic', 'AnthropicVertex'] as const;

/** Every way a client is built. The direct route builds one per call for a
 * per-call key and keeps one for the environment's credential, which is an
 * API key or a subscription token; the Vertex route keeps one. `fullRows`
 * names the call shape that is its SDK path's full-row site. */
const ROUTES: {
  name: string;
  sdkPath: (typeof SDK_PATHS)[number];
  env: Record<string, string>;
  key: Extra;
  adapter: typeof anthropic | typeof vertex;
  fullRows?: Shape;
}[] = [
  {
    name: 'anthropic',
    sdkPath: 'Anthropic',
    env: {},
    key: { apiKey: 'per-call-key' },
    adapter: anthropic,
  },
  {
    name: 'anthropic',
    sdkPath: 'Anthropic',
    env: { ANTHROPIC_API_KEY: 'environment-key' },
    key: {},
    adapter: anthropic,
    fullRows: 'chat',
  },
  {
    name: 'anthropic',
    sdkPath: 'Anthropic',
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'environment-token' },
    key: {},
    adapter: anthropic,
  },
  {
    name: 'vertex',
    sdkPath: 'AnthropicVertex',
    env: { ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLOUD_ML_REGION: 'region' },
    key: {},
    adapter: vertex,
    fullRows: 'chat',
  },
];

const credentialOf = (env: Record<string, string>, key: Extra): string =>
  key.apiKey ? 'a per-call key' : `${Object.keys(env).join(' and ')} set`;

const typeOf = (error: unknown) => (error as { type?: unknown }).type;

const refusal = (status: number, headers?: Record<string, string>): Response =>
  json({ type: 'error', error: { type: 'refused_error', message: 'refused' } }, status, headers);

const CASES = ROUTES.flatMap(({ name, sdkPath, env, key, adapter, fullRows }) =>
  Object.entries(shapes(adapter)).map(([shape, call]) => {
    const site: Site = {
      call,
      key,
      refusal,
      answer: () => answered(ANSWER),
      text: ANSWER,
      timeoutMs: Anthropic.DEFAULT_TIMEOUT,
    };
    return {
      title: `${name}.${shape} with ${credentialOf(env, key)}`,
      sdkPath,
      env,
      site,
      fullRows: shape === fullRows,
    };
  })
);

useFakeFetch();
isolateEnv([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLOUD_ML_REGION',
]);

// Each test starts with no kept client.
beforeEach(() => {
  vertexOptions.length = 0;
  resetClientStateForTests();
  resetClientForTests();
});

const failingPartWay = (type: string) => () =>
  fetchMock.mockImplementation(async () => failedPartWay(PARTIAL, type));

/** The failures only a streamed answer meets: retried, and sent once. */
const STREAM_RETRIED: Row[] = [
  'overloaded_error',
  'rate_limit_error',
  'api_error',
  'timeout_error',
].map((type): Row => [
  `a stream that fails part-way with ${type}`,
  failingPartWay(type),
  (error) => {
    expect(statusOf(error)).toBeUndefined();
    expect(typeOf(error)).toBe(type);
  },
]);
const STREAM_NOT_RETRIED: Row[] = [
  [
    'a stream that fails part-way with invalid_request_error',
    failingPartWay('invalid_request_error'),
    (error) => expect(typeOf(error)).toBe('invalid_request_error'),
  ],
  [
    'a stream cut off part-way with no error event',
    () => fetchMock.mockImplementation(async () => eventStream(opening(PARTIAL), true)),
    (error) => expect(classOf(error)).toBe('AnthropicError'),
  ],
];

it('the policy allows at least one retry, so no count the rows make is vacuous', () => {
  expect(RETRY_BACKOFFS_MS.length).toBeGreaterThan(0);
});

it.each(SDK_PATHS)('the %s SDK path has exactly one full-row site', (sdkPath) => {
  expect(CASES.filter((c) => c.sdkPath === sdkPath && c.fullRows)).toHaveLength(1);
});

describe.each(CASES)(
  '$title: the library retry policy is the only one',
  ({ env, site, fullRows }) => {
    beforeEach(() => {
      Object.assign(process.env, env);
    });

    if (fullRows) {
      pathRows(site, {
        retried: STREAM_RETRIED,
        notRetried: STREAM_NOT_RETRIED,
        recoversFrom: [529],
      });
    } else {
      siteRows(site, { retried: [STREAM_RETRIED[0]] });
    }

    it('answers with the retry alone when the first stream delivered part of an answer and then failed', async () => {
      fetchMock.mockImplementation(async () => answered(ANSWER));
      fetchMock.mockImplementationOnce(async () => failedPartWay(PARTIAL, 'overloaded_error'));

      const { resolved, text, retries } = await run(site.call, site.key);

      expect(resolved).toBe(true);
      expect(text).toBe(ANSWER);
      expect(text).not.toContain(PARTIAL);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(retries.map((r) => [r.attempt, r.delayMs])).toEqual([[1, RETRY_BACKOFFS_MS[0]]]);
    });
  }
);

/** The body of the request `fetch` was given on its `n`th call, from 1. */
const bodyOf = (n: number): Record<string, unknown> =>
  JSON.parse(String(fetchMock.mock.calls[n - 1][1]?.body)) as Record<string, unknown>;

describe.each(
  ROUTES.map((route) => ({
    ...route,
    title: `${route.name}.chatWithToolLoop with ${credentialOf(route.env, route.key)}`,
  }))
)("$title: the request after the loop's iteration cap", ({ env, key, adapter }) => {
  const CAP = 2;

  beforeEach(() => {
    Object.assign(process.env, env);
  });

  it("an abort of the caller's signal during the wait after that request is answered 503 ends the call at once with the signal's reason, and no further request is sent", async () => {
    // The model asks for the tool on every iteration; what follows is a 503.
    fetchMock.mockImplementation(async () =>
      fetchMock.mock.calls.length <= CAP
        ? toolAsked(`toolu_${fetchMock.mock.calls.length}`)
        : json({ type: 'error', error: { type: 'refused_error', message: 'refused' } }, 503)
    );
    const executor = vi.fn(async () => 'looked up');
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    let ended: { text?: string; error?: unknown } | undefined;
    void adapter
      .chatWithToolLoop({
        ...BASE,
        ...key,
        tools: [TOOL],
        executor,
        maxIterations: CAP,
        abortSignal: controller.signal,
      })
      .then(
        ({ text }) => (ended = { text }),
        (error: unknown) => (ended = { error })
      );

    // To the middle of the first wait, which follows the 503.
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFFS_MS[0] / 2);
    expect(fetchMock).toHaveBeenCalledTimes(CAP + 1);
    expect(executor).toHaveBeenCalledTimes(CAP);
    // A request of an iteration offers the tool; the one after the cap
    // offers none.
    expect(bodyOf(CAP).tools).toHaveLength(1);
    expect(bodyOf(CAP + 1).tools).toBeUndefined();
    expect(ended).toBeUndefined();

    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);

    expect(ended).toEqual({ error: reason });
    expect(ended?.error).toBe(reason);
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(CAP + 1);
  });
});

describe('the real clients these counts are taken through', () => {
  it("the Vertex client is built by the route's own module, with the SDK's retries off, and reaches Vertex AI's address", async () => {
    Object.assign(process.env, { ANTHROPIC_VERTEX_PROJECT_ID: 'proj', CLOUD_ML_REGION: 'region' });
    fetchMock.mockImplementation(async () => answered(ANSWER));

    await run(shapes(vertex).chat, {});

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

    await run(shapes(anthropic).chat, {});

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

    const { resolved, text, retries } = await run(shapes(anthropic).chat, {});
    stderr.mockRestore();

    expect(resolved).toBe(true);
    expect(text).toBe(ANSWER);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([]);
  });

  it.each(Object.entries(shapes(anthropic)))(
    "%s: an abort of the caller's signal during a wait of the call made on the metered key, after a subscription token is rejected with a 401, ends the call at once with the signal's reason, and no further request is sent",
    async (_shape, call) => {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-token';
      process.env.ANTHROPIC_API_KEY = 'environment-key';
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      fetchMock.mockImplementation(async () => refusal(503));
      fetchMock.mockImplementationOnce(async () =>
        json({ type: 'error', error: { type: 'authentication_error', message: 'no' } }, 401)
      );
      const controller = new AbortController();
      const reason = new Error('the caller gave up');
      let ended: { error: unknown } | undefined;
      void call({ abortSignal: controller.signal }).then(
        () => (ended = { error: undefined }),
        (error: unknown) => (ended = { error })
      );

      // To the middle of the first wait: the 401, then the key's 503.
      await vi.advanceTimersByTimeAsync(RETRY_BACKOFFS_MS[0] / 2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
      ).toEqual(['Bearer environment-token', 'Bearer environment-key']);
      expect(ended).toBeUndefined();

      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);
      stderr.mockRestore();

      expect(ended).toEqual({ error: reason });
      expect(ended?.error).toBe(reason);
      await vi.runAllTimersAsync();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );
});
