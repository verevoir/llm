import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Anthropic SDK module before importing the adapter. Each
// test sets up the fake `messages.stream` to return a controlled
// sequence of stop reasons + content blocks, simulating the model's
// tool-call decisions across loop iterations.
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

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { chatWithToolLoop } from './index.js';
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
    finalMessage: async () => ({
      content: blocks,
      stop_reason: stopReason,
      usage,
    }),
  };
}

describe('chatWithToolLoop', () => {
  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
  });

  afterEach(() => setModelSpanSink(null));

  it('returns immediately when the first response is text-only', async () => {
    mockStream.mockReturnValue(
      fakeStream([{ type: 'text', text: 'Hello' }], 'end_turn', {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      })
    );

    const result = await chatWithToolLoop({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'hi' }],
      apiKey: 'sk-test',
      tools: [
        {
          name: 'noop',
          description: 'noop',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      executor: async () => {
        throw new Error('executor must not be called when no tools were used');
      },
    });

    expect(result.text).toBe('Hello');
    expect(result.iterations).toBe(1);
    expect(result.toolUses).toEqual([]);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it('runs a tool then a follow-up call, summing usage across iterations', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream(
          [
            { type: 'text', text: 'Let me check' },
            {
              type: 'tool_use',
              id: 'u1',
              name: 'list_issues',
              input: { repoUrl: 'a/b' },
            },
          ],
          'tool_use',
          {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }
        )
      )
      .mockReturnValueOnce(
        fakeStream([{ type: 'text', text: 'Found 3 issues' }], 'end_turn', {
          input_tokens: 20,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })
      );

    const executor = vi.fn(async () => '[{"number":1,"title":"x"}]');

    const result = await chatWithToolLoop({
      systemPrompt: 'You are helpful.',
      turns: [{ role: 'user', content: 'list issues' }],
      apiKey: 'sk-test',
      tools: [
        {
          name: 'list_issues',
          description: 'list',
          input_schema: {
            type: 'object',
            properties: { repoUrl: { type: 'string' } },
            required: ['repoUrl'],
          },
        },
      ],
      executor,
    });

    expect(result.text).toBe('Found 3 issues');
    expect(result.iterations).toBe(2);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe('list_issues');
    expect(executor).toHaveBeenCalledTimes(1);
    // Usage summed across the two iterations
    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.outputTokens).toBe(15);
  });

  const toolUseNoop = (id: string) =>
    fakeStream([{ type: 'tool_use', id, name: 'noop', input: {} }], 'tool_use', {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

  it('on cap-hit, makes a final no-tools call and returns its synthesised answer (not empty)', async () => {
    // 3 tool-calling iterations exhaust maxIterations; the 4th call is the
    // forced no-tools finalise, which produces the written answer.
    mockStream
      .mockReturnValueOnce(toolUseNoop('u1'))
      .mockReturnValueOnce(toolUseNoop('u2'))
      .mockReturnValueOnce(toolUseNoop('u3'))
      .mockReturnValueOnce(
        fakeStream([{ type: 'text', text: 'Here is the finished work.' }], 'end_turn', {
          input_tokens: 5,
          output_tokens: 7,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })
      );

    const result = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'ok',
      maxIterations: 3,
    });

    // iterations counts the tool-loop rounds; the finalise is a 4th model call.
    expect(result.iterations).toBe(3);
    expect(result.text).toBe('Here is the finished work.');
    expect(mockStream).toHaveBeenCalledTimes(4);
    // the finalise request carried NO tools, so the model had to answer in text
    const finalRequest = mockStream.mock.calls[3][0] as { tools?: unknown[] };
    expect(finalRequest.tools).toBeUndefined();
    // the finalise call's usage is folded into the aggregate
    expect(result.usage.outputTokens).toBe(1 + 1 + 1 + 7);
  });

  it('degrades to empty text (never throws) when the finalise call itself fails', async () => {
    mockStream
      .mockReturnValueOnce(toolUseNoop('u1'))
      .mockReturnValueOnce(toolUseNoop('u2'))
      .mockReturnValueOnce(toolUseNoop('u3'))
      .mockImplementationOnce(() => {
        throw new Error('finalise boom');
      });

    const result = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'ok',
      maxIterations: 3,
    });

    expect(result.iterations).toBe(3);
    expect(result.text).toBe('');
    expect(mockStream).toHaveBeenCalledTimes(4);
  });

  it('surfaces executor errors back to the model as is_error tool_results', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'flaky', input: {} }], 'tool_use')
      )
      .mockReturnValueOnce(
        fakeStream([{ type: 'text', text: 'Sorry, the tool failed.' }], 'end_turn')
      );

    const result = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        {
          name: 'flaky',
          description: 'flaky',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      executor: async () => {
        throw new Error('tool exploded');
      },
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].isError).toBe(true);
    expect(result.toolResults[0].content).toBe('tool exploded');
    expect(result.text).toBe('Sorry, the tool failed.');
  });

  it('fires onIteration once per loop iteration', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use')
      )
      .mockReturnValueOnce(fakeStream([{ type: 'text', text: 'done' }], 'end_turn'));

    const onIteration = vi.fn<(info: { iteration: number; stopReason: string }) => Promise<void>>(
      async () => {}
    );

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        {
          name: 'noop',
          description: 'noop',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      executor: async () => 'ok',
      onIteration,
    });

    expect(onIteration).toHaveBeenCalledTimes(2);
    expect(onIteration.mock.calls[0][0]).toMatchObject({
      iteration: 1,
      stopReason: 'tool_use',
    });
    expect(onIteration.mock.calls[1][0]).toMatchObject({
      iteration: 2,
      stopReason: 'end_turn',
    });
  });

  it('emits one model span per iteration with scope anthropic.chatWithToolLoop', async () => {
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use', {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })
      )
      .mockReturnValueOnce(
        fakeStream([{ type: 'text', text: 'done' }], 'end_turn', {
          input_tokens: 20,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })
      );
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      tools: [
        {
          name: 'noop',
          description: 'noop',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      executor: async () => 'ok',
    });

    expect(spans).toHaveLength(2); // one per underlying model call
    expect(spans.map((s) => s.scope)).toEqual([
      'anthropic.chatWithToolLoop',
      'anthropic.chatWithToolLoop',
    ]);
    expect(spans.every((s) => s.provider === 'anthropic')).toBe(true);
    expect(spans.map((s) => s.inputTokens)).toEqual([10, 20]); // per-iteration, not aggregate
  });

  it('sends the pinned model id on every iteration, including the no-tools finalise call', async () => {
    const toolUseNoop2 = (id: string) =>
      fakeStream([{ type: 'tool_use', id, name: 'noop', input: {} }], 'tool_use');
    mockStream
      .mockReturnValueOnce(toolUseNoop2('u1'))
      .mockReturnValueOnce(toolUseNoop2('u2'))
      .mockReturnValueOnce(toolUseNoop2('u3'))
      .mockReturnValueOnce(fakeStream([{ type: 'text', text: 'done' }], 'end_turn'));

    const result = await chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'sk-test',
      modelClass: 'extraction',
      model: 'claude-pinned-judge-1',
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'ok',
      maxIterations: 3,
    });

    for (const call of mockStream.mock.calls) {
      expect((call[0] as { model: string }).model).toBe('claude-pinned-judge-1');
    }
    expect(result.usage.model).toBe('claude-pinned-judge-1');
  });

  it('throws when no tools are provided (tool loop with no tools is a misuse)', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 's',
        turns: [{ role: 'user', content: 'go' }],
        apiKey: 'sk-test',
        tools: [],
        executor: async () => 'ok',
      })
    ).rejects.toThrow(/at least one tool/);
  });

  it('throws when turns is empty', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 's',
        turns: [],
        apiKey: 'sk-test',
        tools: [
          {
            name: 'x',
            description: 'x',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        executor: async () => 'ok',
      })
    ).rejects.toThrow(/at least one turn/);
  });

  it('throws the abort reason when the signal is already aborted before the call', async () => {
    const controller = new AbortController();
    const reason = new Error('budget exceeded before call');
    controller.abort(reason);

    await expect(
      chatWithToolLoop({
        systemPrompt: 's',
        turns: [{ role: 'user', content: 'go' }],
        apiKey: 'sk-test',
        tools: [
          {
            name: 'noop',
            description: 'noop',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        executor: async () => 'ok',
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);

    // No LLM call should have happened.
    expect(mockStream).not.toHaveBeenCalled();
  });

  it('aborts mid-loop when onUsage calls abort — the in-flight iteration completes, the next never starts', async () => {
    // Two streams set up — but the test expects only the first to be
    // consumed, because onUsage aborts after the first iteration.
    mockStream
      .mockReturnValueOnce(
        fakeStream([{ type: 'tool_use', id: 'u1', name: 'noop', input: {} }], 'tool_use', {
          input_tokens: 1000,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        })
      )
      .mockReturnValueOnce(fakeStream([{ type: 'text', text: 'never' }], 'end_turn'));

    const controller = new AbortController();
    const reason = new Error('mid-loop budget exceeded');
    const onUsage = vi.fn(async () => {
      controller.abort(reason);
    });

    await expect(
      chatWithToolLoop({
        systemPrompt: 's',
        turns: [{ role: 'user', content: 'go' }],
        apiKey: 'sk-test',
        tools: [
          {
            name: 'noop',
            description: 'noop',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        executor: async () => 'ok',
        onUsage,
        abortSignal: controller.signal,
      })
    ).rejects.toBe(reason);

    // First iteration's LLM call happened (we paid for it); the
    // second never started.
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledTimes(1);
  });
});
