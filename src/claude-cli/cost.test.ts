import { describe, it, expect, vi, afterEach } from 'vitest';
import { readReportedCost } from './cost.js';

describe('readReportedCost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0.5, 0, 12.75])('relays the finite non-negative number %s as-is', (n) => {
    expect(readReportedCost(n)).toEqual({ costUsdReported: n });
  });

  it('yields nothing when the value is missing', () => {
    expect(readReportedCost(undefined)).toEqual({});
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('gives no cost for %s', (_label, bad) => {
    expect(readReportedCost(bad).costUsdReported).toBeUndefined();
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('flags %s as non-finite', (_label, bad) => {
    expect(readReportedCost(bad).invalidType).toBe('non-finite');
  });

  it.each([-0.01, -1, -1e-9])('gives no cost for the negative number %s', (n) => {
    expect(readReportedCost(n).costUsdReported).toBeUndefined();
  });

  it.each([-0.01, -1, -1e-9])('flags the negative number %s as negative', (n) => {
    expect(readReportedCost(n).invalidType).toBe('negative');
  });

  it.each([
    ['a string', '0.5'],
    ['null', null],
    ['an object', {}],
    ['an array', []],
    ['a boolean', false],
  ])('gives no cost for %s', (_label, bad) => {
    expect(readReportedCost(bad).costUsdReported).toBeUndefined();
  });

  it.each([
    ['a string', '0.5', 'string'],
    ['null', null, 'null'],
    ['an object', {}, 'object'],
    ['an array', [], 'array'],
    ['a boolean', false, 'boolean'],
  ])('names the type of %s', (_label, bad, type) => {
    expect(readReportedCost(bad).invalidType).toBe(type);
  });

  it('never writes to the console, whatever the value', () => {
    const spies = (['debug', 'log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    readReportedCost('secret-looking-text');
    readReportedCost(-1);
    readReportedCost(NaN);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it('never carries the value itself in the result', () => {
    expect(JSON.stringify(readReportedCost('secret-looking-text'))).not.toContain(
      'secret-looking-text'
    );
  });
});
