import { describe, it, expect } from 'vitest';
import { models, rates, PROVIDER, BASE_URL } from './index.js';
import { modelLabel, normalizeModelId } from '../index.js';

describe('@verevoir/llm/mistral — exported model table', () => {
  it('reports the mistral provider id + OpenAI-compatible base URL', () => {
    expect(PROVIDER).toBe('mistral');
    expect(BASE_URL).toBe('https://api.mistral.ai/v1');
  });

  it('maps classes to model ids (extraction = small; drafting falls up to large)', () => {
    expect(models.reasoning).toBe('mistral-large-latest');
    expect(models.extraction).toBe('mistral-small-latest');
    expect(models.drafting).toBe('mistral-large-latest');
  });

  it('exposes a rate tuple for every model in the class table', () => {
    for (const id of Object.values(models)) {
      expect(rates[id]).toBeDefined();
      expect(rates[id]).toHaveLength(2);
    }
  });

  it('registers family identity + labels (decisions key on provider/family)', () => {
    expect(normalizeModelId('mistral-large-latest')).toEqual({
      provider: 'mistral',
      family: 'large',
    });
    expect(modelLabel('mistral-small-latest')).toBe('Mistral Small');
  });
});
