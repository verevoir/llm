import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the openai SDK so the tool loop runs with canned completions (no network).
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(_opts: unknown) {}
  },
}));

import { createOpenAICompatAdapter } from './openai-compat.js';
import { setModelSpanSink, type ModelCatalogEntry, type ModelSpan } from './index.js';

const catalog: ModelCatalogEntry[] = [
  {
    provider: 'tooltest',
    family: 'm',
    modelClass: 'reasoning',
    currentId: 'tooltest-m',
    rates: [1, 1],
    label: 'M',
  },
];
const a = createOpenAICompatAdapter({
  provider: 'tooltest',
  baseURL: 'https://x/v1',
  apiKeyEnv: 'TOOLTEST_KEY',
  catalog,
});

const TOOL = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object' as const, properties: { x: { type: 'number' } } },
};

function toolCallReply(args: string) {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'record', arguments: args } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}
function textReply(text: string) {
  return {
    choices: [{ message: { content: text, tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  };
}

beforeEach(() => createMock.mockReset());
afterEach(() => setModelSpanSink(null));

describe('openai-compat tool calling', () => {
  it('chatWithTools surfaces the model tool calls (single-shot, parsed args)', async () => {
    createMock.mockResolvedValueOnce(toolCallReply('{"x":1}'));
    const r = await a.chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0]).toMatchObject({ name: 'record', input: { x: 1 } });
    expect(r.stopReason).toBe('tool_calls');
    expect(r.usage.outputTokens).toBe(5);
  });

  it('chatWithToolLoop executes tools, feeds results back, and returns the tool-free reply', async () => {
    createMock
      .mockResolvedValueOnce(toolCallReply('{"x":1}'))
      .mockResolvedValueOnce(textReply('all done'));
    const executor = vi.fn(async () => 'recorded');
    const r = await a.chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
    });
    expect(executor).toHaveBeenCalledOnce();
    expect((executor.mock.calls[0] as unknown[])[0]).toMatchObject({
      name: 'record',
      input: { x: 1 },
    });
    expect(r.text).toBe('all done');
    expect(r.iterations).toBe(2);
    expect(r.toolUses.map((u) => u.name)).toEqual(['record']);
    expect(r.toolResults[0]).toMatchObject({ content: 'recorded', isError: false });
    expect(r.usage.outputTokens).toBe(8); // 5 + 3 across iterations
    // the second model call must carry the tool result back
    const secondArg = (createMock.mock.calls[1] as unknown[])[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondArg.messages.some((m) => m.role === 'tool' && m.content === 'recorded')).toBe(
      true
    );
  });

  it('surfaces an executor failure as an error tool result and lets the model recover', async () => {
    createMock.mockResolvedValueOnce(toolCallReply('{}')).mockResolvedValueOnce(textReply('ok'));
    const executor = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await a.chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
    });
    expect(r.toolResults[0]).toMatchObject({ content: 'boom', isError: true });
    expect(r.text).toBe('ok');
  });

  it('chatWithTools emits a model span scoped with the factory config provider name', async () => {
    createMock.mockResolvedValueOnce(toolCallReply('{"x":1}'));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await a.chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'tooltest.chatWithTools',
      provider: 'tooltest',
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('stops at maxIterations when the model keeps calling tools', async () => {
    createMock.mockResolvedValue(toolCallReply('{}'));
    const executor = vi.fn(async () => 'r');
    const r = await a.chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
      maxIterations: 2,
    });
    expect(r.iterations).toBe(2);
    expect(r.text).toBe('');
    expect(executor).toHaveBeenCalledTimes(2);
  });
});
