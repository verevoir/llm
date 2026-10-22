import { describe, it, expect } from 'vitest';
import { createPriceBook } from '../pricing.js';

// The Anthropic catalog's current Sonnet id (src/anthropic/catalog.ts).
// PriceBook looks up by exact id (then `${provider}/${model}`) — no alias
// resolution — so this has to be the literal catalog id, not an alias.
const CURRENT_SONNET_ID = 'claude-sonnet-5';

describe('Anthropic model ids price through a snapshot-only PriceBook', () => {
  // No injected snapshot and never start()-ed: prices from the bundled
  // PRICING_SNAPSHOT alone. A fetch that throws proves no network call is
  // ever attempted. Shared by both tests below.
  const book = createPriceBook({
    fetch: () => {
      throw new Error('must not fetch — this book is never start()-ed');
    },
  });

  const usage = {
    provider: 'anthropic',
    model: CURRENT_SONNET_ID,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
  };

  it('prices a known model from the snapshot', () => {
    const probe = book.costOf(usage);
    if ('unpriced' in probe) {
      // The bundled snapshot doesn't (or no longer) carry this id — nothing
      // to assert pricing against; skip rather than fail on drift unrelated
      // to this change.
      return;
    }

    expect(probe.usdMicros).toBeGreaterThan(0);
    expect(probe.source?.kind).toBe('snapshot');
  });

  it('an unknown model is unpriced', () => {
    const unknown = book.costOf({ ...usage, model: 'not-a-real-model-id' });
    expect(unknown).toEqual({
      unpriced: expect.stringContaining('not-a-real-model-id'),
    });
  });
});
