import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Google GenAI SDK before importing the adapter. Each test
// sets up the fake `models.generateContent` to return a controlled
// response shape.
const mockGenerateContent = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class GoogleGenAI {
    models = { generateContent: mockGenerateContent };
    constructor(opts: unknown) {
      mockClientCtor(opts);
    }
  },
}));

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { chat } from './index.js';
import type { TokenUsage } from '../index.js';

interface FakeUsage {
  promptTokenCount: number;
  candidatesTokenCount: number;
  cachedContentTokenCount?: number;
}

function fakeResponse(
  text: string,
  finishReason: string = 'STOP',
  usage: FakeUsage = { promptTokenCount: 0, candidatesTokenCount: 0 }
) {
  return {
    text,
    candidates: [{ finishReason }],
    usageMetadata: usage,
  };
}

describe('google.chat', () => {
  beforeEach(() => {
    mockGenerateContent.mockReset();
    mockClientCtor.mockReset();
  });

  it('returns the model text + usage from a single-shot call', async () => {
    mockGenerateContent.mockResolvedValue(
      fakeResponse('Hello from Gemini.', 'STOP', {
        promptTokenCount: 12,
        candidatesTokenCount: 8,
      })
    );

    const result = await chat({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
    });

    expect(result.content).toBe('Hello from Gemini.');
    expect(result.stopReason).toBe('STOP');
    expect(result.usage.provider).toBe('google');
    expect(result.usage.model).toBe('gemini-2.5-pro');
    expect(result.usage.direction).toBe('reasoning');
    expect(result.usage.inputTokens).toBe(12);
    expect(result.usage.outputTokens).toBe(8);
  });

  it('passes turn role + content through to generateContent (assistant → model)', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('ok'));

    await chat({
      systemPrompt: 'sys',
      turns: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      apiKey: 'sk-test',
    });

    expect(mockGenerateContent).toHaveBeenCalledTimes(1);
    const call = mockGenerateContent.mock.calls[0][0];
    expect(call.contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'reply' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
    expect(call.config?.systemInstruction).toBe('sys');
  });

  it('picks the extraction model when modelClass is extraction', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('ok'));

    const result = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
    });

    expect(mockGenerateContent.mock.calls[0][0].model).toBe('gemini-2.5-flash');
    expect(result.usage.model).toBe('gemini-2.5-flash');
    expect(result.usage.direction).toBe('extraction');
  });

  it('fires onUsage with the shaped usage record', async () => {
    mockGenerateContent.mockResolvedValue(
      fakeResponse('reply', 'STOP', {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 30,
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
    expect(usage.provider).toBe('google');
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadInputTokens).toBe(30);
  });

  it('throws when the response has no text content', async () => {
    mockGenerateContent.mockResolvedValue(fakeResponse('', 'SAFETY'));

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        apiKey: 'sk-test',
      })
    ).rejects.toThrow(/no text content.*SAFETY/);
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

    expect(mockGenerateContent).not.toHaveBeenCalled();
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

  it('retries on a 503 then succeeds', async () => {
    mockGenerateContent
      .mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }))
      .mockResolvedValueOnce(fakeResponse('finally', 'STOP'));

    // Stub setTimeout so we don't wait the full 5s in tests.
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
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });
});
