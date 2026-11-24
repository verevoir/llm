import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Mock the OpenAI SDK before importing the adapters. Every adapter here
// speaks the Chat Completions API, so one fake serves them all.
const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: unknown) {}
  },
}));

// Import AFTER vi.mock so the mocked constructor is the one captured.
import { samba } from './samba/index.js';
import { mistral } from './mistral/index.js';
import * as deepseek from './deepseek/index.js';
import { ATTR_GEN_AI_REQUEST_MODEL } from './otel.js';
import {
  setModelSpanSink,
  type ChatOptions,
  type ModelClass,
  type ModelSpan,
  type TokenUsage,
} from './index.js';

/** A model id that is in no adapter's catalogue and no class. */
const NAMED = 'named-model-in-no-class';

const TOOL = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object' as const, properties: { x: { type: 'number' } } },
};

function textReply(content: string) {
  return {
    choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8 },
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

type ModelChoice = Pick<ChatOptions, 'model' | 'modelClass' | 'onUsage'>;

interface Case {
  /** `<provider>.<call shape>`, which is also the model span's scope. */
  name: string;
  models: Readonly<Record<ModelClass, string>>;
  /** Make one call of this shape and return the usage it reports. */
  run: (choice: ModelChoice) => Promise<TokenUsage>;
}

const BASE = { systemPrompt: 's', turns: [{ role: 'user' as const, content: 'q' }], apiKey: 'k' };

/** The two adapters built by the OpenAI-compatible factory. */
const FACTORY_BUILT = [samba, mistral];

/** Every call shape of every adapter under test: the three shapes of each
 * factory-built adapter, and DeepSeek's own `chat`. */
const CASES: Case[] = [
  ...FACTORY_BUILT.flatMap((a): Case[] => [
    {
      name: `${a.PROVIDER}.chat`,
      models: a.models,
      run: async (choice) => (await a.chat({ ...BASE, ...choice })).usage,
    },
    {
      name: `${a.PROVIDER}.chatWithTools`,
      models: a.models,
      run: async (choice) => (await a.chatWithTools({ ...BASE, ...choice, tools: [TOOL] })).usage,
    },
    {
      name: `${a.PROVIDER}.chatWithToolLoop`,
      models: a.models,
      run: async (choice) =>
        (
          await a.chatWithToolLoop({
            ...BASE,
            ...choice,
            tools: [TOOL],
            executor: async () => 'recorded',
          })
        ).usage,
    },
  ]),
  {
    name: 'deepseek.chat',
    models: deepseek.models,
    run: async (choice) => (await deepseek.chat({ ...BASE, ...choice })).usage,
  },
];

function requestModels(): string[] {
  return mockCreate.mock.calls.map((call) => (call[0] as { model: string }).model);
}

describe('OpenAI-compatible adapters — the model a caller names', () => {
  let exporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(tracerProvider);
  });

  beforeEach(() => {
    mockCreate.mockReset();
    exporter.reset();
  });

  afterEach(() => setModelSpanSink(null));

  afterAll(async () => {
    trace.disable();
    await tracerProvider.shutdown();
  });

  it.each(CASES)('$name sends the named model, not the class’s', async ({ run }) => {
    mockCreate.mockResolvedValue(textReply('ok'));

    await run({ model: NAMED, modelClass: 'extraction' });

    expect(requestModels()).toEqual([NAMED]);
  });

  it.each(CASES)('$name sends the class’s model when none is named', async ({ run, models }) => {
    mockCreate.mockResolvedValue(textReply('ok'));

    await run({ modelClass: 'extraction' });

    expect(requestModels()).toEqual([models.extraction]);
  });

  it.each(CASES)('$name reports the model sent on the usage and the span', async ({ run }) => {
    mockCreate.mockResolvedValue(textReply('ok'));
    const hooked: TokenUsage[] = [];
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    const usage = await run({
      model: NAMED,
      modelClass: 'extraction',
      onUsage: async (u) => {
        hooked.push(u);
      },
    });

    expect(usage.model).toBe(NAMED);
    expect(hooked.map((u) => u.model)).toEqual([NAMED]);
    expect(spans.map((s) => s.model)).toEqual([NAMED]);
    expect(exporter.getFinishedSpans().map((s) => s.attributes[ATTR_GEN_AI_REQUEST_MODEL])).toEqual(
      [NAMED]
    );
  });

  it.each(CASES)(
    '$name keeps the class asked for as the usage direction when a model is named',
    async ({ run }) => {
      mockCreate.mockResolvedValue(textReply('ok'));

      const withClass = await run({ model: NAMED, modelClass: 'extraction' });
      const withoutClass = await run({ model: NAMED });

      expect(withClass.direction).toBe('extraction');
      expect(withoutClass.direction).toBe('reasoning');
    }
  );

  it.each(FACTORY_BUILT.map((a) => ({ name: `${a.PROVIDER}.chatWithToolLoop`, a })))(
    '$name sends the named model on every iteration and on the final call',
    async ({ a }) => {
      // Two iterations that both call a tool reach the cap, so the loop makes
      // its final no-tools call: three requests in all.
      mockCreate
        .mockResolvedValueOnce(toolCallReply())
        .mockResolvedValueOnce(toolCallReply())
        .mockResolvedValueOnce(textReply('done'));
      const hooked: TokenUsage[] = [];

      const result = await a.chatWithToolLoop({
        ...BASE,
        model: NAMED,
        modelClass: 'extraction',
        tools: [TOOL],
        executor: async () => 'recorded',
        maxIterations: 2,
        onUsage: async (u) => {
          hooked.push(u);
        },
      });

      expect(result.iterations).toBe(2);
      expect(requestModels()).toEqual([NAMED, NAMED, NAMED]);
      expect(hooked.map((u) => u.model)).toEqual([NAMED, NAMED, NAMED]);
    }
  );
});
