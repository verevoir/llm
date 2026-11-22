import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK before importing the adapter, so the request
// payloads handed to `messages.stream` can be inspected whole.
const mockStream = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { stream: mockStream };
    constructor(opts: unknown) {
      mockClientCtor(opts);
    }
  },
}));

import { chat, chatWithToolLoop, chatWithTools, models } from './index.js';
import type { ChatOptions, TokenUsage, ToolDef } from '../index.js';

type CacheOption = ChatOptions['cache'];
type CacheControl = { type: 'ephemeral'; ttl?: '1h' };
type Request = Record<string, unknown>;

interface FakeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function fakeStream(blocks: FakeBlock[], stopReason: string, usage: object = ZERO_USAGE) {
  return {
    on: () => {},
    finalMessage: async () => ({ content: blocks, stop_reason: stopReason, usage }),
  };
}

const SYSTEM = 'You are helpful.';
const NOOP: ToolDef = {
  name: 'noop',
  description: 'noop',
  input_schema: { type: 'object', properties: {} },
};
const toolUse = (id: string, name = 'noop', input: Record<string, unknown> = {}): FakeBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const text = (t: string): FakeBlock => ({ type: 'text', text: t });

/** `cache` is spread in only when a row sets it, so the "absent" row really
 * sends an options object with no `cache` key. */
function withCache(cache: CacheOption): { cache?: CacheOption } {
  return cache === undefined ? {} : { cache };
}

/**
 * Drive every Anthropic entry point that builds a request, and return the
 * six requests they send, in order:
 *
 *   0. chat — first call
 *   1. chat — the continuation after a progress-only turn
 *   2. chatWithTools
 *   3. chatWithToolLoop — first iteration
 *   4. chatWithToolLoop — second iteration
 *   5. chatWithToolLoop — the tool-less final call after the iteration cap
 */
async function sendEveryRequest(cache: CacheOption): Promise<Request[]> {
  mockStream.mockReset();
  mockStream
    .mockReturnValueOnce(
      fakeStream([toolUse('p1', 'report_progress', { percent: 10, message: 'm' })], 'tool_use')
    )
    .mockReturnValueOnce(fakeStream([text('answer')], 'end_turn'))
    .mockReturnValueOnce(fakeStream([text('answer')], 'end_turn'))
    .mockReturnValueOnce(fakeStream([toolUse('u1')], 'tool_use'))
    .mockReturnValueOnce(fakeStream([toolUse('u2')], 'tool_use'))
    .mockReturnValueOnce(fakeStream([text('done')], 'end_turn'));

  const common = { systemPrompt: SYSTEM, apiKey: 'sk-test', ...withCache(cache) };
  await chat({ ...common, turns: [{ role: 'user', content: 'hi' }], onProgress: async () => {} });
  await chatWithTools({ ...common, turns: [{ role: 'user', content: 'hi' }], tools: [NOOP] });
  await chatWithToolLoop({
    ...common,
    turns: [{ role: 'user', content: 'go' }],
    tools: [NOOP],
    executor: async () => 'ok',
    maxIterations: 2,
  });

  expect(mockStream).toHaveBeenCalledTimes(6);
  return mockStream.mock.calls.map((call) => call[0] as Request);
}

/**
 * The six requests of {@link sendEveryRequest}, written out literally, with
 * `breakpoint` at every place the adapter puts a cache breakpoint (or no
 * `cache_control` key at all when `breakpoint` is undefined).
 *
 * `progressTools` is the adapter's own auto-injected progress tool list,
 * taken from the sent request: it is the same for every cache setting and
 * never carries a breakpoint (the no-`cache_control` walk covers it).
 */
function expectedRequests(breakpoint: CacheControl | undefined, progressTools: unknown): Request[] {
  const mark = <T extends object>(block: T): T =>
    breakpoint ? { ...block, cache_control: breakpoint } : block;
  const head = {
    model: models.reasoning,
    max_tokens: 16384,
    system: [mark({ type: 'text', text: SYSTEM })],
  };
  /** A user string turn at the end of a re-sent history: a marked text
   * block when there is a breakpoint to carry, the plain string otherwise. */
  const lastUserText = (t: string) =>
    breakpoint ? [mark({ type: 'text', text: t })] : (t as string | object[]);
  const toolResult = (id: string) => ({
    type: 'tool_result',
    tool_use_id: id,
    content: 'ok',
    is_error: undefined,
  });
  const assistantCall = (id: string) => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'noop', input: {} }],
  });

  return [
    { ...head, messages: [{ role: 'user', content: 'hi' }], tools: progressTools },
    {
      ...head,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'p1',
              name: 'report_progress',
              input: { percent: 10, message: 'm' },
            },
          ],
        },
        {
          role: 'user',
          content: [mark({ type: 'tool_result', tool_use_id: 'p1', content: 'ok' })],
        },
      ],
      tools: progressTools,
    },
    { ...head, messages: [{ role: 'user', content: 'hi' }], tools: [NOOP] },
    { ...head, messages: [{ role: 'user', content: lastUserText('go') }], tools: [NOOP] },
    {
      ...head,
      messages: [
        { role: 'user', content: 'go' },
        assistantCall('u1'),
        { role: 'user', content: [mark(toolResult('u1'))] },
      ],
      tools: [NOOP],
    },
    {
      ...head,
      messages: [
        { role: 'user', content: 'go' },
        assistantCall('u1'),
        { role: 'user', content: [toolResult('u1')] },
        assistantCall('u2'),
        { role: 'user', content: [mark(toolResult('u2'))] },
      ],
    },
  ];
}

/** Every `cache_control` value in a request, at any depth. */
function cacheControlsIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(cacheControlsIn);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'cache_control' ? [child] : cacheControlsIn(child)
  );
}

function expectRequestsToBe(actual: Request[], breakpoint: CacheControl | undefined) {
  const expected = expectedRequests(breakpoint, actual[0].tools);
  expect(actual).toStrictEqual(expected);
  // Serialised too: this is what goes on the wire, key order included.
  expect(actual.map((r) => JSON.stringify(r))).toEqual(expected.map((r) => JSON.stringify(r)));
}

describe('anthropic ChatOptions.cache', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
  });

  it.each<[string, CacheOption]>([
    ['absent', undefined],
    ["'default'", 'default'],
  ])(
    'cache %s sends the default-lifetime breakpoints, with no ttl, from every entry point',
    async (_label, cache) => {
      const requests = await sendEveryRequest(cache);

      expectRequestsToBe(requests, { type: 'ephemeral' });
      // One on the system prompt everywhere; one more on the conversation
      // wherever a growing history is re-sent.
      expect(requests.map((r) => cacheControlsIn(r).length)).toEqual([1, 2, 1, 2, 2, 2]);
    }
  );

  it.each<[string, number]>([
    ['a single call', 0],
    ['a continuation of a single call', 1],
    ['a call with tools', 2],
    ['the first tool-loop iteration', 3],
    ['a tool-loop iteration after the first', 4],
    ['the tool-less final call of a capped tool loop', 5],
  ])("cache 'none' sends no cache_control at any depth for %s", async (_label, index) => {
    const requests = await sendEveryRequest('none');

    expect(cacheControlsIn(requests[index])).toEqual([]);
    expect(JSON.stringify(requests[index])).not.toContain('cache_control');
    // And nothing else about the request moved: the history stays as sent.
    expect(requests[index]).toStrictEqual(expectedRequests(undefined, requests[0].tools)[index]);
  });

  it("cache 'extended' puts ttl '1h' on every breakpoint the default places, and no others", async () => {
    const byDefault = await sendEveryRequest('default');
    const extended = await sendEveryRequest('extended');

    expectRequestsToBe(extended, { type: 'ephemeral', ttl: '1h' });
    for (const [i, request] of extended.entries()) {
      const controls = cacheControlsIn(request);
      expect(controls).toHaveLength(cacheControlsIn(byDefault[i]).length);
      for (const control of controls) expect(control).toEqual({ type: 'ephemeral', ttl: '1h' });
    }
  });

  it("cache 'extended' sends no beta header or client option: the request alone asks for it", async () => {
    await sendEveryRequest('extended');

    // `messages.stream(request)` — one argument, no per-request options.
    for (const call of mockStream.mock.calls) expect(call).toHaveLength(1);
    for (const [clientOptions] of mockClientCtor.mock.calls) {
      expect(JSON.stringify(clientOptions ?? {})).not.toMatch(/beta/i);
    }
  });
});

describe('anthropic ChatOptions.cache — usage accounting', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
  });

  const SPLIT_USAGE = {
    input_tokens: 5,
    output_tokens: 7,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
  };
  const UNSPLIT_USAGE = {
    input_tokens: 5,
    output_tokens: 7,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
  };

  /** Each entry point, run to completion, with how many model calls it makes. */
  const entryPoints: Array<[string, number, (usage: object) => Promise<TokenUsage>]> = [
    [
      'chat',
      1,
      async (usage) => {
        mockStream.mockReturnValueOnce(fakeStream([text('answer')], 'end_turn', usage));
        const reply = await chat({
          systemPrompt: SYSTEM,
          apiKey: 'sk-test',
          turns: [{ role: 'user', content: 'hi' }],
          cache: 'extended',
        });
        return reply.usage;
      },
    ],
    [
      'chatWithTools',
      1,
      async (usage) => {
        mockStream.mockReturnValueOnce(fakeStream([text('answer')], 'end_turn', usage));
        const reply = await chatWithTools({
          systemPrompt: SYSTEM,
          apiKey: 'sk-test',
          turns: [{ role: 'user', content: 'hi' }],
          tools: [NOOP],
          cache: 'extended',
        });
        return reply.usage;
      },
    ],
    [
      'chatWithToolLoop (two iterations)',
      2,
      async (usage) => {
        mockStream
          .mockReturnValueOnce(fakeStream([toolUse('u1')], 'tool_use', usage))
          .mockReturnValueOnce(fakeStream([text('done')], 'end_turn', usage));
        const reply = await chatWithToolLoop({
          systemPrompt: SYSTEM,
          apiKey: 'sk-test',
          turns: [{ role: 'user', content: 'go' }],
          tools: [NOOP],
          executor: async () => 'ok',
          cache: 'extended',
        });
        return reply.usage;
      },
    ],
    [
      'chatWithToolLoop (capped, plus the final call)',
      2,
      async (usage) => {
        mockStream
          .mockReturnValueOnce(fakeStream([toolUse('u1')], 'tool_use', usage))
          .mockReturnValueOnce(fakeStream([text('done')], 'end_turn', usage));
        const reply = await chatWithToolLoop({
          systemPrompt: SYSTEM,
          apiKey: 'sk-test',
          turns: [{ role: 'user', content: 'go' }],
          tools: [NOOP],
          executor: async () => 'ok',
          maxIterations: 1,
          cache: 'extended',
        });
        return reply.usage;
      },
    ],
  ];

  it.each(entryPoints)(
    '%s reports cache-read, cache-write and the 5m/1h split the provider returned',
    async (_label, calls, run) => {
      const usage = await run(SPLIT_USAGE);

      expect(usage.cacheReadInputTokens).toBe(40 * calls);
      expect(usage.cacheCreationInputTokens).toBe(30 * calls);
      expect(usage.cacheCreationEphemeral5mInputTokens).toBe(10 * calls);
      expect(usage.cacheCreationEphemeral1hInputTokens).toBe(20 * calls);
    }
  );

  it.each(entryPoints)(
    '%s reports cache-read and cache-write, and leaves the split undefined when the provider omits it',
    async (_label, calls, run) => {
      const usage = await run(UNSPLIT_USAGE);

      expect(usage.cacheReadInputTokens).toBe(40 * calls);
      expect(usage.cacheCreationInputTokens).toBe(30 * calls);
      expect(usage.cacheCreationEphemeral5mInputTokens).toBeUndefined();
      expect(usage.cacheCreationEphemeral1hInputTokens).toBeUndefined();
    }
  );
});
