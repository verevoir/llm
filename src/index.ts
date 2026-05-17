/**
 * @verevoir/llm — provider-agnostic LLM call surface.
 *
 * The core export holds shared types and the `chat()` contract; SDK
 * adapters live in subpaths (./anthropic, ./google). Consumers import
 * the subpaths they use; the unused provider SDK never enters their
 * bundle.
 *
 * The concrete implementation is being extracted from a private
 * consumer. Types here are the published surface; the adapter
 * implementations in subpaths land with the extraction slice.
 */

/**
 * Model-class semantic — what kind of work the call is doing. Adapters
 * map each class to a concrete provider model id (e.g. `reasoning` →
 * `claude-opus-4-7` on Anthropic). Carried through to `TokenUsage` so
 * cost rollups can break down spend by direction.
 */
export type ModelClass = 'reasoning' | 'extraction';

/** A single message in a conversation passed to `chat()`. */
export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Per-call token + provenance record. Returned alongside every reply so
 * the consumer can persist per-direction usage and compute costs without
 * a second round-trip.
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

/** Options for a single LLM call. */
export interface ChatOptions {
  systemPrompt: string;
  turns: Turn[];
  apiKey: string;
  modelClass?: ModelClass;
}

/** Result of a single LLM call. */
export interface ChatReply {
  content: string;
  usage: TokenUsage;
}

/**
 * Per-model rollup keyed by concrete model id. Returned by
 * `sumUsages` and consumed by display helpers.
 */
export type PerModelUsage = Record<string, { in: number; out: number }>;
