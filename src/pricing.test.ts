import { describe, it, expect, vi } from 'vitest';
import { createPriceBook, type FetchResponseLike } from './pricing.js';

function okResponse(body: unknown): FetchResponseLike {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function badStatusResponse(status: number): FetchResponseLike {
  return { ok: false, status, text: async () => '' };
}

function textResponse(text: string): FetchResponseLike {
  return { ok: true, status: 200, text: async () => text };
}

/** Flush the microtask queue past every `await` in `refresh()`, without
 * depending on how many there are. Real timers — fake-timer tests use
 * `vi.advanceTimersByTimeAsync` instead. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeLogger() {
  const warn = vi.fn<(message: string, meta?: Record<string, unknown>) => void>();
  return { warn };
}

const CLAUDE_OPUS = {
  input_cost_per_token: 0.000015,
  output_cost_per_token: 0.000075,
  cache_creation_input_token_cost: 0.00001875,
  cache_creation_input_token_cost_above_1hr: 0.00003,
  cache_read_input_token_cost: 0.0000015,
  litellm_provider: 'anthropic',
};

const GPT5 = {
  input_cost_per_token: 0.0000025,
  output_cost_per_token: 0.00001,
  litellm_provider: 'openai',
};

const RAW = {
  'claude-opus-4-7': CLAUDE_OPUS,
  'gpt-5': GPT5,
  'mistral/mistral-large-latest': {
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000006,
    litellm_provider: 'mistral',
  },
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'sample' },
};

describe('createPriceBook — construction never fetches', () => {
  it('does not call fetch until start() is called', () => {
    const fetchMock = vi.fn(async () => okResponse(RAW));
    createPriceBook({ fetch: fetchMock });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createPriceBook — parsing', () => {
  it('parses every documented field and skips sample_spec', async () => {
    const fetchMock = vi.fn(async () => okResponse(RAW));
    const book = createPriceBook({ fetch: fetchMock, logger: fakeLogger() });
    book.start();
    await flush();
    expect(book.size).toBe(3);
    expect(book.source?.kind).toBe('fetched');
    book.stop();
  });

  it('skips an invalid entry (negative price) without rejecting the rest of the payload', async () => {
    const logger = fakeLogger();
    const bad = { ...RAW, 'broken-model': { input_cost_per_token: -1, output_cost_per_token: 1 } };
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(bad)), logger });
    book.start();
    await flush();
    expect(book.size).toBe(3);
    expect(
      book.costOf({ provider: 'x', model: 'broken-model', inputTokens: 1, outputTokens: 1 })
    ).toHaveProperty('unpriced');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips an entry with a non-finite price', async () => {
    const bad = {
      'infinite-model': { input_cost_per_token: Infinity, output_cost_per_token: 0.001 },
    };
    // Explicit empty snapshot — otherwise this would fall back to the now-
    // populated bundled default and not test what its name says.
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(bad)), snapshot: {} });
    book.start();
    await flush();
    expect(book.size).toBe(0);
  });

  it('rejects a payload that is not a JSON object, keeping the last good (empty) table', async () => {
    const logger = fakeLogger();
    // Explicit empty snapshot — otherwise this would fall back to the now-
    // populated bundled default and not test what its name says.
    const book = createPriceBook({
      fetch: vi.fn(async () => textResponse('[]')),
      logger,
      snapshot: {},
    });
    book.start();
    await flush();
    expect(book.size).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createPriceBook — fetch failure keeps the last good table', () => {
  it('keeps the previous table when a later fetch rejects', async () => {
    const logger = fakeLogger();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(RAW));
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const book = createPriceBook({ fetch: fetchMock, logger });
    book.start();
    await flush();
    expect(book.size).toBe(3);
    book.start(); // manually trigger a second refresh cycle
    await flush();
    expect(book.size).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('fetch threw'),
      expect.anything()
    );
    book.stop();
  });

  it('keeps the previous table when a later fetch returns a non-OK status', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(RAW));
    fetchMock.mockResolvedValueOnce(badStatusResponse(503));
    const book = createPriceBook({ fetch: fetchMock });
    book.start();
    await flush();
    book.start();
    await flush();
    expect(book.size).toBe(3);
    book.stop();
  });

  it('keeps the previous table when a later fetch returns invalid JSON', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(RAW));
    fetchMock.mockResolvedValueOnce(textResponse('{not json'));
    const book = createPriceBook({ fetch: fetchMock });
    book.start();
    await flush();
    book.start();
    await flush();
    expect(book.size).toBe(3);
    book.stop();
  });
});

describe('createPriceBook — 10x rejection', () => {
  it('rejects a refresh where a price moved more than 10x, keeping the last good table', async () => {
    const logger = fakeLogger();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(RAW));
    const moved = {
      ...RAW,
      'claude-opus-4-7': {
        ...CLAUDE_OPUS,
        input_cost_per_token: CLAUDE_OPUS.input_cost_per_token * 50,
      },
    };
    fetchMock.mockResolvedValueOnce(okResponse(moved));
    const book = createPriceBook({ fetch: fetchMock, logger });
    book.start();
    await flush();
    const before = book.costOf({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    book.start();
    await flush();
    const after = book.costOf({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(after).toEqual(before);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('moved more than 10x'),
      expect.anything()
    );
    book.stop();
  });

  it('allows a refresh that moves a price by less than 10x', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(okResponse(RAW));
    const moved = {
      ...RAW,
      'claude-opus-4-7': {
        ...CLAUDE_OPUS,
        input_cost_per_token: CLAUDE_OPUS.input_cost_per_token * 2,
      },
    };
    fetchMock.mockResolvedValueOnce(okResponse(moved));
    const book = createPriceBook({ fetch: fetchMock });
    book.start();
    await flush();
    book.start();
    await flush();
    const r = book.costOf({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    const movedRate = CLAUDE_OPUS.input_cost_per_token * 2;
    expect(r).toMatchObject({ usdMicros: Math.round(1_000_000 * movedRate * 1_000_000) });
  });
});

describe('createPriceBook — lookup order', () => {
  it('matches an exact model id over a provider/model composite', async () => {
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(RAW)) });
    book.start();
    await flush();
    const r = book.costOf({
      provider: 'anything',
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(r).toHaveProperty('usdMicros');
  });

  it('falls back to provider/model when there is no exact match', async () => {
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(RAW)) });
    book.start();
    await flush();
    const r = book.costOf({
      provider: 'mistral',
      model: 'mistral-large-latest',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(r).toHaveProperty('usdMicros');
  });

  it('reports unpriced — never 0 — for a model matching neither form', async () => {
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(RAW)) });
    book.start();
    await flush();
    const r = book.costOf({
      provider: 'nope',
      model: 'unknown-model-xyz',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(r).toEqual({ unpriced: expect.stringContaining('unknown-model-xyz') });
  });
});

describe('createPriceBook — costOf branches', () => {
  async function bookWithRaw() {
    const book = createPriceBook({ fetch: vi.fn(async () => okResponse(RAW)) });
    book.start();
    await flush();
    return book;
  }

  it('prices input, output, cache-read, and both cache-write TTLs when all are known — complete', async () => {
    const book = await bookWithRaw();
    const r = book.costOf({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
      cacheCreationEphemeral5mInputTokens: 300,
      cacheCreationEphemeral1hInputTokens: 100,
    });
    expect(r).toEqual({ usdMicros: 61425, complete: true, source: book.source });
  });

  it('prices input, output, and cache-read with no cache-write — complete', async () => {
    const book = await bookWithRaw();
    const r = book.costOf({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 200,
    });
    expect(r).toEqual({ usdMicros: 52800, complete: true, source: book.source });
  });

  it('prices an unsplit total cache-write at the 5m rate and marks the result incomplete', async () => {
    const book = await bookWithRaw();
    const r = book.costOf({
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 300,
    });
    expect(r).toEqual({ usdMicros: 58125, complete: false, source: book.source });
  });

  it('marks the result incomplete when 1h-write tokens are reported but the model has no 1h rate', async () => {
    const book = await bookWithRaw();
    const r = book.costOf({
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationEphemeral1hInputTokens: 10,
    });
    expect(r).toEqual({ usdMicros: 750, complete: false, source: book.source });
  });

  it('marks the result incomplete when cache-read tokens are reported but the model has no cache-read rate', async () => {
    const book = await bookWithRaw();
    const r = book.costOf({
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 20,
    });
    expect(r).toEqual({ usdMicros: 750, complete: false, source: book.source });
  });

  it('returns unpriced, never usdMicros: 0, for a model with no entry at all', async () => {
    const book = await bookWithRaw();
    const r = book.costOf({
      provider: 'nobody',
      model: 'nothing',
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(r).toEqual({ unpriced: expect.any(String) });
  });
});

describe('createPriceBook — snapshot', () => {
  it('uses an injected snapshot before any fetch, and never calls fetch on its own', () => {
    const fetchMock = vi.fn();
    const book = createPriceBook({
      fetch: fetchMock,
      snapshot: { m1: { inputCostPerToken: 0.001, outputCostPerToken: 0.002 } },
    });
    expect(book.size).toBe(1);
    expect(book.source?.kind).toBe('snapshot');
    const r = book.costOf({ provider: 'x', model: 'm1', inputTokens: 10, outputTokens: 10 });
    expect(r).toEqual({
      usdMicros: 30000,
      complete: true,
      source: { kind: 'snapshot', sha256: expect.any(String) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The bundled default (src/pricing-snapshot.ts) is populated with real
  // LiteLLM data (asOf 2026-10-22T12:59:18Z, raw upstream sha256
  // 91da1a98…). This test exercises the REAL, unmocked module exactly as
  // it ships: falling back to it (because no explicit snapshot and no
  // fetch were supplied) prices a known model straight from that real
  // data. See pricing-default-snapshot.test.ts for the same fallback
  // exercised against a MOCKED snapshot instead.
  it('falls back to the bundled default snapshot and prices a known model — claude-sonnet-4-5 — from the real, unmocked data', () => {
    const book = createPriceBook({ fetch: vi.fn() });
    expect(book.source?.kind).toBe('snapshot');
    expect(book.source?.sha256).toMatch(/^91da1a98/);
    const r = book.costOf({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(r).toEqual({
      usdMicros: 18_000_000,
      complete: true,
      source: book.source,
    });
  });
});

describe('createPriceBook — timer start/stop', () => {
  it('fetches immediately on start, again after refreshMs, and never again after stop', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => okResponse(RAW));
      const book = createPriceBook({ fetch: fetchMock, refreshMs: 1000 });
      book.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      book.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calling start twice does not schedule a second periodic timer', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => okResponse(RAW));
      const book = createPriceBook({ fetch: fetchMock, refreshMs: 1000 });
      book.start();
      await vi.advanceTimersByTimeAsync(0);
      book.start();
      await vi.advanceTimersByTimeAsync(0);
      // Two manual start() calls so far: two fetches, no timer fired yet.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      // Exactly one timer firing — not two — proves only one interval exists.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      book.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createPriceBook — fetch timeout', () => {
  it('treats a timed-out fetch as a failed refresh — keeps the last good table and source, and warns like other failures', async () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const neverResolvingFetch = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<FetchResponseLike>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('The operation was aborted'))
            );
          })
      );
      const book = createPriceBook({ fetch: neverResolvingFetch, fetchTimeoutMs: 5000, logger });
      const sourceBefore = book.source;
      const sizeBefore = book.size;

      book.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);

      expect(neverResolvingFetch).toHaveBeenCalledTimes(1);
      expect(book.size).toBe(sizeBefore);
      expect(book.source).toEqual(sourceBefore);
      expect(logger.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createPriceBook — overlapping refresh', () => {
  it('does not start a second fetch while one is still in flight — two interval ticks during a slow fetch give exactly one call', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch: ((value: FetchResponseLike) => void) | undefined;
      const slowFetch = vi.fn(
        () =>
          new Promise<FetchResponseLike>((resolve) => {
            resolveFetch = resolve;
          })
      );
      const book = createPriceBook({ fetch: slowFetch, refreshMs: 1000 });

      book.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(slowFetch).toHaveBeenCalledTimes(1);

      // Two interval ticks fire while the first fetch is still pending.
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(slowFetch).toHaveBeenCalledTimes(1);

      resolveFetch?.(okResponse(RAW));
      await vi.advanceTimersByTimeAsync(0);
      book.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
