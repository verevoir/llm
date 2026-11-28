import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Mock the openai SDK so the tool loop runs with canned completions (no network).
vi.mock('openai', () => import('./test-support/openai-sdk.js'));

import {
  chatCompletionsCreate as createMock,
  textCompletion,
  toolCallCompletion,
} from './test-support/openai-sdk.js';
import { createOpenAICompatAdapter } from './openai-compat.js';
import {
  setModelSpanSink,
  type ContentBlock,
  type ModelCatalogEntry,
  type ModelSpan,
} from './index.js';
import { ATTR_GEN_AI_PROVIDER_NAME } from './otel.js';

// One tracer for the file: OpenTelemetry takes a global provider only once.
const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(() => {
  trace.setGlobalTracerProvider(tracerProvider);
});
afterAll(async () => {
  await tracerProvider.shutdown();
});

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
  spanProvider: 'tooltest-span',
  baseURL: 'https://x/v1',
  apiKeyEnv: 'TOOLTEST_KEY',
  catalog,
});

const TOOL = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object' as const, properties: { x: { type: 'number' } } },
};

/** The loop's final text reply reports 3 output tokens. */
const TEXT_USAGE = { prompt_tokens: 12, completion_tokens: 3 };

beforeEach(() => {
  createMock.mockReset();
  exporter.reset();
});
afterEach(() => setModelSpanSink(null));

describe('openai-compat tool calling', () => {
  it('chatWithTools surfaces the model tool calls (single-shot, parsed args)', async () => {
    createMock.mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'));
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
      .mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'))
      .mockResolvedValueOnce(textCompletion('all done', TEXT_USAGE));
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
    createMock
      .mockResolvedValueOnce(toolCallCompletion('record', '{}'))
      .mockResolvedValueOnce(textCompletion('ok', TEXT_USAGE));
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
    createMock.mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'));
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

  it('chatWithToolLoop emits one span per iteration, scoped with the factory config provider name', async () => {
    createMock
      .mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'))
      .mockResolvedValueOnce(textCompletion('all done', TEXT_USAGE));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await a.chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'recorded',
      apiKey: 'k',
    });

    expect(spans).toHaveLength(2); // one per underlying model call
    expect(spans.map((s) => s.scope)).toEqual([
      'tooltest.chatWithToolLoop',
      'tooltest.chatWithToolLoop',
    ]);
    expect(spans.every((s) => s.provider === 'tooltest')).toBe(true);
    expect(spans.map((s) => s.inputTokens)).toEqual([10, 12]); // per-iteration, not aggregate
  });

  it('chatWithTools and chatWithToolLoop: the span says the config spanProvider; the usage and the sink say its provider', async () => {
    createMock
      .mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'))
      .mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'))
      .mockResolvedValueOnce(textCompletion('all done', TEXT_USAGE));
    const sunk: ModelSpan[] = [];
    setModelSpanSink((s) => sunk.push(s));
    const base = { systemPrompt: 's', turns: [{ role: 'user' as const, content: 'go' }] };

    const single = await a.chatWithTools({ ...base, tools: [TOOL], apiKey: 'k' });
    const loop = await a.chatWithToolLoop({
      ...base,
      tools: [TOOL],
      executor: async () => 'recorded',
      apiKey: 'k',
    });

    expect({
      span: exporter.getFinishedSpans().map((s) => s.attributes[ATTR_GEN_AI_PROVIDER_NAME]),
      usage: [single.usage.provider, loop.usage.provider],
      sink: sunk.map((s) => s.provider),
    }).toEqual({
      span: ['tooltest-span', 'tooltest-span', 'tooltest-span'],
      usage: ['tooltest', 'tooltest'],
      sink: ['tooltest', 'tooltest', 'tooltest'],
    });
  });

  it('on cap-hit, makes a final no-tools call and returns its synthesised answer (not empty)', async () => {
    // 2 tool-calling iterations exhaust the cap; the 3rd create() is the
    // forced no-tools finalise.
    createMock
      .mockResolvedValueOnce(toolCallCompletion('record', '{}'))
      .mockResolvedValueOnce(toolCallCompletion('record', '{}'))
      .mockResolvedValueOnce(textCompletion('finished work', TEXT_USAGE));
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
    expect(r.text).toBe('finished work');
    expect(executor).toHaveBeenCalledTimes(2);
    expect(createMock).toHaveBeenCalledTimes(3);
    // the finalise request carried no tools, so the model had to answer in text
    const finalArgs = createMock.mock.calls[2][0] as { tools?: unknown };
    expect(finalArgs.tools).toBeUndefined();
    // the finalise call's usage folds into the aggregate (2 tool rounds @5 + finalise @3)
    expect(r.usage.outputTokens).toBe(5 + 5 + 3);
  });

  it('degrades to empty text (never throws) when the finalise call fails', async () => {
    createMock
      .mockResolvedValueOnce(toolCallCompletion('record', '{}'))
      .mockResolvedValueOnce(toolCallCompletion('record', '{}'))
      .mockRejectedValueOnce(new Error('finalise boom'));
    const r = await a.chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor: async () => 'r',
      apiKey: 'k',
      maxIterations: 2,
    });
    expect(r.iterations).toBe(2);
    expect(r.text).toBe('');
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('an executor returning an unsupported image block becomes a named is_error tool result, not a crash', async () => {
    createMock
      .mockResolvedValueOnce(toolCallCompletion('record', '{"x":1}'))
      .mockResolvedValueOnce(textCompletion('ok', TEXT_USAGE));
    const executor = vi.fn(async (): Promise<ContentBlock[]> => [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ]);
    const r = await a.chatWithToolLoop({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      tools: [TOOL],
      executor,
      apiKey: 'k',
    });
    expect(r.toolResults[0].isError).toBe(true);
    expect(r.toolResults[0].content).toContain('tooltest');
    expect(r.toolResults[0].content).toContain('image');
    // The loop still reaches the final text reply — the refusal is a named
    // tool_result, not a thrown error that aborts the loop.
    expect(r.text).toBe('ok');
  });
});
