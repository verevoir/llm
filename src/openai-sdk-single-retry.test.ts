/**
 * The adapters that send through the `openai` SDK retry at one layer only: the
 * library's own policy, which retries what the SDK's own rule retries, and
 * which each adapter hands its caller's `abortSignal`. Each test counts the
 * requests that reach `fetch`, with the real SDK in between, so a retry the
 * SDK made on its own would be counted too. (The adapters' other retry tests
 * replace the SDK's `create`, and so cannot see what the SDK does beneath it.)
 * No network; every wait, the SDK's request timeout included, runs on fake
 * timers.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import type { ChatRetryInfo, ToolDef } from './index.js';
import * as deepseek from './deepseek/index.js';
import * as mistral from './mistral/index.js';
import * as openai from './openai/index.js';
import * as samba from './samba/index.js';
import { RETRY_BACKOFFS_MS, TIMEOUT_RETRIES } from './retry-policy.js';

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** A Chat Completions answer in text, with no tool call. */
const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** A Responses API answer in text. */
const RESPONSE = {
  id: 'resp_1',
  object: 'response',
  model: 'm',
  status: 'completed',
  output: [
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

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
type Call = (extra: Extra) => Promise<unknown>;

/** The three call shapes of an adapter built by the OpenAI-compatible factory. */
const factoryShapes = (a: typeof samba | typeof mistral): [string, Call][] => [
  ['chat', (extra) => a.chat({ ...BASE, ...extra })],
  ['chatWithTools', (extra) => a.chatWithTools({ ...BASE, ...extra, tools: [TOOL] })],
  [
    'chatWithToolLoop',
    (extra) =>
      a.chatWithToolLoop({ ...BASE, ...extra, tools: [TOOL], executor: async () => 'looked up' }),
  ],
];

const ADAPTERS: { name: string; keyEnv: string; ok: unknown; shapes: [string, Call][] }[] = [
  { name: 'samba', keyEnv: 'SAMBA_NOVA_API_KEY', ok: COMPLETION, shapes: factoryShapes(samba) },
  { name: 'mistral', keyEnv: 'MISTRAL_API_KEY', ok: COMPLETION, shapes: factoryShapes(mistral) },
  {
    name: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    ok: COMPLETION,
    shapes: [['chat', (extra) => deepseek.chat({ ...BASE, ...extra })]],
  },
  {
    name: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    ok: RESPONSE,
    shapes: [['chat', (extra) => openai.chat({ ...BASE, ...extra })]],
  },
];

/** Each adapter builds a client in two places: one per call for a per-call
 * key, and one kept for the key in the environment. Both are covered. */
const KEYS: [string, Extra][] = [
  ['a per-call key', { apiKey: 'per-call-key' }],
  ['the environment key', {}],
];

const CASES = ADAPTERS.flatMap(({ name, ok, shapes }) =>
  shapes.flatMap(([shape, call]) =>
    KEYS.map(([keyName, key]) => ({ title: `${name}.${shape} with ${keyName}`, ok, call, key }))
  )
);

const ENV = [
  ...ADAPTERS.map((a) => a.keyEnv),
  'SAMBA_NOVA_BASE_URL',
  'MISTRAL_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
];
const saved: Record<string, string | undefined> = {};

// A client takes the global `fetch` when it is built, and each adapter keeps
// its environment-key client for the life of the module: the same fake has to
// be in place for the whole file.
beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockReset();
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const { keyEnv } of ADAPTERS) process.env[keyEnv] = 'environment-key';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Answer every request with a fresh response of this status and body. */
function answer(body: unknown, status: number, headers?: Record<string, string>): void {
  fetchMock.mockImplementation(async () => json(body, status, headers));
}

const refuse = (status: number, headers?: Record<string, string>) => () =>
  answer({ error: { message: 'refused' } }, status, headers);

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
    () => (outcome = { resolved: true, retries }),
    (error: unknown) => (outcome = { resolved: false, error, retries })
  );
  do {
    await vi.runAllTimersAsync();
  } while (!outcome);
  return outcome;
}

const statusOf = (error: unknown) => (error as { status?: number }).status;
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
];

/** Every failure sent once and thrown. */
const NOT_RETRIED: [name: string, arrange: () => void, status: number][] = [
  ...[400, 401, 403, 404, 422].map((status): [string, () => void, number] => [
    `a ${status}`,
    refuse(status),
    status,
  ]),
  ['a 429 with x-should-retry: false', refuse(429, { 'x-should-retry': 'false' }), 429],
  ['a 503 with x-should-retry: false', refuse(503, { 'x-should-retry': 'false' }), 503],
];

it('the policy allows at least one retry, so no count below is vacuous', () => {
  expect(RETRIES).toBeGreaterThan(0);
});

describe.each(CASES)('$title: the library retry policy is the only one', ({ ok, call, key }) => {
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
    async (_name, arrange, status) => {
      arrange();

      const { resolved, error, retries } = await run(call, key);

      expect(resolved).toBe(false);
      expect(statusOf(error)).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(retries).toEqual([]);
    }
  );

  it.each([
    ['a 429', () => json({ error: { message: 'slow down' } }, 429)],
    ['a 504', () => json({ error: { message: 'gateway timeout' } }, 504)],
    [
      'a connection failure',
      (): Response => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('sends a request that meets %s and then succeeds twice', async (_name, firstAnswer) => {
    answer(ok, 200);
    fetchMock.mockImplementationOnce(async () => firstAnswer());

    const { resolved, retries } = await run(call, key);

    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries.map((r) => r.attempt)).toEqual([1]);
  });

  it("sends a request never answered once, then TIMEOUT_RETRIES times more with no wait: the SDK's request timeout each time, and nothing between", async () => {
    neverAnswer();
    const began = Date.now();

    const { resolved, error, retries } = await run(call, key);

    expect(resolved).toBe(false);
    expect(classOf(error)).toBe('APIConnectionTimeoutError');
    expect(fetchMock).toHaveBeenCalledTimes(1 + TIMEOUT_RETRIES);
    expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
      Array.from({ length: TIMEOUT_RETRIES }, (_, i) => [i + 1, TIMEOUT_RETRIES, 0])
    );
    expect(Date.now() - began).toBe((1 + TIMEOUT_RETRIES) * OpenAI.DEFAULT_TIMEOUT);
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
    answer(ok, 200);
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
