import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OpenAI SDK before importing the adapter. Each test sets
// up the fake `responses.create` to return a controlled Response
// shape.
const mockCreate = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    responses = { create: mockCreate };
    constructor(opts: unknown) {
      mockClientCtor(opts);
    }
  },
}));

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { chat } from './index.js';
import type { TokenUsage } from '../index.js';

interface FakeUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
}

function fakeResponse(
  output_text: string,
  status: string = 'completed',
  usage: FakeUsage = { input_tokens: 0, output_tokens: 0 }
) {
  return {
    output_text,
    status,
    usage,
  };
}

describe('openai.chat', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockClientCtor.mockReset();
  });

  it('returns the model text + usage from a single-shot call', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('Hello from GPT.', 'completed', {
        input_tokens: 12,
        output_tokens: 8,
      })
    );

    const result = await chat({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });

    expect(result.content).toBe('Hello from GPT.');
    expect(result.stopReason).toBe('completed');
    expect(result.usage.provider).toBe('openai');
    expect(result.usage.model).toBe('gpt-5');
    expect(result.usage.direction).toBe('reasoning');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('passes turn role + content through to responses.create as input array', async () => {
    mockCreate.mockResolvedValue(fakeResponse('ok'));

    await chat({
      systemPrompt: 'sys',
      turns: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      apiKey: 'sk-test',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0];
    expect(call.input).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
    expect(call.instructions).toBe('sys');
  });

  it('picks the extraction model when modelClass is extraction', async () => {
    mockCreate.mockResolvedValue(fakeResponse('ok'));

    const result = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
    });

    expect(mockCreate.mock.calls[0][0].model).toBe('gpt-5-mini');
    expect(result.usage.model).toBe('gpt-5-mini');
    expect(result.usage.direction).toBe('extraction');
  });

  it('captures cached_tokens from input_tokens_details into cacheReadInputTokens', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('reply', 'completed', {
        input_tokens: 100,
        output_tokens: 50,
        input_tokens_details: { cached_tokens: 30 },
      })
    );
    const onUsage = vi.fn<(u: TokenUsage) => Promise<void>>(async () => {});

    await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledTimes(1);
    const usage = onUsage.mock.calls[0][0];
    expect(usage.provider).toBe('openai');
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadInputTokens).toBe(30);
  });

  it('throws when the response has no text content', async () => {
    mockCreate.mockResolvedValue(fakeResponse('', 'incomplete'));

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(/no text content.*incomplete/);
  });

  it('throws the abort reason when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('budget exceeded before call');
    controller.abort(reason);

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        apiKey: 'sk-test',
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws when no turns are supplied', async () => {
    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [],
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(/at least one turn/);
  });

  it('retries on a 429 then succeeds', async () => {
    mockCreate
      .mockRejectedValueOnce(Object.assign(new Error('Rate Limited'), { status: 429 }))
      .mockResolvedValueOnce(fakeResponse('finally', 'completed'));

    vi.useFakeTimers();
    const promise = chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
    });
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();

    expect(result.content).toBe('finally');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
