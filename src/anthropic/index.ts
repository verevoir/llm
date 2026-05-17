/**
 * @verevoir/llm/anthropic — Anthropic SDK adapter.
 *
 * The implementation is being extracted from a private consumer. This
 * subpath currently exports a placeholder that throws on call; the real
 * `chat()` + streaming + tool support lands with the extraction slice.
 *
 * Once published, importing this subpath requires `@anthropic-ai/sdk` as
 * a peer dependency in the consumer's project.
 */

import type { ChatOptions, ChatReply } from '../index.js';

export const anthropic = {
  async chat(_options: ChatOptions): Promise<ChatReply> {
    throw new Error(
      '@verevoir/llm/anthropic: extraction in progress; not callable yet',
    );
  },
};
