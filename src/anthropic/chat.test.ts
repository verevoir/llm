import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Anthropic SDK before importing the adapter (same pattern as
// chatWithToolLoop.test.ts). Each test scripts a sequence of streamed
// responses so we can exercise chat()'s progress-continuation loop.
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

import { chat, chatWithTools } from './index.js';
import { setModelSpanSink, type ModelSpan } from '../index.js';

interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface FakeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function fakeStream(
  blocks: FakeContentBlock[],
  stopReason: string,
  usage: FakeUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
) {
  return {
    on: () => {},
    finalMessage: async () => ({ content: blocks, stop_reason: stopReason, usage }),
  };
}

describe('chat — progress-only tool turn', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
  });

  it('continues past a progress-only tool_use turn and returns the eventual text', async () => {
    // First turn: the model calls report_progress and stops with no
    // text (what Haiku does). Second turn: the real answer.
    mockStream.mockReturnValueOnce(
      fakeStream(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'report_progress',
            input: { percent: 50, message: 'working' },
          },
        ],
        'tool_use'
      )
    );
    mockStream.mockReturnValueOnce(fakeStream([{ type: 'text', text: '# README\n' }], 'end_turn'));

    const reply = await chat({
      systemPrompt: 'Write the readme.',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
      onProgress: async () => {},
    });

    expect(reply.content).toBe('# README\n');
    // Continued: a second call was made after the progress-only turn.
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it('sums usage across the continuation', async () => {
    mockStream.mockReturnValueOnce(
      fakeStream(
        [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'report_progress',
            input: { percent: 30, message: 'x' },
          },
        ],
        'tool_use',
        {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }
      )
    );
    mockStream.mockReturnValueOnce(
      fakeStream([{ type: 'text', text: 'done' }], 'end_turn', {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    );

    const reply = await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      onProgress: async () => {},
    });

    expect(reply.content).toBe('done');
    expect(reply.usage.inputTokens).toBe(12);
    expect(reply.usage.outputTokens).toBe(5);
  });

  it('still throws when a turn has no text and no progress tool to continue on', async () => {
    mockStream.mockReturnValue(fakeStream([], 'tool_use'));
    await expect(
      chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }], apiKey: 'sk-test' })
    ).rejects.toThrow(/no text content/);
  });

  it('returns text-only responses unchanged (no continuation)', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'hi' }], 'end_turn'));
    const reply = await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
    });
    expect(reply.content).toBe('hi');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });
});

describe('chat — model pinning (ChatOptions.model)', () => {
  beforeEach(() => mockStream.mockReset());

  it('sends the exact model id when options.model is set, bypassing modelClass resolution entirely', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'));

    await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      modelClass: 'extraction', // would resolve to the Haiku id if honoured
      model: 'claude-pinned-judge-1',
    });

    const request = mockStream.mock.calls[0][0] as { model: string };
    expect(request.model).toBe('claude-pinned-judge-1');
  });

  it('reports the pinned model id on TokenUsage.model, not the class-resolved one', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'));

    const reply = await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
      model: 'claude-pinned-judge-1',
    });

    expect(reply.usage.model).toBe('claude-pinned-judge-1');
  });

  it('falls back to the catalog id resolved from modelClass when options.model is not set — unchanged default', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'));

    const reply = await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
    });

    const request = mockStream.mock.calls[0][0] as { model: string };
    expect(request.model).toBe('claude-haiku-4-5-20251001');
    expect(reply.usage.model).toBe('claude-haiku-4-5-20251001');
  });

  it('chatWithTools also sends the pinned id, not the class-resolved one', async () => {
    mockStream.mockReturnValue(
      fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use')
    );

    const result = await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
      model: 'claude-pinned-judge-1',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
    });

    const request = mockStream.mock.calls[0][0] as { model: string };
    expect(request.model).toBe('claude-pinned-judge-1');
    expect(result.usage.model).toBe('claude-pinned-judge-1');
  });
});

describe('chat — maxTokens override (ChatOptions.maxTokens)', () => {
  beforeEach(() => mockStream.mockReset());

  it('sends the caller-supplied maxTokens instead of the adapter default', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'));

    await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      maxTokens: 65536,
    });

    const request = mockStream.mock.calls[0][0] as { max_tokens: number };
    expect(request.max_tokens).toBe(65536);
  });

  it('defaults to 16384 when maxTokens is not supplied — unchanged default behaviour', async () => {
    mockStream.mockReturnValue(fakeStream([{ type: 'text', text: 'ok' }], 'end_turn'));

    await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
    });

    const request = mockStream.mock.calls[0][0] as { max_tokens: number };
    expect(request.max_tokens).toBe(16384);
  });
});

describe('chat — model-span emission', () => {
  beforeEach(() => mockStream.mockReset());
  afterEach(() => setModelSpanSink(null));

  it('emits a model span to the registered sink with scope anthropic.chat', async () => {
    mockStream.mockReturnValue(
      fakeStream([{ type: 'text', text: 'hi' }], 'end_turn', {
        input_tokens: 12,
        output_tokens: 8,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    );
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'anthropic.chat',
      provider: 'anthropic',
      inputTokens: 12,
      outputTokens: 8,
    });
  });

  it('chatWithTools emits a model span with scope anthropic.chatWithTools', async () => {
    mockStream.mockReturnValue(
      fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    );
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'x' }],
      apiKey: 'sk-test',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'anthropic.chatWithTools',
      provider: 'anthropic',
      inputTokens: 10,
      outputTokens: 5,
    });
  });
});
