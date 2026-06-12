import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @google/genai so the tool loop runs with canned responses (no network).
const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: generateMock };
    constructor(_opts: unknown) {}
  },
}));

import { chatWithTools, chatWithToolLoop } from './index.js';

const TOOL = {
  name: 'record_step',
  description: 'Record one concrete first step.',
  input_schema: {
    type: 'object' as const,
    properties: { step: { type: 'string' } },
    required: ['step'],
  },
};

function fnCallReply(args: Record<string, unknown>) {
  return {
    functionCalls: [{ id: 'c1', name: 'record_step', args }],
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name: 'record_step', args } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    text: '',
  };
}
function textReply(text: string) {
  return {
    functionCalls: [],
    candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3 },
    text,
  };
}

beforeEach(() => generateMock.mockReset());

describe('@verevoir/llm/google — tool calling', () => {
  it('chatWithTools surfaces the model functionCalls as tool uses', async () => {
    generateMock.mockResolvedValueOnce(fnCallReply({ step: 'add the flag' }));
    const r = await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0]).toMatchObject({ name: 'record_step', input: { step: 'add the flag' } });
    expect(r.usage.provider).toBe('google');
  });

  it('uppercases JSON-schema types into Gemini Schema form', async () => {
    generateMock.mockResolvedValueOnce(textReply('ok'));
    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'ok',
      apiKey: 'k',
    });
    const cfg = generateMock.mock.calls[0][0] as {
      config: { tools: Array<{ functionDeclarations: Array<{ parameters: { type: string } }> }> };
    };
    expect(cfg.config.tools[0].functionDeclarations[0].parameters.type).toBe('OBJECT');
  });

  it('chatWithToolLoop executes tools, feeds functionResponse back, and returns the final reply', async () => {
    generateMock
      .mockResolvedValueOnce(fnCallReply({ step: 'add the flag' }))
      .mockResolvedValueOnce(textReply('all done'));
    const executor = vi.fn(async () => 'recorded');
    const r = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
    });
    expect(executor).toHaveBeenCalledOnce();
    expect(r.text).toBe('all done');
    expect(r.iterations).toBe(2);
    expect(r.toolUses.map((u) => u.name)).toEqual(['record_step']);
    expect(r.toolResults[0]).toMatchObject({ content: 'recorded', isError: false });
    expect(r.usage.outputTokens).toBe(8); // 5 + 3
    // the second call must carry a functionResponse part back
    const secondContents = (
      generateMock.mock.calls[1][0] as { contents: Array<{ parts: unknown[] }> }
    ).contents;
    const hasFnResponse = secondContents.some((c) =>
      c.parts.some((p) => (p as { functionResponse?: unknown }).functionResponse)
    );
    expect(hasFnResponse).toBe(true);
  });

  it('stops at maxIterations when the model keeps calling tools', async () => {
    generateMock.mockResolvedValue(fnCallReply({ step: 'x' }));
    const r = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'r',
      apiKey: 'k',
      maxIterations: 2,
    });
    expect(r.iterations).toBe(2);
    expect(r.text).toBe('');
  });
});
