import { describe, it, expect, vi } from 'vitest';

// Mock the openai SDK so usage tests run with canned responses (no network).
const { chatCreateMock } = vi.hoisted(() => ({ chatCreateMock: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: chatCreateMock } };
    constructor(_opts: unknown) {}
  },
}));

import { createOpenAICompatAdapter } from './openai-compat.js';
import { normalizeModelId, modelLabel, estimateCostUSD, type ModelCatalogEntry } from './index.js';

describe('createOpenAICompatAdapter', () => {
  const catalog: ModelCatalogEntry[] = [
    {
      provider: 'testco',
      family: 'big',
      modelClass: 'reasoning',
      currentId: 'testco-big-1',
      rates: [1, 2],
      label: 'Big',
      prefixes: ['testco-big'],
    },
    {
      provider: 'testco',
      family: 'small',
      modelClass: 'extraction',
      currentId: 'testco-small-1',
      rates: [0.1, 0.2],
      label: 'Small',
      prefixes: ['testco-small'],
    },
  ];
  const a = createOpenAICompatAdapter({
    provider: 'testco',
    baseURL: 'https://x/v1',
    apiKeyEnv: 'TESTCO_KEY',
    catalog,
  });

  it('exposes the provider id, base URL, and a chat fn', () => {
    expect(a.PROVIDER).toBe('testco');
    expect(a.BASE_URL).toBe('https://x/v1');
    expect(typeof a.chat).toBe('function');
  });

  it('derives the class map with the tier ladder — drafting falls up to reasoning', () => {
    expect(a.models.reasoning).toBe('testco-big-1');
    expect(a.models.extraction).toBe('testco-small-1');
    expect(a.models.drafting).toBe('testco-big-1');
  });

  it('derives rates keyed by the current id', () => {
    expect(a.rates['testco-big-1']).toEqual([1, 2]);
  });

  it('registers the catalogue so decisions key on provider/family', () => {
    expect(normalizeModelId('testco-big-1')).toEqual({ provider: 'testco', family: 'big' });
    // a new, unseen version still normalises via the prefix
    expect(normalizeModelId('testco-big-2-20990101')).toEqual({
      provider: 'testco',
      family: 'big',
    });
    expect(modelLabel('testco-big-1')).toBe('Big');
    // family pricing covers a drifted id with no explicit rates table
    expect(estimateCostUSD({ 'testco-big-9': { in: 1_000_000, out: 1_000_000 } }, {})).toBeCloseTo(
      3,
      5
    );
  });

  it('throws when the catalogue declares no modelClass anywhere', () => {
    expect(() =>
      createOpenAICompatAdapter({
        provider: 'p',
        baseURL: 'u',
        apiKeyEnv: 'K',
        catalog: [{ provider: 'p', family: 'f', currentId: 'p-x', rates: [1, 1], label: 'X' }],
      })
    ).toThrow(/modelClass/);
  });
});

// ── Cached-token usage (STDIO-487 regression) ────────────────────────────────
// prompt_tokens is the TOTAL including the cached subset.  inputTokens must be
// the non-cached portion only; cacheReadInputTokens carries the cached count.
// Double-counting both was the bug — these tests would have caught it.

describe('cached-token usage — no double-count (STDIO-487)', () => {
  const usageCatalog: ModelCatalogEntry[] = [
    {
      provider: 'cachetest',
      family: 'm',
      modelClass: 'reasoning',
      currentId: 'cachetest-m',
      rates: [1, 1],
      label: 'M',
    },
  ];
  const adapter = createOpenAICompatAdapter({
    provider: 'cachetest',
    baseURL: 'https://x/v1',
    apiKeyEnv: 'CACHETEST_KEY',
    catalog: usageCatalog,
  });

  it('chat: prompt_tokens_details.cached_tokens is excluded from inputTokens', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    let captured: import('./index.js').TokenUsage | undefined;
    await adapter.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
      onUsage: async (u) => {
        captured = u;
      },
    });
    expect(captured?.inputTokens).toBe(200); // 1000 - 800
    expect(captured?.cacheReadInputTokens).toBe(800); // unchanged
  });

  it('chat: DeepSeek prompt_cache_hit_tokens is excluded from inputTokens', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 800,
      },
    });
    let captured: import('./index.js').TokenUsage | undefined;
    await adapter.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
      onUsage: async (u) => {
        captured = u;
      },
    });
    expect(captured?.inputTokens).toBe(200);
    expect(captured?.cacheReadInputTokens).toBe(800);
  });

  it('chat: no cache fields — inputTokens equals prompt_tokens', async () => {
    chatCreateMock.mockResolvedValueOnce({
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 500, completion_tokens: 20 },
    });
    let captured: import('./index.js').TokenUsage | undefined;
    await adapter.chat({
      systemPrompt: 's',
      turns: [{ role: 'user', content: 'go' }],
      apiKey: 'k',
      onUsage: async (u) => {
        captured = u;
      },
    });
    expect(captured?.inputTokens).toBe(500);
    expect(captured?.cacheReadInputTokens).toBe(0);
  });
});
