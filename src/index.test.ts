import { describe, it, expect, beforeEach } from 'vitest';
import {
  estimateCostUSD,
  formatTokensCompact,
  modelLabel,
  parseUsage,
  registerModelCatalog,
  registerModelLabels,
  normalizeModelId,
  catalogEntryFor,
  uncoveredModels,
  sumUsages,
  totalTokens,
  type PerModelUsage,
  type RatesTable,
} from './index.js';

describe('parseUsage', () => {
  it('returns empty for an empty string', () => {
    expect(parseUsage('')).toEqual({});
  });

  it('parses a well-formed JSON usage', () => {
    const raw = '{"claude-opus-4-7":{"in":100,"out":50}}';
    expect(parseUsage(raw)).toEqual({
      'claude-opus-4-7': { in: 100, out: 50 },
    });
  });

  it('returns empty for malformed JSON', () => {
    expect(parseUsage('not json')).toEqual({});
  });

  it('returns empty for JSON that is not an object', () => {
    expect(parseUsage('[1,2,3]')).toEqual({});
    expect(parseUsage('42')).toEqual({});
  });
});

describe('sumUsages', () => {
  it('returns an empty rollup for no inputs', () => {
    expect(sumUsages([])).toEqual({});
  });

  it('merges multiple rollups, summing per-model in/out/cache', () => {
    const a: PerModelUsage = {
      'claude-opus-4-7': { in: 100, out: 50, cacheRead: 1000, cacheWrite: 200 },
    };
    const b: PerModelUsage = {
      'claude-opus-4-7': { in: 200, out: 75 },
      'claude-haiku-4-5-20251001': { in: 10, out: 5 },
    };
    // Missing cache fields coalesce to 0; output carries all four counters.
    expect(sumUsages([a, b])).toEqual({
      'claude-opus-4-7': { in: 300, out: 125, cacheRead: 1000, cacheWrite: 200 },
      'claude-haiku-4-5-20251001': { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 },
    });
  });
});

describe('totalTokens', () => {
  it('sums input + output across every model', () => {
    const usage: PerModelUsage = {
      'claude-opus-4-7': { in: 100, out: 50 },
      'claude-haiku-4-5-20251001': { in: 30, out: 20 },
    };
    expect(totalTokens(usage)).toBe(200);
  });

  it('counts cache read + write at face value (budget guard)', () => {
    const usage: PerModelUsage = {
      'claude-opus-4-7': { in: 100, out: 50, cacheRead: 1000, cacheWrite: 200 },
    };
    expect(totalTokens(usage)).toBe(1350);
  });
});

describe('formatTokensCompact', () => {
  it('returns the raw number under 1000', () => {
    expect(formatTokensCompact(0)).toBe('0');
    expect(formatTokensCompact(999)).toBe('999');
  });

  it('formats thousands with one decimal, stripped if 0', () => {
    expect(formatTokensCompact(1000)).toBe('1k');
    expect(formatTokensCompact(1500)).toBe('1.5k');
    expect(formatTokensCompact(12_345)).toBe('12.3k');
    expect(formatTokensCompact(999_999)).toBe('1000k');
  });

  it('formats millions', () => {
    expect(formatTokensCompact(1_000_000)).toBe('1M');
    expect(formatTokensCompact(2_300_000)).toBe('2.3M');
  });
});

describe('estimateCostUSD', () => {
  const rates: RatesTable = {
    'claude-opus-4-7': [15, 75],
    'claude-haiku-4-5-20251001': [1, 5],
  };

  it('returns 0 for an empty rollup', () => {
    expect(estimateCostUSD({}, rates)).toBe(0);
  });

  it('computes cost from per-million rates', () => {
    // 1M input + 1M output Opus = 15 + 75 = 90 USD
    const usage: PerModelUsage = {
      'claude-opus-4-7': { in: 1_000_000, out: 1_000_000 },
    };
    expect(estimateCostUSD(usage, rates)).toBeCloseTo(90, 5);
  });

  it('sums across models', () => {
    // Opus: 1M in × 15 + 1M out × 75 = 90
    // Haiku: 1M in × 1 + 1M out × 5 = 6
    // Total: 96
    const usage: PerModelUsage = {
      'claude-opus-4-7': { in: 1_000_000, out: 1_000_000 },
      'claude-haiku-4-5-20251001': { in: 1_000_000, out: 1_000_000 },
    };
    expect(estimateCostUSD(usage, rates)).toBeCloseTo(96, 5);
  });

  it('treats unknown models as 0 cost (caller checks coverage)', () => {
    const usage: PerModelUsage = {
      'gemini-pro': { in: 1_000_000, out: 1_000_000 },
    };
    expect(estimateCostUSD(usage, rates)).toBe(0);
  });

  it('prices an entry without cache fields exactly as before', () => {
    // Back-compat: old persisted rollups have no cacheRead/cacheWrite.
    const usage: PerModelUsage = {
      'claude-opus-4-7': { in: 1_000_000, out: 1_000_000 },
    };
    expect(estimateCostUSD(usage, rates)).toBeCloseTo(90, 5);
  });

  it('defaults cache reads to 0.1× and cache writes to 1.25× of input', () => {
    // Opus input rate 15/Mtok → cacheRead 1.5, cacheWrite 18.75 per Mtok.
    const usage: PerModelUsage = {
      'claude-opus-4-7': {
        in: 0,
        out: 0,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
      },
    };
    expect(estimateCostUSD(usage, rates)).toBeCloseTo(1.5 + 18.75, 5);
  });

  it('uses explicit cache rates from a four-element tuple when present', () => {
    const explicit: RatesTable = { 'some-model': [10, 20, 2, 13] };
    const usage: PerModelUsage = {
      'some-model': { in: 1_000_000, out: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
    };
    // 10 (in) + 0 (out) + 2 (cacheRead) + 13 (cacheWrite) = 25
    expect(estimateCostUSD(usage, explicit)).toBeCloseTo(25, 5);
  });
});

describe('modelLabel / registerModelLabels', () => {
  it('falls back to the bare model id when unregistered', () => {
    expect(modelLabel('unknown-model')).toBe('unknown-model');
  });

  it('returns the registered label when present', () => {
    registerModelLabels({ 'test-model': 'Test' });
    expect(modelLabel('test-model')).toBe('Test');
  });
});

// A self-contained family for the identity tests, so they don't depend on any
// adapter being imported. Provider id is namespaced to avoid colliding with a
// real adapter's catalog if one is ever registered in this file.
describe('model identity catalog — decisions key on provider/family', () => {
  // Per test, not in the describe body: the last case here re-registers this
  // same provider/family with different rates, and a describe body runs once,
  // so the pricing case saw 10+40 or 20+80 depending on order.
  beforeEach(() => {
    registerModelCatalog([
      {
        provider: 'test-co',
        family: 'big',
        modelClass: 'reasoning',
        currentId: 'testco-big-1-0',
        rates: [10, 40],
        label: 'Big',
        aliases: ['testco-big-0-9'],
        prefixes: ['testco-big-'],
      },
    ]);
  });

  it('normalises the current id, an alias, and a brand-new version (prefix) to the same family', () => {
    expect(normalizeModelId('testco-big-1-0')).toEqual({ provider: 'test-co', family: 'big' });
    expect(normalizeModelId('testco-big-0-9')).toEqual({ provider: 'test-co', family: 'big' });
    // a version the catalog has never seen still resolves forward via the prefix
    expect(normalizeModelId('testco-big-2-5-20990101')).toEqual({
      provider: 'test-co',
      family: 'big',
    });
  });

  it('returns null for an id no family claims', () => {
    expect(normalizeModelId('someone-else-model')).toBeNull();
    expect(catalogEntryFor('someone-else-model')).toBeNull();
  });

  it('prices an unseen version of a known family via the catalog (version drift no longer zeroes cost)', () => {
    const usage: PerModelUsage = { 'testco-big-2-5-20990101': { in: 1_000_000, out: 1_000_000 } };
    // rates table passed in does NOT list the drifted id; the family catalog covers it.
    expect(estimateCostUSD(usage, {})).toBeCloseTo(10 + 40, 5);
  });

  it('labels an unseen version of a known family by its family label', () => {
    expect(modelLabel('testco-big-2-5-20990101')).toBe('Big');
  });

  it('reports genuinely uncoverable models loudly, but not catalog-covered ones', () => {
    const usage: PerModelUsage = {
      'testco-big-2-5-20990101': { in: 1, out: 1 },
      'mystery-model': { in: 1, out: 1 },
    };
    expect(uncoveredModels(usage)).toEqual(['mystery-model']);
    // an explicit rates table can also cover a model the catalog doesn't know
    expect(uncoveredModels(usage, { 'mystery-model': [1, 1] })).toEqual([]);
  });

  it('re-registering a provider/family replaces rather than duplicates', () => {
    registerModelCatalog([
      {
        provider: 'test-co',
        family: 'big',
        modelClass: 'reasoning',
        currentId: 'testco-big-3-0',
        rates: [20, 80],
        label: 'Big',
        prefixes: ['testco-big-'],
      },
    ]);
    expect(catalogEntryFor('testco-big-3-0')?.currentId).toBe('testco-big-3-0');
    expect(catalogEntryFor('testco-big-1-0')).not.toBeNull(); // still normalises via prefix
  });
});
