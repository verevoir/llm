import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  withGenAISpan,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_ERROR_TYPE,
  ATTR_VEREVOIR_CACHE_READ_INPUT_TOKENS,
  ATTR_VEREVOIR_CACHE_CREATION_INPUT_TOKENS,
  ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS,
  ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS,
  ATTR_VEREVOIR_PROVIDER_REQUEST_ID,
} from './otel.js';

// This block runs with NO tracer provider registered — the global default
// from `@opentelemetry/api`, a no-op, is whatever answers `trace.getTracer()`
// here. It must demonstrate exactly what the module's own header comment
// promises: nothing breaks, and the wrapped function's result still comes
// back, when the consuming application has installed no SDK at all.
describe('withGenAISpan — no SDK installed', () => {
  it('runs fn and returns its result unchanged with only the default no-op tracer available', async () => {
    const result = await withGenAISpan(
      { provider: 'anthropic', requestModel: 'claude-x' },
      async () => ({
        result: 42,
        outcome: { inputTokens: 1, outputTokens: 1 },
      })
    );
    expect(result).toBe(42);
  });

  it('still propagates a thrown error with only the default no-op tracer available', async () => {
    await expect(
      withGenAISpan({ provider: 'anthropic', requestModel: 'claude-x' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });
});

describe('withGenAISpan — recorded via an in-memory span exporter', () => {
  // Registered ONCE for this whole block (`@opentelemetry/api`'s global
  // tracer provider accepts exactly one registration per process; a second
  // `setGlobalTracerProvider` call after `disable()` does not actually
  // re-wire the proxy tracer in this SDK version) — each test only resets
  // the exporter, not the registration.
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    trace.disable();
    await provider.shutdown();
  });

  it('records a CLIENT span named "chat {model}" with every GenAI + cache attribute on a success that reports them', async () => {
    const result = await withGenAISpan(
      { provider: 'anthropic', requestModel: 'claude-opus-4-7' },
      async () => ({
        result: 'ok',
        outcome: {
          responseModel: 'claude-opus-4-7-20251101',
          responseId: 'msg_123',
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 30,
          cacheCreationEphemeral5mInputTokens: 10,
          cacheCreationEphemeral1hInputTokens: 20,
          providerRequestId: 'req_abc',
        },
      })
    );
    expect(result).toBe('ok');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('chat claude-opus-4-7');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.attributes).toMatchObject({
      [ATTR_GEN_AI_OPERATION_NAME]: 'chat',
      [ATTR_GEN_AI_PROVIDER_NAME]: 'anthropic',
      [ATTR_GEN_AI_REQUEST_MODEL]: 'claude-opus-4-7',
      [ATTR_GEN_AI_RESPONSE_MODEL]: 'claude-opus-4-7-20251101',
      [ATTR_GEN_AI_RESPONSE_ID]: 'msg_123',
      [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: 100,
      [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: 50,
      [ATTR_VEREVOIR_CACHE_READ_INPUT_TOKENS]: 20,
      [ATTR_VEREVOIR_CACHE_CREATION_INPUT_TOKENS]: 30,
      [ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS]: 10,
      [ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS]: 20,
      [ATTR_VEREVOIR_PROVIDER_REQUEST_ID]: 'req_abc',
    });
  });

  it('omits every cache + request-id attribute on a success that does not report them', async () => {
    await withGenAISpan({ provider: 'openai', requestModel: 'gpt-5' }, async () => ({
      result: 'ok',
      outcome: { responseModel: 'gpt-5', responseId: 'resp_1', inputTokens: 10, outputTokens: 5 },
    }));

    const span = exporter.getFinishedSpans()[0];
    expect(span.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(Object.keys(span.attributes)).not.toContain(ATTR_VEREVOIR_CACHE_READ_INPUT_TOKENS);
    expect(Object.keys(span.attributes)).not.toContain(ATTR_VEREVOIR_CACHE_CREATION_INPUT_TOKENS);
    expect(Object.keys(span.attributes)).not.toContain(
      ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_5M_INPUT_TOKENS
    );
    expect(Object.keys(span.attributes)).not.toContain(
      ATTR_VEREVOIR_CACHE_CREATION_EPHEMERAL_1H_INPUT_TOKENS
    );
    expect(Object.keys(span.attributes)).not.toContain(ATTR_VEREVOIR_PROVIDER_REQUEST_ID);
  });

  it("marks the span ERROR with error.type set to the thrown error's name, and rethrows it unchanged, on failure", async () => {
    class RateLimitError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'RateLimitError';
      }
    }

    await expect(
      withGenAISpan({ provider: 'anthropic', requestModel: 'claude-opus-4-7' }, async () => {
        throw new RateLimitError('429 rate limited');
      })
    ).rejects.toThrow('429 rate limited');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('chat claude-opus-4-7');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTR_ERROR_TYPE]).toBe('RateLimitError');
    expect(span.events.some((e) => e.name === 'exception')).toBe(true);
  });
});
