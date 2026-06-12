import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER, BASE_URL } from './index.js';
import { modelLabel, normalizeModelId } from '../index.js';

describe('@verevoir/llm/samba — exported model table', () => {
  it('reports the samba provider id + OpenAI-compatible base URL', () => {
    expect(PROVIDER).toBe('samba');
    expect(BASE_URL).toBe('https://api.sambanova.ai/v1');
  });

  it('maps classes to live-catalogue model ids (extraction = DeepSeek-V3.2; drafting falls up to Llama-70B)', () => {
    expect(models.reasoning).toBe('Meta-Llama-3.3-70B-Instruct');
    expect(models.extraction).toBe('DeepSeek-V3.2');
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
    expect(modelLabel('DeepSeek-V3.2')).toBe('DeepSeek V3.2');
    // a future V3 point-release still normalises to the family via the prefix
    expect(normalizeModelId('DeepSeek-V3.9')).toEqual({ provider: 'samba', family: 'deepseek-v3' });
  });
});
