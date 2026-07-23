import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER } from './index.js';
import { modelLabel, normalizeModelId, estimateCostUSD, type PerModelUsage } from '../index.js';

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

  // A rate that merely EXISTS is not a rate that is RIGHT: the catalog carried
  // Opus at [15, 75] (Opus-3 era) long after Opus 4.6+ moved to [5, 25], and
  // every cost this system reported was 3x high for as long as it did. Rates are
  // the one field where staleness is silent and scales everything downstream, so
  // pin the published numbers — a pricing change must break this test.
  it('prices each family at its published rate, not merely some rate', () => {
    expect(rates['claude-opus-4-8']).toEqual([5, 25]);
    expect(rates['claude-sonnet-4-6']).toEqual([3, 15]);
    expect(rates['claude-haiku-4-5-20251001']).toEqual([1, 5]);
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

describe('@verevoir/llm/anthropic — de-brittled model identity', () => {
  it('normalises the concrete ids to provider/family (the decision key)', () => {
    expect(normalizeModelId('claude-opus-4-8')).toEqual({ provider: 'anthropic', family: 'opus' });
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toEqual({
      provider: 'anthropic',
      family: 'haiku',
    });
    // an older alias still resolves
    expect(normalizeModelId('claude-opus-4-7')).toEqual({ provider: 'anthropic', family: 'opus' });
  });

  it('normalises a future, unseen Haiku version to the haiku family (prefix-forward)', () => {
    expect(normalizeModelId('claude-haiku-5-0-20260601')).toEqual({
      provider: 'anthropic',
      family: 'haiku',
    });
  });

  it('prices a future Haiku version at the haiku family rate (no new rates row needed)', () => {
    const usage: PerModelUsage = { 'claude-haiku-5-0-20260601': { in: 1_000_000, out: 1_000_000 } };
    // haiku family rate is [1, 5]; the drifted id isn't in `rates`, the catalog covers it.
    expect(estimateCostUSD(usage, rates)).toBeCloseTo(1 + 5, 5);
  });

  it('labels a future Haiku version as Haiku', () => {
    expect(modelLabel('claude-haiku-5-0-20260601')).toBe('Haiku');
  });
});
