/**
 * @verevoir/llm/claude-cli — reading the CLI's own reported cost.
 *
 * Kept in its own module (not exported from the package entry) so the
 * guard can be unit-tested directly: JSON cannot carry `NaN`, and
 * `Infinity` only arrives as an overflowing literal like `1e999`, so a
 * fake CLI payload alone cannot exercise every branch.
 *
 * Deliberately silent: a malformed value is recorded on the returned
 * object (and from there on `TokenUsage` and the span), never written to
 * stdout/stderr. Library code that logs to stdout can corrupt a
 * stdio-protocol consumer such as an MCP server.
 */

import type { CostInvalidKind } from '../index.js';

/** What {@link readReportedCost} found. At most one field is set. */
export interface ReportedCost {
  /** A finite, non-negative number the CLI reported. Absent otherwise (a missing or malformed value is never defaulted to 0 or NaN; a reported 0 is relayed). */
  costUsdReported?: number;
  /**
   * Set when the CLI sent a `total_cost_usd` that is NOT a finite,
   * non-negative number, so a malformed field is distinguishable from a
   * missing one. It names the KIND of malformation, never the value:
   * `'negative'` (a number below zero), `'non-finite'` (NaN or ±Infinity),
   * or, for a non-number, its type (`'string'`, `'null'`, `'array'`,
   * `'object'`, `'boolean'`). Absent when the field was missing or valid.
   */
  invalidType?: CostInvalidKind;
}

/** The type name recorded for a malformed value (`null` and arrays are
 * named, since `typeof` calls both `object`). */
function typeName(value: unknown): CostInvalidKind {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  // `number` and `undefined` never reach here (handled by the caller).
  return typeof value as Exclude<CostInvalidKind, 'negative' | 'non-finite' | 'null' | 'array'>;
}

/**
 * Read the CLI's `total_cost_usd`. A missing value (`undefined`) yields
 * nothing; a finite number >= 0 is relayed as-is; anything else yields
 * only `invalidType`, and the cost stays absent.
 *
 * `-0` is a zero cost, not a negative one (`-0 < 0` is false), so it is
 * accepted, but it is normalised to `0`: the sign of zero carries no
 * meaning for a cost, and a `-0` would print as `-0` and fail an
 * `Object.is` comparison against `0` in a consumer.
 *
 * A number is split into `'negative'` and `'non-finite'` (not both
 * `'number'`) so a consumer can tell them apart: a negative is a finite
 * number below zero, a non-finite value is NaN or ±Infinity (in JSON
 * only an overflowing literal such as `1e999` can produce it). Why the
 * CLI would send either is not established here.
 */
export function readReportedCost(value: unknown): ReportedCost {
  if (value === undefined) return {};
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { invalidType: 'non-finite' };
    if (value < 0) return { invalidType: 'negative' };
    return { costUsdReported: value === 0 ? 0 : value };
  }
  return { invalidType: typeName(value) };
}
