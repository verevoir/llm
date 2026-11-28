import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Mock the OpenAI SDK before importing the adapters. Every adapter here
// speaks the Chat Completions API, so one fake serves them all.
vi.mock('openai', () => import('./test-support/openai-sdk.js'));

import {
  chatCompletionsCreate as mockCreate,
  textCompletion,
  toolCallCompletion,
} from './test-support/openai-sdk.js';
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
import { createPriceBook } from './pricing.js';

/** A model id that is in no adapter's catalogue and no class. */
const NAMED = 'named-model-in-no-class';

const TOOL = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object' as const, properties: { x: { type: 'number' } } },
};

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
    mockCreate.mockResolvedValue(textCompletion('ok'));

    await run({ model: NAMED, modelClass: 'extraction' });

    expect(requestModels()).toEqual([NAMED]);
  });

  it.each(CASES)('$name sends the class’s model when none is named', async ({ run, models }) => {
    mockCreate.mockResolvedValue(textCompletion('ok'));

    await run({ modelClass: 'extraction' });

    expect(requestModels()).toEqual([models.extraction]);
  });

  it.each(CASES)('$name reports the model sent on the usage and the span', async ({ run }) => {
    mockCreate.mockResolvedValue(textCompletion('ok'));
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
      mockCreate.mockResolvedValue(textCompletion('ok'));

      const withClass = await run({ model: NAMED, modelClass: 'extraction' });
      const withoutClass = await run({ model: NAMED });

      expect(withClass.direction).toBe('extraction');
      expect(withoutClass.direction).toBe('reasoning');
    }
  );

  // `prompt_tokens` includes the cached tokens (src/otel.ts's header); the
  // returned count subtracts them (openai-compat.test.ts).
  const CACHED_REPLY = {
    choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  };

  it.each(CASES)(
    '$name: the span input is prompt_tokens as the provider gave it, the cache read under the conventions’ name',
    async ({ run }) => {
      mockCreate.mockResolvedValue(CACHED_REPLY);

      await run({});

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThan(0);
      for (const span of spans) {
        expect(span.attributes['gen_ai.usage.input_tokens']).toBe(1000);
        expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(800);
        expect(Object.keys(span.attributes)).not.toContain('verevoir.llm.cache_read_input_tokens');
      }
    }
  );

  it.each(FACTORY_BUILT.map((a) => ({ name: `${a.PROVIDER}.chat`, a })))(
    "$name: chat()'s returned counts and cost are the factory's own, whatever the span's input",
    async ({ a }) => {
      mockCreate.mockResolvedValue(CACHED_REPLY);
      const book = createPriceBook({
        snapshot: {
          [NAMED]: {
            inputCostPerToken: 1e-6,
            outputCostPerToken: 2e-6,
            cacheReadInputTokenCost: 1e-7,
          },
        },
        fetch: () => {
          throw new Error('must not fetch — this book is never start()-ed');
        },
      });

      const reply = await a.chat({ ...BASE, model: NAMED });

      expect(reply.usage).toMatchObject({
        inputTokens: 200,
        outputTokens: 50,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 0,
      });
      expect(exporter.getFinishedSpans()[0].attributes['gen_ai.usage.input_tokens']).toBe(1000);
      expect(book.costOf(reply.usage)).toHaveProperty('usdMicros');
      expect(book.costOf(reply.usage)).toEqual(
        book.costOf({
          provider: a.PROVIDER,
          model: NAMED,
          inputTokens: 200,
          outputTokens: 50,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 0,
        })
      );
    }
  );

  it.each(FACTORY_BUILT.map((a) => ({ name: `${a.PROVIDER}.chatWithToolLoop`, a })))(
    '$name sends the named model on every iteration and on the final call',
    async ({ a }) => {
      // Two iterations that both call a tool reach the cap, so the loop makes
      // its final no-tools call: three requests in all.
      mockCreate
        .mockResolvedValueOnce(toolCallCompletion())
        .mockResolvedValueOnce(toolCallCompletion())
        .mockResolvedValueOnce(textCompletion('done'));
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
