/**
 * @verevoir/llm — provider-agnostic LLM call surface.
 *
 * The core export holds shared types, accounting helpers, and the
 * `chat()` contract that every provider adapter implements. SDK
 * adapters live in subpaths (./anthropic, ./google planned). Consumers
 * import the subpath(s) they use; the unused SDK never enters their
 * bundle.
 */

// ────────────────────────────────────────────────────────────────────
// Core types
// ────────────────────────────────────────────────────────────────────

/**
 * Model-class semantic — what kind of work the call is doing.
 *
 * - `reasoning`: open-ended judgement, cross-document synthesis,
 *   nuanced chat. The conservative default for sites that have to
 *   think across context.
 * - `extraction`: structured turn-text-into-shape tasks (URLs from a
 *   conversation, config from a paragraph). Quick, predictable,
 *   constrained output. Smallest competent model.
 *
 * Adapters map each class to a concrete provider model id (e.g.
 * `reasoning` → `claude-opus-4-7` on Anthropic). The class travels
 * through to {@link TokenUsage} as `direction` so cost rollups can
 * break down spend per direction natively.
 */
export type ModelClass = 'reasoning' | 'extraction';

/**
 * Per-turn content. Plain `string` is the convenient v0 shape for
 * pure-text conversations. `ContentBlock[]` carries structured
 * content needed for multi-turn tool loops (tool_use + tool_result
 * blocks) and lays the schema for future multimodal blocks (image,
 * document) without a second migration.
 *
 * Adapters accept either form; pass a string if you have no
 * structure to preserve.
 */
export type TurnContent = string | ContentBlock[];

/**
 * Discriminated union of message-content blocks. Mirrors Anthropic's
 * native shape so the adapter doesn't have to translate. Adapters that
 * don't support a given block kind (e.g. Google for `tool_result`)
 * should surface a typed error rather than silently dropping content.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      /**
       * Result returned by the tool, serialised as a string the model
       * can read. Use JSON for structured results.
       */
      content: string;
      /** True when the tool errored; the model treats it as a failure. */
      is_error?: boolean;
    };

/** A single message in a conversation. */
export interface Turn {
  role: 'user' | 'assistant';
  content: TurnContent;
}

/**
 * Per-call token + provenance record. Returned alongside every reply.
 * The (provider, model, direction) triple is the model-direction grid
 * used for cost rollups.
 */
export interface TokenUsage {
  /** Provider id, e.g. `anthropic`, `google`. */
  provider: string;
  /** Concrete model id used for the call, e.g. `claude-opus-4-7`. */
  model: string;
  /** The model-class semantic the caller asked for. */
  direction: ModelClass;
  /** Standard input tokens. */
  inputTokens: number;
  /** Output tokens (completion + tool-use args). */
  outputTokens: number;
  /** Tokens written to provider cache on this call. */
  cacheCreationInputTokens: number;
  /** Tokens read from provider cache on this call. */
  cacheReadInputTokens: number;
}

/** Live-progress narration emitted by the model during a long call. */
export interface ProgressInfo {
  /** Progress in 5–90 (the system handles 0 and 100). */
  percent: number;
  /** Short customer-facing status message. */
  message: string;
}

/** Information passed to {@link ChatOptions.onRetry} before each retry. */
export interface ChatRetryInfo {
  /** 1-indexed retry attempt; the original call is attempt 0. */
  attempt: number;
  /** Total retries that will be made before giving up. */
  maxAttempts: number;
  /** Milliseconds we're about to wait before this retry. */
  delayMs: number;
  /** Short human-readable reason — suitable for chat narration. */
  reason: string;
}

/** Options for a single LLM call. */
export interface ChatOptions {
  systemPrompt: string;
  turns: Turn[];
  /**
   * Per-user (BYOK) API key. When null/undefined the adapter falls
   * back to the platform default (e.g. an env var).
   */
  apiKey?: string | null;
  /** Defaults to `'reasoning'` — the conservative choice. */
  modelClass?: ModelClass;
  /**
   * Optional hook invoked before each retry. Best-effort; the adapter
   * never lets a callback failure block the retry.
   */
  onRetry?: (info: ChatRetryInfo) => Promise<void>;
  /** Optional hook invoked after a successful call with token usage. */
  onUsage?: (usage: TokenUsage) => Promise<void>;
  /**
   * Optional hook invoked LIVE during the call when the model emits
   * `report_progress`. When set, the adapter auto-injects the
   * `report_progress` tool into the request.
   */
  onProgress?: (info: ProgressInfo) => Promise<void>;
}

/** Result of a single LLM call via {@link chat}. */
export interface ChatReply {
  /** The assembled text content of the reply. */
  content: string;
  /** Token usage for the call. */
  usage: TokenUsage;
  /** The provider's stop reason — `'end_turn'` for normal completion. */
  stopReason: string;
}

// ────────────────────────────────────────────────────────────────────
// Tool-calling
// ────────────────────────────────────────────────────────────────────

/** Definition of a tool the model can choose to invoke. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** A single tool_use the model emitted in its reply. */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Options for {@link chatWithTools}. */
export interface ChatWithToolsOptions extends ChatOptions {
  tools: ToolDef[];
}

/** Result of a single LLM call via {@link chatWithTools}. */
export interface ChatWithToolsResult {
  toolUses: ToolUse[];
  text: string;
  stopReason: string;
  usage: TokenUsage;
}

// ────────────────────────────────────────────────────────────────────
// Multi-turn tool loop
// ────────────────────────────────────────────────────────────────────

/**
 * Caller-supplied function that executes a single tool_use the model
 * emitted, returning a string the model will see as the matching
 * `tool_result`. Throw to indicate a tool failure — the loop will
 * surface it to the model with `is_error: true` so the model can
 * react (apologise, try a different approach, etc.) rather than
 * crashing the entire conversation.
 */
export type ToolExecutor = (toolUse: ToolUse) => Promise<string>;

/** Options for {@link chatWithToolLoop}. */
export interface ChatWithToolLoopOptions extends ChatWithToolsOptions {
  /** Runs each tool_use the model emits. Required. */
  executor: ToolExecutor;
  /**
   * Cap on tool-call iterations. The loop exits after this many
   * tool-using assistant turns regardless of whether the model would
   * have continued. Default 5 — generous for typical conversations
   * (each tool round costs a full LLM call + execution).
   */
  maxIterations?: number;
  /**
   * Optional hook fired after each iteration with a compact summary —
   * useful for narrating progress into a chat surface ("Looking up
   * issues...", "Reading file...").
   */
  onIteration?: (info: {
    iteration: number;
    toolUses: ToolUse[];
    stopReason: string;
  }) => Promise<void>;
}

/** Result of a multi-turn tool conversation. */
export interface ChatWithToolLoopResult {
  /** The model's final text response (after all tool iterations). */
  text: string;
  /** All tool_uses across every iteration of the loop, in order. */
  toolUses: ToolUse[];
  /** Per-tool-use, the string the executor returned (or the error message). */
  toolResults: { toolUseId: string; content: string; isError: boolean }[];
  /** How many model calls happened (1 = pure text, no tools used). */
  iterations: number;
  /** Aggregated usage across all iterations of the loop. */
  usage: TokenUsage;
}

// ────────────────────────────────────────────────────────────────────
// Accounting helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Per-model rollup keyed by concrete model id. Produced by
 * {@link sumUsages}; consumed by display helpers.
 */
export type PerModelUsage = Record<string, { in: number; out: number }>;

/**
 * Parse a JSON-serialised {@link PerModelUsage} produced by a previous
 * call, returning an empty rollup on malformed/empty input.
 */
export function parseUsage(json: string): PerModelUsage {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PerModelUsage;
    }
  } catch {
    // Malformed JSON — treat as empty.
  }
  return {};
}

/** Sum multiple {@link PerModelUsage} rollups into one. */
export function sumUsages(usages: PerModelUsage[]): PerModelUsage {
  const out: PerModelUsage = {};
  for (const u of usages) {
    for (const [model, vals] of Object.entries(u)) {
      const existing = out[model] ?? { in: 0, out: 0 };
      existing.in += vals.in;
      existing.out += vals.out;
      out[model] = existing;
    }
  }
  return out;
}

/** Total tokens across all models in a rollup (input + output). */
export function totalTokens(usage: PerModelUsage): number {
  let total = 0;
  for (const v of Object.values(usage)) total += v.in + v.out;
  return total;
}

/**
 * Compact token total — `123`, `12.3k`, `12k`, `1.2M`. Drops trailing
 * `.0` so round numbers don't look gawky.
 */
export function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Tuple of `[input_per_million_USD, output_per_million_USD]`. Adapters
 * export their own rate tables for the consumer to feed into cost
 * helpers.
 */
export type RateTuple = readonly [number, number];

/** Per-model rate table — `model id → [input_per_mtok, output_per_mtok]`. */
export type RatesTable = Readonly<Record<string, RateTuple>>;

/**
 * Estimate the USD cost of a per-model rollup against an adapter's
 * rate table. Worst-case treatment: cache reads count at the standard
 * input rate (typically ~10× the real cache-read rate), so the result
 * is an upper bound on the actual bill.
 *
 * Unknown models contribute 0 to the total — the caller can detect
 * coverage gaps by checking that every model in the rollup is in the
 * rates table.
 */
export function estimateCostUSD(usage: PerModelUsage, rates: RatesTable): number {
  let total = 0;
  for (const [model, v] of Object.entries(usage)) {
    const rate = rates[model];
    if (!rate) continue;
    const [inputRate, outputRate] = rate;
    total += (v.in * inputRate + v.out * outputRate) / 1_000_000;
  }
  return total;
}

/**
 * Friendly label registry for known model ids. Adapters merge their
 * known models into this map; consumers can register their own
 * additions. Falls back to the bare id for unknown models so we don't
 * silently swallow them.
 */
const MODEL_LABELS: Record<string, string> = {};

/** Register friendly labels for the given model ids. Idempotent. */
export function registerModelLabels(labels: Record<string, string>): void {
  Object.assign(MODEL_LABELS, labels);
}

/** Display label for a model id, falling back to the id itself. */
export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? id;
}
