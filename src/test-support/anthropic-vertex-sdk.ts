/**
 * A fake of `@anthropic-ai/vertex-sdk` for tests that mock the module:
 *
 *   vi.mock('@anthropic-ai/vertex-sdk', () => import('../test-support/anthropic-vertex-sdk.js'));
 *
 * The fake client records its constructor options in `vertexCtor` and
 * answers `messages.stream` with `vertexStream`. Its replies are built with
 * the stream builders of `anthropic-sdk.ts`, as the two clients share one
 * Messages API.
 *
 * The build leaves this directory out (`tsconfig.build.json`), so nothing here
 * is published.
 */

import { vi } from 'vitest';

export const vertexStream = vi.fn();
export const vertexCtor = vi.fn();

export class AnthropicVertex {
  messages = { stream: vertexStream };
  constructor(opts: unknown) {
    vertexCtor(opts);
  }
}
