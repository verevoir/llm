import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readReportedCost } from './cost.js';

describe('readReportedCost', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0.5, 0, 12.75])('relays the finite number %s as-is', (n) => {
    expect(readReportedCost(n)).toEqual({ costUsdReported: n });
  });

  it('yields nothing, and no debug note, when the value is missing', () => {
    expect(readReportedCost(undefined)).toEqual({});
    expect(console.debug).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('treats %s as invalid, never as a cost', (_label, bad) => {
    const r = readReportedCost(bad);
    expect(r.costUsdReported).toBeUndefined();
    expect(r.invalidType).toBe('number');
  });

  it.each([
    ['a string', '0.5', 'string'],
    ['null', null, 'null'],
    ['an object', {}, 'object'],
    ['an array', [], 'array'],
    ['a boolean', false, 'boolean'],
  ])('names the type of %s', (_label, bad, type) => {
    const r = readReportedCost(bad);
    expect(r.costUsdReported).toBeUndefined();
    expect(r.invalidType).toBe(type);
  });

  it('writes a debug note naming the type, never the value', () => {
    readReportedCost('secret-looking-text');
    expect(console.debug).toHaveBeenCalledTimes(1);
    const message = String((console.debug as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(message).toContain('string');
    expect(message).not.toContain('secret-looking-text');
  });
});
