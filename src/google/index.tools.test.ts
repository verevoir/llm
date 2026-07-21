import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @google/genai so the tool loop runs with canned responses (no network).
const { generateMock } = vi.hoisted(() => ({ generateMock: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: generateMock };
    constructor(_opts: unknown) {}
  },
}));

import { chatWithTools, chatWithToolLoop } from './index.js';
import { setModelSpanSink, type ModelSpan } from '../index.js';

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
afterEach(() => setModelSpanSink(null));

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

  it('chatWithTools emits a model span with scope google.chatWithTools', async () => {
    generateMock.mockResolvedValueOnce(fnCallReply({ step: 'x' }));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      scope: 'google.chatWithTools',
      provider: 'google',
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('chatWithToolLoop emits one model span per iteration with scope google.chatWithToolLoop', async () => {
    generateMock
      .mockResolvedValueOnce(fnCallReply({ step: 'x' }))
      .mockResolvedValueOnce(textReply('done'));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'ok',
      apiKey: 'k',
    });

    expect(spans).toHaveLength(2); // one per underlying model call
    expect(spans.map((s) => s.scope)).toEqual([
      'google.chatWithToolLoop',
      'google.chatWithToolLoop',
    ]);
    expect(spans.every((s) => s.provider === 'google')).toBe(true);
    expect(spans.map((s) => s.inputTokens)).toEqual([10, 12]); // per-iteration, not aggregate
  });

  it('on cap-hit, makes a final no-tools call and returns its synthesised answer (not empty)', async () => {
    // 2 tool-calling iterations exhaust the cap; the 3rd generateContent is
    // the forced no-tools finalise.
    generateMock
      .mockResolvedValueOnce(fnCallReply({ step: 'x' }))
      .mockResolvedValueOnce(fnCallReply({ step: 'y' }))
      .mockResolvedValueOnce(textReply('finished work'));
    const r = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'r',
      apiKey: 'k',
      maxIterations: 2,
    });
    expect(r.iterations).toBe(2);
    expect(r.text).toBe('finished work');
    expect(generateMock).toHaveBeenCalledTimes(3);
    // the finalise request omits tools, so the model had to answer in text
    const finalArgs = generateMock.mock.calls[2][0] as { config?: { tools?: unknown } };
    expect(finalArgs.config?.tools).toBeUndefined();
    // the finalise call's usage folds into the aggregate (2 tool rounds @5 + finalise @3)
    expect(r.usage.outputTokens).toBe(5 + 5 + 3);
  });

  it('degrades to empty text (never throws) when the finalise call fails', async () => {
    generateMock
      .mockResolvedValueOnce(fnCallReply({ step: 'x' }))
      .mockResolvedValueOnce(fnCallReply({ step: 'y' }))
      .mockRejectedValueOnce(new Error('finalise boom'));
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
    expect(generateMock).toHaveBeenCalledTimes(3);
  });
});
