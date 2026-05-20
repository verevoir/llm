import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER } from './index.js';
import { modelLabel } from '../index.js';

describe('@verevoir/llm/google — exported model table', () => {
  it('reports the google provider id', () => {
    expect(PROVIDER).toBe('google');
  });

  it('maps the two model classes to concrete model ids', () => {
    expect(models.reasoning).toBe('gemini-2.5-pro');
    expect(models.extraction).toBe('gemini-2.5-flash');
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
    // tile UI calls modelLabel(id) and expects "Gemini Pro" / "Gemini
    // Flash".
    expect(modelLabel('gemini-2.5-pro')).toBe('Gemini Pro');
    expect(modelLabel('gemini-2.5-flash')).toBe('Gemini Flash');
  });
});
