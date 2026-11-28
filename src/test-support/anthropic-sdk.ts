/**
 * A fake of `@anthropic-ai/sdk` for tests that mock the module:
 *
 *   vi.mock('@anthropic-ai/sdk', () => import('../test-support/anthropic-sdk.js'));
 *
 * The fake client records its constructor options in `anthropicCtor` and
 * answers `messages.stream` with `anthropicStream`, a `vi.fn` each test
 * scripts. Vitest gives each test file its own copy of this module, so one
 * file's script never reaches another's.
 *
 * The build leaves this directory out (`tsconfig.build.json`), so nothing here
 * is published.
 */

import { vi } from 'vitest';

export const anthropicStream = vi.fn();
export const anthropicCtor = vi.fn();

export default class Anthropic {
  messages = { stream: anthropicStream };
  constructor(opts: unknown) {
    anthropicCtor(opts);
  }
}

/** One content block of a message, as the Messages API returns it. */
export interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A usage object with every count present and 0. */
export const ANTHROPIC_ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

/** A stream whose final message is `message`, exactly as given. */
export function streamOf(message: Record<string, unknown>) {
  return { on: () => {}, finalMessage: async () => message };
}

/** A stream whose final message rejects with `error`. */
export function failingStream(error: unknown) {
  return { on: () => {}, finalMessage: () => Promise.reject(error) };
}

/**
 * A stream whose final message holds `blocks`, `stopReason` and `usage`.
 * `meta` adds top-level fields such as `id` and `model`; without it the
 * message has neither.
 */
export function messageStream(
  blocks: AnthropicBlock[],
  stopReason: string | undefined,
  usage: object = ANTHROPIC_ZERO_USAGE,
  meta: Record<string, unknown> = {}
) {
  return streamOf({ ...meta, content: blocks, stop_reason: stopReason, usage });
}
