import { describe, it, expect, afterEach } from 'vitest';
import {
  setModelSpanSink,
  emitModelSpan,
  type ModelSpan,
} from './audit-hook';

const span = (over: Partial<ModelSpan> = {}): ModelSpan => ({
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  direction: 'reasoning',
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  scope: 'anthropic.chatWithTools',
  ...over,
});

afterEach(() => setModelSpanSink(null));

describe('model-span hook', () => {
  it('no-ops when no sink is registered (off by default)', () => {
    expect(() => emitModelSpan(span())).not.toThrow();
  });

  it('delivers the span to a registered sink', () => {
    const seen: ModelSpan[] = [];
    setModelSpanSink((s) => seen.push(s));
    emitModelSpan(span({ model: 'claude-haiku', direction: 'extraction' }));
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe('claude-haiku');
    expect(seen[0].direction).toBe('extraction');
    expect(seen[0].scope).toBe('anthropic.chatWithTools');
  });

  it('most-recent registration wins, and null detaches', () => {
    const a: ModelSpan[] = [];
    const b: ModelSpan[] = [];
    setModelSpanSink((s) => a.push(s));
    setModelSpanSink((s) => b.push(s));
    emitModelSpan(span());
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);

    setModelSpanSink(null);
    emitModelSpan(span());
    expect(b).toHaveLength(1); // detached — no further delivery
  });

  it('is fail-soft — a throwing sink does not propagate to the caller', () => {
    setModelSpanSink(() => {
      throw new Error('sink boom');
    });
    expect(() => emitModelSpan(span())).not.toThrow();
  });
});
