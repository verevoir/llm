/**
 * @verevoir/llm — a price book for turning {@link UsageForPricing} into USD.
 *
 * Design: fetch LiteLLM's `model_prices_and_context_window.json` at
 * service start-up, refresh it roughly every 24h, and fall back to the
 * last good table (or a caller-injected static snapshot) when a refresh
 * fails or looks corrupt. This module makes **zero** network calls on
 * import, and makes none at all unless {@link PriceBook.start} is called
 * — the caller (v5) owns start-up. Nothing here does cost arithmetic
 * beyond per-call USD: there is no aggregation, no currency conversion,
 * no budget logic — that is out of scope for this PR.
 *
 * Source fields read from each LiteLLM entry (USD per token):
 * `input_cost_per_token`, `output_cost_per_token`,
 * `cache_creation_input_token_cost` (5-minute-TTL cache write),
 * `cache_creation_input_token_cost_above_1hr` (1-hour-TTL cache write),
 * `cache_read_input_token_cost`, `litellm_provider`. The top-level
 * `sample_spec` key is not a model and is always skipped.
 */

import { createHash } from 'node:crypto';
import { PRICING_SNAPSHOT } from './pricing-snapshot.js';

// ── Public types ────────────────────────────────────────────────────────

/** Minimal logger this module needs — a caller-injected sink for every
 * "kept the last good table" / "skipped an invalid entry" warning. No
 * default writes to stdout/stderr: supply one, or warnings are silent. */
export interface PriceBookLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: PriceBookLogger = { warn: () => {} };

/** The sliver of the `fetch` Response shape this module actually reads —
 * deliberately narrow so a test can inject a fake without implementing
 * the full Fetch API. */
export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (url: string) => Promise<FetchResponseLike>;

/** One model's parsed, validated price entry. Every numeric field here is
 * USD per token, finite, and non-negative — {@link parseEntry} is the only
 * place that constructs one, and it refuses anything that isn't. */
export interface ModelPriceEntry {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** 5-minute-TTL cache-write rate (`cache_creation_input_token_cost`). */
  cacheCreationInputTokenCost?: number;
  /** 1-hour-TTL cache-write rate (`cache_creation_input_token_cost_above_1hr`). */
  cacheCreationInputTokenCostAbove1Hr?: number;
  cacheReadInputTokenCost?: number;
  litellmProvider?: string;
}

/** Keyed exactly as the source payload keys its entries — sometimes a bare
 * model id (`"gpt-5"`), sometimes already `provider/model` (`"mistral/
 * mistral-large-latest"`). {@link PriceBook.costOf}'s lookup tries both
 * forms against a usage record; this type makes no claim about which form
 * any given key is in. */
export type PriceTable = Readonly<Record<string, ModelPriceEntry>>;

/** Where the table currently in effect came from. `fetchedAt` is epoch ms
 * from the caller-injected `now()`. `sha256` is the hash of the raw JSON
 * (fetched), of an explicitly-injected snapshot's `JSON.stringify`, or of
 * the bundled default snapshot's own `sha256` field — not a guarantee of
 * upstream integrity, just a stable fingerprint for logs. */
export interface PriceSource {
  kind: 'fetched' | 'snapshot';
  url?: string;
  fetchedAt?: number;
  sha256?: string;
  /** Set only when this source is the BUNDLED DEFAULT snapshot
   * ({@link PRICING_SNAPSHOT}) — never for a fetched source, and never
   * for an explicitly-injected {@link PriceBookOptions.snapshot}, which
   * carries no `asOf` of its own. Verbatim from that snapshot's `asOf`
   * field, so a caller can tell a default-snapshot cost apart from one
   * priced off a caller-supplied table, and see how stale it is. */
  asOf?: string;
}

/**
 * What {@link PriceBook.costOf} needs about one model call. Deliberately
 * its own shape, not `@verevoir/llm`'s `TokenUsage` — this module prices
 * whatever cache-token detail a caller has, including less than
 * `TokenUsage` may eventually carry, and depending on that type here would
 * wire this PR to whatever shape that one happens to be mid-migration.
 *
 * Anthropic's `inputTokens` excludes cache tokens entirely, so a correct
 * total is the sum of every field below that's present, each at its own
 * rate — never `inputTokens` alone.
 */
export interface UsageForPricing {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  /** Total cache-write tokens, when the provider reports only one number
   * rather than splitting by TTL. Priced at the 5-minute rate as the
   * closest available approximation; the result is marked `complete: false`
   * because that is a stated approximation, not a direct observation. */
  cacheCreationInputTokens?: number;
  /** 5-minute-TTL cache-write tokens, when the provider splits by TTL. */
  cacheCreationEphemeral5mInputTokens?: number;
  /** 1-hour-TTL cache-write tokens, when the provider splits by TTL. */
  cacheCreationEphemeral1hInputTokens?: number;
}

/**
 * The result of pricing one call. `usdMicros` is USD × 1,000,000, rounded
 * to the nearest integer, so downstream aggregation never accumulates
 * floating-point error across many calls. `complete: false` means some
 * portion of the usage was priced at an approximation (or not priced at
 * all) because the source table didn't carry the exact rate needed — the
 * total is a best effort, not a guess dressed up as exact. `unpriced`
 * means the model itself has no entry at all: never reported as `0`.
 */
export type CostResult =
  { usdMicros: number; complete: boolean; source: PriceSource } | { unpriced: string };

export interface PriceBookOptions {
  /** Injected so this module never reaches the network itself — a test
   * injects a fake, the real caller injects the platform's `fetch`. */
  fetch: FetchLike;
  url?: string;
  /** Default 24h. */
  refreshMs?: number;
  /** A pre-built, already-trusted table to use before any fetch succeeds
   * (and to fall back to if every fetch ever fails). No default is
   * bundled in this PR — ship one as a later change. */
  snapshot?: PriceTable;
  /** Injectable clock, for deterministic `fetchedAt` in tests. */
  now?: () => number;
  logger?: PriceBookLogger;
}

export interface PriceBook {
  /**
   * Fetch once immediately, then again every `refreshMs` on an unref'd
   * timer so it never keeps the process alive on its own. Calling `start`
   * again while already running re-triggers an immediate fetch but does
   * not schedule a second timer. `stop` is what ends the periodic timer.
   */
  start(): void;
  /** Clear the periodic timer. Safe to call when not started, or twice. */
  stop(): void;
  costOf(usage: UsageForPricing): CostResult;
  /** Number of priced models currently held — diagnostics only. */
  readonly size: number;
  /** Where the current table came from, or `undefined` before any
   * snapshot or successful fetch has populated it. */
  readonly source: PriceSource | undefined;
}

// ── Defaults ─────────────────────────────────────────────────────────────

export const DEFAULT_PRICE_BOOK_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;

const SAMPLE_SPEC_KEY = 'sample_spec';

// ── Parsing + validation ─────────────────────────────────────────────────

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Parse + validate one raw LiteLLM entry. `null` means "skip this entry"
 * — a required field is missing/invalid, or an optional field present but
 * invalid. Never throws; never half-fills an entry with a known-bad value. */
function parseEntry(raw: unknown): ModelPriceEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    !isFiniteNonNegative(r.input_cost_per_token) ||
    !isFiniteNonNegative(r.output_cost_per_token)
  ) {
    return null;
  }
  const entry: ModelPriceEntry = {
    inputCostPerToken: r.input_cost_per_token as number,
    outputCostPerToken: r.output_cost_per_token as number,
  };
  if (r.cache_creation_input_token_cost !== undefined) {
    if (!isFiniteNonNegative(r.cache_creation_input_token_cost)) return null;
    entry.cacheCreationInputTokenCost = r.cache_creation_input_token_cost;
  }
  if (r.cache_creation_input_token_cost_above_1hr !== undefined) {
    if (!isFiniteNonNegative(r.cache_creation_input_token_cost_above_1hr)) return null;
    entry.cacheCreationInputTokenCostAbove1Hr = r.cache_creation_input_token_cost_above_1hr;
  }
  if (r.cache_read_input_token_cost !== undefined) {
    if (!isFiniteNonNegative(r.cache_read_input_token_cost)) return null;
    entry.cacheReadInputTokenCost = r.cache_read_input_token_cost;
  }
  if (typeof r.litellm_provider === 'string') {
    entry.litellmProvider = r.litellm_provider;
  }
  return entry;
}

/** Parse a whole payload into a table, skipping `sample_spec` and any
 * entry that fails {@link parseEntry} (logged, not fatal to the payload).
 * `null` means the payload itself isn't a usable JSON object at all —
 * the caller treats that as "didn't parse". */
function parsePayload(
  json: unknown,
  logger: PriceBookLogger
): Record<string, ModelPriceEntry> | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    logger.warn('priceBook: payload is not a JSON object');
    return null;
  }
  const table: Record<string, ModelPriceEntry> = {};
  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    if (key === SAMPLE_SPEC_KEY) continue;
    const entry = parseEntry(value);
    if (!entry) {
      logger.warn(`priceBook: skipping invalid price entry "${key}"`);
      continue;
    }
    table[key] = entry;
  }
  return table;
}

const RATIO_FIELDS: readonly (keyof ModelPriceEntry)[] = [
  'inputCostPerToken',
  'outputCostPerToken',
  'cacheCreationInputTokenCost',
  'cacheCreationInputTokenCostAbove1Hr',
  'cacheReadInputTokenCost',
];

/**
 * True when any numeric rate shared by both tables, for the same model
 * key, moved by more than 10x in either direction — the refresh circuit
 * breaker against a corrupted or malicious upstream payload. A model
 * present in only one table is not compared (nothing to compare against).
 *
 * Deliberately applies to the FIRST live fetch too, when the table it
 * would replace is a snapshot — the bundled default, or a
 * caller-injected one — rather than a previously-fetched table. A 10x
 * jump against even an old, static snapshot is exactly as suspicious as
 * one against yesterday's live fetch, and a corrupted or malicious feed
 * is just as capable of being the very first response this process ever
 * sees as it is of being the hundredth. On rejection the snapshot stays
 * in effect — `refresh()` simply returns without replacing `table` or
 * `source` — and the rejection is logged loudly via the injected
 * `logger`, never silently swallowed.
 */
function has10xMove(
  oldTable: Record<string, ModelPriceEntry>,
  newTable: Record<string, ModelPriceEntry>,
  logger: PriceBookLogger
): boolean {
  for (const [model, oldEntry] of Object.entries(oldTable)) {
    const newEntry = newTable[model];
    if (!newEntry) continue;
    for (const field of RATIO_FIELDS) {
      const oldVal = oldEntry[field] as number | undefined;
      const newVal = newEntry[field] as number | undefined;
      if (oldVal === undefined || newVal === undefined) continue;
      if (oldVal === 0 && newVal === 0) continue;
      if (oldVal === 0 || newVal === 0) {
        logger.warn(`priceBook: rejecting refresh — ${model}.${field} moved to/from zero`, {
          oldVal,
          newVal,
        });
        return true;
      }
      const ratio = newVal / oldVal;
      if (ratio > 10 || ratio < 0.1) {
        logger.warn(`priceBook: rejecting refresh — ${model}.${field} moved more than 10x`, {
          oldVal,
          newVal,
        });
        return true;
      }
    }
  }
  return false;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── Public factory ───────────────────────────────────────────────────────

/**
 * The table + source in effect before any fetch has ever succeeded, and
 * the fallback {@link createPriceBook.refresh} returns to if every fetch
 * fails. An explicitly-injected {@link PriceBookOptions.snapshot} wins
 * outright — it is already a trusted {@link PriceTable}, used as-is,
 * exactly as before this default-fallback existed. Otherwise this falls
 * back to the bundled default, {@link PRICING_SNAPSHOT} — parsed through
 * the SAME {@link parsePayload} a live fetch's body goes through, because
 * it is the same raw LiteLLM shape, just trimmed to the fields this
 * module reads.
 *
 * The bundled default ships in this PR as an unpopulated placeholder
 * (`payload: {}`) — a later, non-belt step regenerates
 * `src/pricing-snapshot.ts` with real data. Until then this resolves to
 * an empty table, which is exactly the pre-this-PR behaviour for a caller
 * supplying neither a snapshot nor a successful fetch: every model
 * `unpriced`, never `0`.
 */
function defaultTableAndSource(
  options: PriceBookOptions,
  logger: PriceBookLogger
): { table: Record<string, ModelPriceEntry>; source: PriceSource } {
  if (options.snapshot) {
    return {
      table: { ...options.snapshot },
      source: { kind: 'snapshot', sha256: sha256Hex(JSON.stringify(options.snapshot)) },
    };
  }
  return {
    table: parsePayload(PRICING_SNAPSHOT.payload, logger) ?? {},
    source: {
      kind: 'snapshot',
      asOf: PRICING_SNAPSHOT.asOf,
      sha256: PRICING_SNAPSHOT.sha256,
      url: PRICING_SNAPSHOT.sourceUrl,
    },
  };
}

export function createPriceBook(options: PriceBookOptions): PriceBook {
  const url = options.url ?? DEFAULT_PRICE_BOOK_URL;
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? noopLogger;

  const initial = defaultTableAndSource(options, logger);
  let table: Record<string, ModelPriceEntry> = initial.table;
  let source: PriceSource | undefined = initial.source;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(): Promise<void> {
    let res: FetchResponseLike;
    try {
      res = await options.fetch(url);
    } catch (err) {
      logger.warn('priceBook: fetch threw, keeping the last good table', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!res.ok) {
      logger.warn('priceBook: fetch returned a non-OK status, keeping the last good table', {
        status: res.status,
      });
      return;
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      logger.warn('priceBook: failed reading the response body, keeping the last good table', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      logger.warn('priceBook: response was not valid JSON, keeping the last good table', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const parsed = parsePayload(json, logger);
    if (!parsed || Object.keys(parsed).length === 0) {
      logger.warn('priceBook: parsed payload had no valid entries, keeping the last good table');
      return;
    }
    if (has10xMove(table, parsed, logger)) {
      return;
    }
    table = parsed;
    source = { kind: 'fetched', url, fetchedAt: now(), sha256: sha256Hex(text) };
  }

  function lookup(usage: UsageForPricing): ModelPriceEntry | undefined {
    // Exact model id first, then `provider/model` — never a guessed alias.
    return table[usage.model] ?? table[`${usage.provider}/${usage.model}`];
  }

  function costOf(usage: UsageForPricing): CostResult {
    const entry = lookup(usage);
    if (!entry) {
      return {
        unpriced: `no price entry for model "${usage.model}" (provider "${usage.provider}")`,
      };
    }

    let usd =
      usage.inputTokens * entry.inputCostPerToken + usage.outputTokens * entry.outputCostPerToken;
    let complete = true;

    const cacheRead = usage.cacheReadInputTokens ?? 0;
    if (cacheRead > 0) {
      if (entry.cacheReadInputTokenCost !== undefined) {
        usd += cacheRead * entry.cacheReadInputTokenCost;
      } else {
        complete = false;
      }
    }

    const splitKnown =
      usage.cacheCreationEphemeral5mInputTokens !== undefined ||
      usage.cacheCreationEphemeral1hInputTokens !== undefined;

    if (splitKnown) {
      const t5m = usage.cacheCreationEphemeral5mInputTokens ?? 0;
      if (t5m > 0) {
        if (entry.cacheCreationInputTokenCost !== undefined) {
          usd += t5m * entry.cacheCreationInputTokenCost;
        } else {
          complete = false;
        }
      }
      const t1h = usage.cacheCreationEphemeral1hInputTokens ?? 0;
      if (t1h > 0) {
        if (entry.cacheCreationInputTokenCostAbove1Hr !== undefined) {
          usd += t1h * entry.cacheCreationInputTokenCostAbove1Hr;
        } else {
          complete = false;
        }
      }
    } else {
      const totalWrite = usage.cacheCreationInputTokens ?? 0;
      if (totalWrite > 0) {
        if (entry.cacheCreationInputTokenCost !== undefined) {
          usd += totalWrite * entry.cacheCreationInputTokenCost;
        }
        // Only a total was reported; pricing it at the 5m rate is an
        // approximation even when that rate exists, so this is always
        // incomplete — never silently presented as exact.
        complete = false;
      }
    }

    return {
      usdMicros: Math.round(usd * 1_000_000),
      complete,
      // Invariant above guarantees `source` is set whenever `entry` was
      // found (both are populated from the same table-replacing step).
      source: source as PriceSource,
    };
  }

  return {
    start() {
      void refresh();
      if (timer) return;
      timer = setInterval(() => {
        void refresh();
      }, refreshMs);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    costOf,
    get size() {
      return Object.keys(table).length;
    },
    get source() {
      return source;
    },
  };
}
