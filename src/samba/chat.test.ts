import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the OpenAI SDK before importing the adapter. SambaNova speaks the
// Chat Completions API via the shared OpenAI-compatible factory.
const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: unknown) {}
  },
}));

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { chat, chatWithToolLoop } from './index.js';
import { setModelSpanSink, type ModelSpan } from '../index.js';

function textReply(content: string, usage = { prompt_tokens: 12, completion_tokens: 8 }) {
  return {
    choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }],
    usage,
  };
}

function toolCallReply() {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'record', arguments: '{"x":1}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

const TOOL = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object' as const, properties: { x: { type: 'number' } } },
};

describe('samba — model-span emission', () => {
  beforeEach(() => mockCreate.mockReset());
  afterEach(() => setModelSpanSink(null));

  it('chat emits a model span to the registered sink with scope samba.chat', async () => {
    mockCreate.mockResolvedValue(textReply('hello'));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      apiKey: 'sk-test',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'samba.chat',
      provider: 'samba',
      inputTokens: 12,
      outputTokens: 8,
    });
  });

  it('chatWithToolLoop emits one span per iteration with scope samba.chatWithToolLoop', async () => {
    mockCreate.mockResolvedValueOnce(toolCallReply()).mockResolvedValueOnce(textReply('done'));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'recorded',
      apiKey: 'sk-test',
    });

    expect(spans).toHaveLength(2); // one per underlying model call
    expect(spans.map((s) => s.scope)).toEqual(['samba.chatWithToolLoop', 'samba.chatWithToolLoop']);
    expect(spans.every((s) => s.provider === 'samba')).toBe(true);
  });
});
