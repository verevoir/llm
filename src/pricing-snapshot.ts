/**
 * @verevoir/llm — bundled fallback price snapshot.
 *
 * `createPriceBook` (see `src/pricing.ts`) uses this as its DEFAULT
 * fallback table — in effect before the first live fetch ever succeeds,
 * and again whenever every live fetch has failed — unless the caller
 * injects its own `PriceBookOptions.snapshot`. `payload` is a TRIMMED
 * LiteLLM `model_prices_and_context_window.json`: model key → only the
 * fields `src/pricing.ts`'s parser reads, in their original snake_case
 * shape, so the exact same parser that reads a live fetch's body reads
 * this too.
 *
 * Generated OUTSIDE the belt — the belt cannot reach the network — by a
 * one-off command (not yet written) that fetches the upstream file,
 * trims it, and overwrites this file's `asOf` / `sourceUrl` / `sha256` /
 * `payload`. Do not hand-edit prices into it.
 *
 * PLACEHOLDER: this file has not yet been regenerated with real data
 * (`asOf: 'unpopulated'`, `sha256: ''`, `payload: {}`). A price book
 * built from an empty payload prices nothing — every model is
 * `unpriced`, never `0` — which is exactly the pre-default-snapshot
 * behaviour for anyone running this before real data is populated.
 */

export interface PricingSnapshot {
  /** When this snapshot was generated — an ISO date once populated, or
   * the literal `'unpopulated'` for this placeholder. */
  asOf: string;
  /** Where `payload` was trimmed from. */
  sourceUrl: string;
  /** sha256 of the raw upstream JSON this snapshot was trimmed from —
   * `''` for this placeholder, since nothing was ever fetched. */
  sha256: string;
  /** Model key → only the fields `src/pricing.ts`'s parser reads
   * (`input_cost_per_token`, `output_cost_per_token`,
   * `cache_creation_input_token_cost`,
   * `cache_creation_input_token_cost_above_1hr`,
   * `cache_read_input_token_cost`, `litellm_provider`), untouched
   * snake_case — the same shape a live fetch's JSON body is in. */
  payload: Record<string, Record<string, unknown>>;
}

export const PRICING_SNAPSHOT: PricingSnapshot = {
  asOf: 'unpopulated',
  sourceUrl:
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  sha256: '',
  payload: {},
};
