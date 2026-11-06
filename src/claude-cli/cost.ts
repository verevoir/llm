/**
 * @verevoir/llm/claude-cli — reading the CLI's own reported cost.
 *
 * Kept in its own module (not exported from the package entry) so the
 * finite-number guard can be unit-tested directly: JSON cannot carry
 * `NaN`, and `Infinity` only arrives as an overflowing literal like
 * `1e999`, so a fake CLI payload alone cannot exercise every branch.
 */

/** What {@link readReportedCost} found. At most one field is set. */
export interface ReportedCost {
  /** A finite number the CLI reported. Absent otherwise — never 0, never NaN. */
  costUsdReported?: number;
  /**
   * Set when the CLI sent a `total_cost_usd` that is NOT a finite number
   * (a string, null, object, boolean, NaN or ±Infinity): the value's type,
   * so a malformed field is distinguishable from a missing one. The value
   * itself is never recorded. Absent when the field was missing or valid.
   */
  invalidType?: string;
}

/** The type name recorded for a malformed value (`null` and arrays are
 * named, since `typeof` calls both `object`). */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Read the CLI's `total_cost_usd`. A missing value (`undefined`) yields
 * nothing; a finite number is relayed as-is; anything else yields only
 * `invalidType` and a debug note, and the cost stays absent.
 */
export function readReportedCost(value: unknown): ReportedCost {
  if (value === undefined) return {};
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { costUsdReported: value };
  }
  const invalidType = typeName(value);
  console.debug(
    `@verevoir/llm/claude-cli: ignoring a malformed total_cost_usd (type: ${invalidType}); ` +
      'costUsdReported is left absent.'
  );
  return { invalidType };
}
