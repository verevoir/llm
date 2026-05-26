import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER, BASE_URL } from './index.js';
import { modelLabel } from '../index.js';

describe('@verevoir/llm/deepseek — exported model table', () => {
  it('reports the deepseek provider id', () => {
    expect(PROVIDER).toBe('deepseek');
  });

  it('points at DeepSeek’s OpenAI-compatible base URL', () => {
    expect(BASE_URL).toBe('https://api.deepseek.com');
  });

  it('maps the two model classes to concrete model ids', () => {
    expect(models.reasoning).toBe('deepseek-reasoner');
    expect(models.extraction).toBe('deepseek-chat');
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
    expect(modelLabel('deepseek-reasoner')).toBe('DeepSeek Reasoner');
    expect(modelLabel('deepseek-chat')).toBe('DeepSeek Chat');
  });
});
