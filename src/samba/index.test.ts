import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER, BASE_URL } from './index.js';
import { modelLabel, normalizeModelId } from '../index.js';

describe('@verevoir/llm/samba — exported model table', () => {
  it('reports the samba provider id + OpenAI-compatible base URL', () => {
    expect(PROVIDER).toBe('samba');
    expect(BASE_URL).toBe('https://api.sambanova.ai/v1');
  });

  it('maps classes to model ids (extraction = 8B; drafting falls up to 70B)', () => {
    expect(models.reasoning).toBe('Meta-Llama-3.3-70B-Instruct');
    expect(models.extraction).toBe('Meta-Llama-3.1-8B-Instruct');
    expect(models.drafting).toBe('Meta-Llama-3.3-70B-Instruct');
  });

  it('exposes a rate tuple for every model in the class table', () => {
    for (const id of Object.values(models)) {
      expect(rates[id]).toBeDefined();
      expect(rates[id]).toHaveLength(2);
    }
  });

  it('registers family identity + labels, and normalises a new version via the prefix', () => {
    expect(normalizeModelId('Meta-Llama-3.3-70B-Instruct')).toEqual({
      provider: 'samba',
      family: 'llama-70b',
    });
    expect(modelLabel('Meta-Llama-3.1-8B-Instruct')).toBe('Llama 3.1 8B');
  });
});
