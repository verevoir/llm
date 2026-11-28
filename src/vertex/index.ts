/**
 * @verevoir/llm/vertex — Claude on Google Cloud Vertex AI.
 *
 * The Anthropic adapter with a different client: the requests, the cache
 * breakpoints, the tool loop, the retries and the usage accounting are the
 * shared implementation in `../anthropic/adapter.js`; this subpath supplies only
 * the client, an `AnthropicVertex` from `@anthropic-ai/vertex-sdk` (see
 * `./client.js`). Importing this subpath requires `@anthropic-ai/vertex-sdk` as
 * a peer dependency on the consumer; no other subpath imports it.
 *
 * Authentication is Google Cloud's standard credentials flow, run by the Vertex
 * SDK. There is no API key: a per-call `apiKey` is refused, and
 * `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` are never read. The project
 * and region come from the environment variables the Vertex SDK itself reads,
 * `ANTHROPIC_VERTEX_PROJECT_ID` and `CLOUD_ML_REGION`. `ANTHROPIC_VERTEX_BASE_URL`
 * sends requests to another address, and `ANTHROPIC_VERTEX_ACCESS_TOKEN` gives a
 * fixed bearer token in place of the Google Cloud credentials flow.
 *
 * The model name is sent as given: `ChatOptions.model` when set, otherwise the
 * Anthropic catalogue's id for the `modelClass`. Nothing maps a name to a
 * Vertex one — where Vertex AI names a model differently, pass that name as
 * `model`.
 *
 * Nothing is registered into the model catalogue or the connection registry.
 */

import * as adapter from '../anthropic/adapter.js';
import { GEN_AI_PROVIDER_GCP_VERTEX_AI } from '../otel.js';
import { resolveClient } from './client.js';
import type {
  ChatOptions,
  ChatReply,
  ChatWithToolLoopOptions,
  ChatWithToolLoopResult,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  ContentBlock,
} from '../index.js';

/** The provider id on a Vertex call's `TokenUsage`. */
export const PROVIDER = 'vertex';

export type { ContentBlock };

// No `switchCredentialAfter`: this route has one credential mechanism, so a
// failed call is never made again on another. No `systemPrefix`: nothing about
// Google Cloud authentication adds a block to a request.
const transport: adapter.AnthropicTransport = {
  provider: PROVIDER,
  spanProvider: GEN_AI_PROVIDER_GCP_VERTEX_AI,
  resolveClient,
};

/**
 * Single-shot LLM call. Streams the response, supports retry with narration
 * and live progress reporting via the auto-injected `report_progress` tool
 * when `onProgress` is set.
 */
export function chat(options: ChatOptions): Promise<ChatReply> {
  return adapter.chat(transport, options);
}

/**
 * Tool-calling variant. Single-shot: every non-progress tool_use is returned
 * to the caller for execution.
 */
export function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  return adapter.chatWithTools(transport, options);
}

/**
 * Multi-turn tool-using chat: runs the model → execute tools → feed results
 * back loop until the model answers in text or the iteration cap fires.
 * Returned `usage` is the sum across the loop's calls.
 */
export function chatWithToolLoop(
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  return adapter.chatWithToolLoop(transport, options);
}

/** Namespaced form for callers that prefer `vertex.chat(...)`. */
export const vertex = {
  PROVIDER,
  chat,
  chatWithTools,
  chatWithToolLoop,
};
