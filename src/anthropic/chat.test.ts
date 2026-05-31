import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { chat } from './index.js';

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
