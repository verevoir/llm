import type { StopKind } from '../index.js';

/** Anthropic's `stop_reason` words, as `StopReason` in `@anthropic-ai/sdk`
 * 0.95.2 declares them. A word added in a later SDK, or not declared at all,
 * falls to `other`. SDK-free, so `/claude-cli` reads the same rows. */
const KINDS: Readonly<Record<string, StopKind>> = {
  end_turn: 'finished',
  max_tokens: 'max_tokens',
  tool_use: 'tool_use',
  stop_sequence: 'stop_sequence',
  refusal: 'refused',
  pause_turn: 'other',
};

/** The {@link StopKind} for an Anthropic `stop_reason`. Never throws. */
export function anthropicStopKind(stopReason: string): StopKind {
  return Object.hasOwn(KINDS, stopReason) ? KINDS[stopReason] : 'other';
}
