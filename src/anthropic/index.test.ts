import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER } from './index.js';
import { modelLabel } from '../index.js';

describe('@verevoir/llm/anthropic — exported model table', () => {
  it('reports the anthropic provider id', () => {
    expect(PROVIDER).toBe('anthropic');
  });

  it('maps the three model classes to concrete model ids', () => {
    expect(models.reasoning).toBe('claude-opus-4-8');
    expect(models.drafting).toBe('claude-sonnet-4-6');
    expect(models.extraction).toBe('claude-haiku-4-5-20251001');
  });

  it('exposes a rate tuple for every model in the class table', () => {
    for (const modelId of Object.values(models)) {
      expect(rates[modelId]).toBeDefined();
      const tuple = rates[modelId];
      expect(tuple).toHaveLength(2);
      expect(typeof tuple[0]).toBe('number');
      expect(typeof tuple[1]).toBe('number');
    }
  });

  it('registers friendly labels on import (side-effect)', () => {
    // Importing the adapter calls registerModelLabels for its models;
    // by the time this test runs, those labels are live on the core
    // helper. The label registry is the consumer-visible affordance —
    // tile UI calls modelLabel(id) and expects "Opus" / "Haiku".
    expect(modelLabel('claude-opus-4-8')).toBe('Opus');
    expect(modelLabel('claude-sonnet-4-6')).toBe('Sonnet');
    expect(modelLabel('claude-haiku-4-5-20251001')).toBe('Haiku');
  });
});
