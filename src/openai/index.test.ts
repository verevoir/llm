import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER } from './index.js';
import { modelLabel } from '../index.js';

describe('@verevoir/llm/openai — exported model table', () => {
  it('reports the openai provider id', () => {
    expect(PROVIDER).toBe('openai');
  });

  it('maps the two model classes to concrete model ids', () => {
    expect(models.reasoning).toBe('gpt-5');
    expect(models.extraction).toBe('gpt-5-mini');
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
    expect(modelLabel('gpt-5')).toBe('GPT-5');
    expect(modelLabel('gpt-5-mini')).toBe('GPT-5 Mini');
  });
});
