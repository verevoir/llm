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

/** What {@link readReportedCost} found. At most one field is set. */
export interface ReportedCost {
  /** A finite, non-negative number the CLI reported. Absent otherwise — never 0, never NaN. */
  costUsdReported?: number;
  /**
   * Set when the CLI sent a `total_cost_usd` that is NOT a finite,
   * non-negative number (a string, null, array, object, boolean, NaN,
   * ±Infinity or a negative number): the value's type, so a malformed
   * field is distinguishable from a missing one. The value itself is
   * never recorded. Absent when the field was missing or valid.
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
 * nothing; a finite number >= 0 is relayed as-is; anything else yields
 * only `invalidType`, and the cost stays absent.
 */
export function readReportedCost(value: unknown): ReportedCost {
  if (value === undefined) return {};
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return { costUsdReported: value };
  }
  return { invalidType: typeName(value) };
}
