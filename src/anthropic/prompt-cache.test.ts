import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK before importing the adapter, so we can
// inspect the request payloads passed to `messages.stream` and assert
// where cache_control breakpoints land.
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

import { chat, chatWithToolLoop } from './index.js';

interface FakeBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function fakeStream(blocks: FakeBlock[], stopReason: string) {
  return {
    on: () => {},
    finalMessage: async () => ({
      content: blocks,
      stop_reason: stopReason,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
  };
}

const EPHEMERAL = { type: 'ephemeral' };

/** Pull the request payload the adapter handed to `messages.stream` on
 * the Nth call. */
function requestOnCall(n: number): {
  system: Array<{ cache_control?: unknown }>;
  messages: Array<{ role: string; content: unknown }>;
} {
  return mockStream.mock.calls[n][0];
}

function lastBlockOf(content: unknown): { cache_control?: unknown } | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  return content[content.length - 1];
}

describe('anthropic prompt caching — breakpoint placement', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
  });

  it('chat() caches the system/tools prefix but not the (varying) final user message', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'hi back' }], 'end_turn'));

    await chat({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });

    const req = requestOnCall(0);
    // System block carries the breakpoint — this caches tools + system.
    expect(req.system[0].cache_control).toEqual(EPHEMERAL);
    // Single-shot: the user turn is the varying suffix, left uncached
    // (still a plain string, untouched).
    expect(req.messages[req.messages.length - 1].content).toBe('hi');
  });

  it('chatWithToolLoop() breakpoints the system prefix and the last message on every iteration', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use')
      )
      .mockReturnValueOnce(fakeStream([{ type: 'text', text: 'done' }], 'end_turn'));

    await chatWithToolLoop({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'ok',
    });

    expect(mockStream).toHaveBeenCalledTimes(2);

    // Iteration 1: system breakpoint + a breakpoint on the last message.
    // The initial string turn is converted to a text block carrying it.
    const first = requestOnCall(0);
    expect(first.system[0].cache_control).toEqual(EPHEMERAL);
    const firstLast = first.messages[first.messages.length - 1];
    expect(lastBlockOf(firstLast.content)?.cache_control).toEqual(EPHEMERAL);

    // Iteration 2: history has grown (assistant tool_use + user
    // tool_result appended); the breakpoint moves to the new last
    // block (the tool_result), so this call reads iteration 1's prefix.
    const second = requestOnCall(1);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    const secondLast = second.messages[second.messages.length - 1];
    expect(secondLast.role).toBe('user');
    expect(lastBlockOf(secondLast.content)?.cache_control).toEqual(EPHEMERAL);

    // Exactly one message-level breakpoint per request (the moving end),
    // so we stay well within the 4-breakpoint cap alongside the system one.
    const markedBlocks = (second.messages as Array<{ content: unknown }>).flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as Array<{ cache_control?: unknown }>).filter((b) => b.cache_control)
        : []
    );
    expect(markedBlocks).toHaveLength(1);
  });
});
