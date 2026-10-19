import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK module before importing the adapter — same
// pattern as anthropic/chatWithToolLoop.test.ts uses.
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

import { chatWithToolLoop } from './anthropic/index.js';
import { collapseContentToText, UnsupportedContentBlockError, type ContentBlock } from './index.js';

interface FakeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function fakeStream(blocks: FakeContentBlock[], stopReason: string) {
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

const PNG_BLOCK: ContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
};

const PDF_BLOCK: ContentBlock = {
  type: 'document',
  source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQK' },
};

describe('collapseContentToText — the refusal every non-Anthropic provider routes through', () => {
  it('a plain string passes through unchanged', () => {
    expect(collapseContentToText('openai', 'hello')).toBe('hello');
  });

  it('an all-text ContentBlock[] collapses to the joined text', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ];
    expect(collapseContentToText('openai', blocks)).toBe('ab');
  });

  it('an image block throws UnsupportedContentBlockError naming the provider and block type — never a silent drop or a stringified block', () => {
    try {
      collapseContentToText('google', [PNG_BLOCK]);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedContentBlockError);
      expect((err as UnsupportedContentBlockError).provider).toBe('google');
      expect((err as UnsupportedContentBlockError).blockType).toBe('image');
    }
  });

  it('a document block throws the same way, naming "document" as the block type', () => {
    try {
      collapseContentToText('openai-compat', [PDF_BLOCK]);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedContentBlockError);
      expect((err as UnsupportedContentBlockError).blockType).toBe('document');
    }
  });
});

describe('Anthropic chatWithToolLoop — ContentBlock tool results and turn content reach the wire unchanged', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
  });

  it('a STRING tool result behaves exactly as before this widening', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use')
      )
      .mockReturnValueOnce(fakeStream([{ type: 'text', text: 'done' }], 'end_turn'));

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'plain string result',
    });

    const secondCallRequest = mockStream.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultMessage = secondCallRequest.messages[secondCallRequest.messages.length - 1];
    const toolResultBlocks = toolResultMessage.content as Array<{ content: unknown }>;
    expect(toolResultBlocks[0].content).toBe('plain string result');
  });

  it('an executor returning an IMAGE ContentBlock[] reaches the request tool_result.content intact — never collapsed or stringified', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'screenshot', input: {} }], 'tool_use')
      )
      .mockReturnValueOnce(fakeStream([{ type: 'text', text: 'got it' }], 'end_turn'));

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'take a screenshot' }],
      apiKey: 'sk-test',
      tools: [
        {
          name: 'screenshot',
          description: 'screenshot',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      executor: async () => [PNG_BLOCK],
    });

    const secondCallRequest = mockStream.mock.calls[1][0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const toolResultMessage = secondCallRequest.messages[secondCallRequest.messages.length - 1];
    const toolResultBlocks = toolResultMessage.content as Array<{ content: unknown }>;
    expect(toolResultBlocks[0].content).toEqual([PNG_BLOCK]);
  });

  it('a user turn carrying a PDF document block reaches the request messages array intact', async () => {
    mockStream.mockReturnValueOnce(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'));

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: [{ type: 'text', text: 'see attached' }, PDF_BLOCK] }],
      apiKey: 'sk-test',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'ok',
    });

    const firstCallRequest = mockStream.mock.calls[0][0] as {
      messages: Array<{ role: string; content: unknown[] }>;
    };
    const content = firstCallRequest.messages[0].content;
    // The last block of the last message always carries a prompt-cache
    // breakpoint (withConversationCacheBreakpoint, pre-existing, unrelated
    // to this change), so PDF_BLOCK's own fields are checked individually
    // rather than by exact array equality.
    expect(content[0]).toEqual({ type: 'text', text: 'see attached' });
    expect(content[1]).toMatchObject(PDF_BLOCK);
  });
});
