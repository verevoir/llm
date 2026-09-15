import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the OpenAI SDK before importing the adapter. The Responses API tool
// loop drives `responses.create` — same mock point as chat.test.ts.
const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    responses = { create: mockCreate };
    constructor(_opts: unknown) {}
  },
}));

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { chatWithTools, chatWithToolLoop } from './index.js';
import { setModelSpanSink, type ModelSpan } from '../index.js';

const TOOL = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object' as const, properties: { x: { type: 'number' } } },
};

function functionCallItem(callId: string, name: string, args: string) {
  return {
    type: 'function_call' as const,
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: args,
  };
}

function toolCallResponse(
  calls: { callId: string; name: string; args: string }[],
  usage = { input_tokens: 10, output_tokens: 5 }
) {
  return {
    output: calls.map((c) => functionCallItem(c.callId, c.name, c.args)),
    output_text: '',
    status: 'completed',
    usage,
  };
}

function textResponse(text: string, usage = { input_tokens: 12, output_tokens: 3 }) {
  return {
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    output_text: text,
    status: 'completed',
    usage,
  };
}

beforeEach(() => mockCreate.mockReset());
afterEach(() => setModelSpanSink(null));

describe('@verevoir/llm/openai — tool calling (Responses API)', () => {
  it('chatWithTools surfaces the model function calls, parsed args, and the genuine call_id', async () => {
    mockCreate.mockResolvedValueOnce(
      toolCallResponse([{ callId: 'call_abc', name: 'record', args: '{"x":1}' }])
    );
    const r = await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });
    expect(r.toolUses).toHaveLength(1);
    expect(r.toolUses[0]).toMatchObject({ id: 'call_abc', name: 'record', input: { x: 1 } });
    expect(r.stopReason).toBe('completed');
    expect(r.usage.outputTokens).toBe(5);
  });

  it('gives each parallel tool call its own genuine call_id — no name-based fallback collision', async () => {
    // Two parallel calls to the SAME tool name in one turn: a fallback like
    // Gemini's `id: f.id ?? f.name` would collapse these to one id (#47).
    mockCreate.mockResolvedValueOnce(
      toolCallResponse([
        { callId: 'call_1', name: 'record', args: '{"x":1}' },
        { callId: 'call_2', name: 'record', args: '{"x":2}' },
      ])
    );
    const r = await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });
    expect(r.toolUses.map((u) => u.id)).toEqual(['call_1', 'call_2']);
  });

  it('sends tools flat (type/name/description/parameters), not Chat-Completions-nested', async () => {
    mockCreate.mockResolvedValueOnce(
      toolCallResponse([{ callId: 'c1', name: 'record', args: '{}' }])
    );
    await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });
    const call = mockCreate.mock.calls[0][0] as { tools: Array<Record<string, unknown>> };
    expect(call.tools[0]).toMatchObject({
      type: 'function',
      name: 'record',
      description: 'record a thing',
    });
    expect(call.tools[0].parameters).toEqual(TOOL.input_schema);
  });

  it('chatWithTools emits a model span with scope openai.chatWithTools', async () => {
    mockCreate.mockResolvedValueOnce(
      toolCallResponse([{ callId: 'c1', name: 'record', args: '{"x":1}' }])
    );
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithTools({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      apiKey: 'k',
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ scope: 'openai.chatWithTools', provider: 'openai' });
  });

  it('chatWithToolLoop executes the tool, feeds the result back via function_call_output, and returns the final reply', async () => {
    mockCreate
      .mockResolvedValueOnce(
        toolCallResponse([{ callId: 'call_1', name: 'record', args: '{"x":1}' }])
      )
      .mockResolvedValueOnce(textResponse('all done'));
    const executor = vi.fn(async () => 'recorded');

    const r = await chatWithToolLoop({
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

    // the second call's input must carry the function_call_output keyed by
    // the SAME call_id the model emitted.
    const secondInput = (mockCreate.mock.calls[1] as unknown[])[0] as { input: unknown[] };
    expect(secondInput.input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'recorded',
    });
  });

  it('surfaces an executor failure as an error tool result and lets the model recover', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([{ callId: 'c1', name: 'record', args: '{}' }]))
      .mockResolvedValueOnce(textResponse('ok'));
    const executor = vi.fn(async () => {
      throw new Error('boom');
    });
    const r = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
    });
    expect(r.toolResults[0]).toMatchObject({ content: 'boom', isError: true });
    expect(r.text).toBe('ok');
  });

  it('chatWithToolLoop emits one model span per iteration with scope openai.chatWithToolLoop', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([{ callId: 'c1', name: 'record', args: '{"x":1}' }]))
      .mockResolvedValueOnce(textResponse('all done'));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'recorded',
      apiKey: 'k',
    });

    expect(spans).toHaveLength(2); // one per underlying model call
    expect(spans.map((s) => s.scope)).toEqual([
      'openai.chatWithToolLoop',
      'openai.chatWithToolLoop',
    ]);
    expect(spans.every((s) => s.provider === 'openai')).toBe(true);
    expect(spans.map((s) => s.inputTokens)).toEqual([10, 12]); // per-iteration, not aggregate
  });

  it('on cap-hit, makes a final no-tools call and returns its synthesised answer (not empty)', async () => {
    // 2 tool-calling iterations exhaust the cap; the 3rd create() is the
    // forced no-tools finalise.
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([{ callId: 'c1', name: 'record', args: '{}' }]))
      .mockResolvedValueOnce(toolCallResponse([{ callId: 'c2', name: 'record', args: '{}' }]))
      .mockResolvedValueOnce(textResponse('finished work'));
    const executor = vi.fn(async () => 'r');
    const r = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
      maxIterations: 2,
    });
    expect(r.iterations).toBe(2);
    expect(r.text).toBe('finished work');
    expect(executor).toHaveBeenCalledTimes(2);
    expect(mockCreate).toHaveBeenCalledTimes(3);
    // the finalise request carried no tools, so the model had to answer in text
    const finalArgs = mockCreate.mock.calls[2][0] as { tools?: unknown };
    expect(finalArgs.tools).toBeUndefined();
    // the finalise call's usage folds into the aggregate (2 tool rounds @5 + finalise @3)
    expect(r.usage.outputTokens).toBe(5 + 5 + 3);
  });

  it('degrades to empty text (never throws) when the finalise call fails', async () => {
    mockCreate
      .mockResolvedValueOnce(toolCallResponse([{ callId: 'c1', name: 'record', args: '{}' }]))
      .mockResolvedValueOnce(toolCallResponse([{ callId: 'c2', name: 'record', args: '{}' }]))
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
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('throws when no tools are supplied to chatWithTools', async () => {
    await expect(
      chatWithTools({
        systemPrompt: 's',
        turns: [{ role: 'user', content: 'go' }],
        tools: [],
        apiKey: 'k',
      })
    ).rejects.toThrow(/at least one tool/);
  });

  it('throws when no tools are supplied to chatWithToolLoop', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 's',
        turns: [{ role: 'user', content: 'go' }],
        tools: [],
        executor: async () => '',
        apiKey: 'k',
      })
    ).rejects.toThrow(/at least one tool/);
  });
});
