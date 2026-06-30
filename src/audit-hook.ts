import type { TokenUsage } from './index';

// Model-span hook (STDIO-500). An optional, fail-soft sink that fires once per
// model call with the call's usage + tier, so a consumer (the MCP audit, or
// aigency-web's executor) can record EVERY model call as a span — not only the
// delegated ones that go through delegate/dispatch. This closes the audit
// coverage gap where an *inline* coordinator (the 494 failure mode) burned the
// reasoning tier invisibly, because nothing on its path emitted a span.
//
// @verevoir/llm stays audit-agnostic: it knows nothing of the audit format or
// where the log lives; it just hands a plain usage record to whoever registered.
// The consumer maps it to its own span/audit shape.
//
// Off by default: with no sink registered, `emitModelSpan` is a no-op, so there
// is zero behaviour change for any consumer that does not opt in.

/** One model call's usage, tagged with the chat entry that made it. The sink
 * maps this to its own span/audit format. Extends the standard `TokenUsage`
 * (provider, model, direction/tier, token counts) with the emitting `scope`. */
export interface ModelSpan extends TokenUsage {
  /** Which chat entry emitted it, e.g. `anthropic.chatWithTools`. */
  scope: string;
}

export type ModelSpanSink = (span: ModelSpan) => void;

let _sink: ModelSpanSink | null = null;

/** Register (or clear, with `null`) the process-wide model-span sink. The most
 * recent registration wins; pass `null` to detach. One process = one sink,
 * matching the single-writer model of the MCP audit log. */
export function setModelSpanSink(sink: ModelSpanSink | null): void {
  _sink = sink;
}

/** Fire the registered sink for one model call. No-op when none is registered.
 * Never throws — a sink that throws is caught and warned, so audit /
 * observability can never break a model call (mirrors the `onUsage` contract). */
export function emitModelSpan(span: ModelSpan): void {
  const sink = _sink;
  if (!sink) return;
  try {
    sink(span);
  } catch (err) {
    console.warn('emitModelSpan: sink threw', err);
  }
}
