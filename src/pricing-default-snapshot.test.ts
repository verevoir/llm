import { describe, it, expect, vi } from 'vitest';

// src/pricing.test.ts exercises the REAL bundled default snapshot, which
// is now populated with real LiteLLM data. This file instead mocks
// './pricing-snapshot.js' with a small, fully-controlled payload to
// exercise the fallback BEHAVIOUR deterministically — used before the
// first fetch, kept on fetch failure, replaced on fetch success, and the
// 10x breaker applying to it — independent of whatever the real bundled
// data happens to contain.
const { MOCK_SNAPSHOT } = vi.hoisted(() => ({
  MOCK_SNAPSHOT: {
    asOf: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://example.test/model_prices_and_context_window.json',
    sha256: 'deadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00ddeadbeefcafef00d',
    payload: {
      'snapshot-model': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000005,
        litellm_provider: 'anthropic',
      },
    },
  },
}));

vi.mock('./pricing-snapshot.js', () => ({ PRICING_SNAPSHOT: MOCK_SNAPSHOT }));

import { createPriceBook, type FetchResponseLike } from './pricing.js';

function okResponse(body: unknown): FetchResponseLike {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeLogger() {
  const warn = vi.fn<(message: string, meta?: Record<string, unknown>) => void>();
  return { warn };
}

const LIVE_PAYLOAD = {
  'live-model': {
    input_cost_per_token: 0.00001,
    output_cost_per_token: 0.00002,
    litellm_provider: 'openai',
  },
};

describe('createPriceBook — bundled default snapshot (populated, mocked)', () => {
  it('is used before any fetch has succeeded', () => {
    const book = createPriceBook({ fetch: vi.fn() });
    expect(book.size).toBe(1);
    expect(book.source).toEqual({
      kind: 'snapshot',
      asOf: MOCK_SNAPSHOT.asOf,
      sha256: MOCK_SNAPSHOT.sha256,
      url: MOCK_SNAPSHOT.sourceUrl,
    });
    const r = book.costOf({
      provider: 'anthropic',
      model: 'snapshot-model',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 100,
    });
    expect(r).toEqual({ usdMicros: 9050, complete: true, source: book.source });
  });

  it('stays in effect when the first fetch fails', async () => {
    const book = createPriceBook({ fetch: vi.fn(async () => Promise.reject(new Error('down'))) });
    book.start();
    await flush();
    expect(book.size).toBe(1);
    expect(book.source?.kind).toBe('snapshot');
    book.stop();
  });

  it('is replaced by the live table once a fetch succeeds', async () => {
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(LIVE_PAYLOAD)) });
    book.start();
    await flush();
    expect(book.source?.kind).toBe('fetched');
    expect(book.size).toBe(1);
    expect(
      book.costOf({ provider: 'x', model: 'snapshot-model', inputTokens: 1, outputTokens: 1 })
    ).toEqual({ unpriced: expect.any(String) });
    expect(
      book.costOf({ provider: 'openai', model: 'live-model', inputTokens: 1, outputTokens: 1 })
    ).toHaveProperty('usdMicros');
    book.stop();
  });

  // Policy: the breaker compares LIVE → LIVE only, never snapshot → first
  // live table. A stale snapshot can legitimately be 10x off by its
  // asOf date; rejecting the first live fetch against it would pin the
  // book to that stale snapshot forever. So this transition is accepted
  // once the payload parses and validates — with a WARNING logged for
  // each price that moved more than 10x, not a rejection.
  it('accepts a first live fetch that moves a snapshot price more than 10x, logging a warning rather than rejecting', async () => {
    const logger = fakeLogger();
    const moved = {
      'snapshot-model': {
        input_cost_per_token: 0.000003 * 50,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000005,
        litellm_provider: 'anthropic',
      },
    };
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(moved)), logger });
    book.start();
    await flush();
    expect(book.source?.kind).toBe('fetched');
    const r = book.costOf({
      provider: 'anthropic',
      model: 'snapshot-model',
      inputTokens: 1,
      outputTokens: 0,
    });
    expect(r).toEqual({
      usdMicros: Math.round(0.000003 * 50 * 1_000_000),
      complete: true,
      source: book.source,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('moving more than 10x since the snapshot'),
      expect.anything()
    );
    book.stop();
  });

  it('the 10x breaker allows a first live fetch that moves a snapshot price by less than 10x', async () => {
    const moved = {
      'snapshot-model': {
        input_cost_per_token: 0.000003 * 2,
        output_cost_per_token: 0.000012,
        cache_read_input_token_cost: 0.0000005,
        litellm_provider: 'anthropic',
      },
    };
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(moved)) });
    book.start();
    await flush();
    expect(book.source?.kind).toBe('fetched');
    book.stop();
  });
});

describe('createPriceBook — source kinds and fields', () => {
  it('a fetched source carries url + fetchedAt + sha256, never asOf', async () => {
    const book = createPriceBook({
      fetch: vi.fn(async () => okResponse(LIVE_PAYLOAD)),
      now: () => 1_700_000_000_000,
    });
    book.start();
    await flush();
    expect(book.source).toEqual({
      kind: 'fetched',
      url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
      fetchedAt: 1_700_000_000_000,
      sha256: expect.any(String),
    });
    book.stop();
  });

  it('the bundled-default-snapshot source carries asOf + url + sha256, never fetchedAt', () => {
    const book = createPriceBook({ fetch: vi.fn() });
    expect(book.source).toEqual({
      kind: 'snapshot',
      asOf: MOCK_SNAPSHOT.asOf,
      url: MOCK_SNAPSHOT.sourceUrl,
      sha256: MOCK_SNAPSHOT.sha256,
    });
  });

  it('an explicitly-injected snapshot source carries only sha256 — no asOf, no url, no fetchedAt', () => {
    const book = createPriceBook({
      fetch: vi.fn(),
      snapshot: { m1: { inputCostPerToken: 0.001, outputCostPerToken: 0.002 } },
    });
    expect(book.source).toEqual({ kind: 'snapshot', sha256: expect.any(String) });
  });
});
