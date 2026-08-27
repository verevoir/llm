import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the OpenAI SDK before importing the adapter. DeepSeek speaks the
// Chat Completions API, so the fake exposes `chat.completions.create`.
const mockCreate = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(opts: unknown) {
      mockClientCtor(opts);
    }
  },
}));

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { chat } from './index.js';
import { setModelSpanSink, type ModelSpan, type TokenUsage } from '../index.js';

interface FakeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
}

function fakeResponse(
  content: string,
  finish_reason: string = 'stop',
  usage: FakeUsage = { prompt_tokens: 0, completion_tokens: 0 }
) {
  return {
    choices: [{ message: { content }, finish_reason }],
    usage,
  };
}

describe('deepseek.chat', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockClientCtor.mockReset();
  });

  afterEach(() => setModelSpanSink(null));

  it('emits a model span to the registered sink with scope deepseek.chat', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('reply', 'stop', { prompt_tokens: 12, completion_tokens: 8 })
    );
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'deepseek.chat',
      provider: 'deepseek',
      inputTokens: 12,
      outputTokens: 8,
    });
  });

  it('returns the model text + usage from a single-shot call', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('Hello from DeepSeek.', 'stop', {
        prompt_tokens: 12,
        completion_tokens: 8,
      })
    );

    const result = await chat({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });

    expect(result.content).toBe('Hello from DeepSeek.');
    expect(result.stopReason).toBe('stop');
    expect(result.usage.provider).toBe('deepseek');
    expect(result.usage.model).toBe('deepseek-reasoner');
    expect(result.usage.direction).toBe('reasoning');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(8);
    // Single credential mechanism for this adapter — route is a constant,
    // not computed, but the caller-visible field must still be checked.
    expect(result.usage.route).toBe('api-key');
  });

  it('constructs the client against the DeepSeek base URL', async () => {
    mockCreate.mockResolvedValue(fakeResponse('ok'));

    await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });

    expect(mockClientCtor).toHaveBeenCalledTimes(1);
    expect(mockClientCtor.mock.calls[0][0]).toEqual({
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com',
    });
  });

  it('passes the system prompt + turns through as a messages array', async () => {
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
    expect(call.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('picks the extraction model when modelClass is extraction', async () => {
    mockCreate.mockResolvedValue(fakeResponse('ok'));

    const result = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
    });

    expect(mockCreate.mock.calls[0][0].model).toBe('deepseek-chat');
    expect(result.usage.model).toBe('deepseek-chat');
    expect(result.usage.direction).toBe('extraction');
  });

  it('captures prompt_cache_hit_tokens into cacheReadInputTokens', async () => {
    mockCreate.mockResolvedValue(
      fakeResponse('reply', 'stop', {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 30,
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
    expect(usage.provider).toBe('deepseek');
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadInputTokens).toBe(30);
  });

  it('throws when the response has no text content', async () => {
    mockCreate.mockResolvedValue(fakeResponse('', 'length'));

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(/no text content.*length/);
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
      .mockResolvedValueOnce(fakeResponse('finally', 'stop'));

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
