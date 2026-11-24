/**
 * @verevoir/llm/vertex-openai — Vertex AI's OpenAI-compatible endpoint.
 *
 * Google Cloud Vertex AI serves models of several publishers behind the Chat
 * Completions protocol, at
 * `…/v1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions`.
 * The three call shapes are the shared ones in `../openai-compat.js`; this
 * subpath supplies the client (see `./client.js`), the model rule and the
 * output-token rule. Importing it requires `openai` and `google-auth-library`
 * as peer dependencies on the consumer; no other subpath imports
 * `google-auth-library`.
 *
 * Authentication is Google Cloud's standard credentials flow: a bearer access
 * token, asked of `google-auth-library` before every request, so a token that
 * has been replaced is the one sent. There is no API key: a per-call `apiKey`
 * is refused. The project comes from `GOOGLE_CLOUD_PROJECT` and the location
 * from `GOOGLE_CLOUD_LOCATION`, which defaults to `global`.
 *
 * There is no model catalogue and no default model: `model` is required, in
 * the endpoint's `<publisher>/<model>` form, and is sent exactly as given.
 *
 * Nothing is registered into the model catalogue or the connection registry.
 */

import { createOpenAICompatCalls, type CompatUsage } from '../openai-compat.js';
import {
  VertexOpenAIConfigError,
  VertexOpenAITokenError,
  resolveClient,
  tokenFailureIn,
  type VertexOpenAISetting,
} from './client.js';
import type {
  ChatOptions,
  ChatReply,
  ChatWithToolLoopOptions,
  ChatWithToolLoopResult,
  ChatWithToolsOptions,
  ChatWithToolsResult,
} from '../index.js';

/** The provider id on this route's `TokenUsage` and model span. */
export const PROVIDER = 'vertex-openai';

export { VertexOpenAIConfigError, VertexOpenAITokenError };
export type { VertexOpenAISetting };

/** The model id for a call: the caller's, exactly as given. There is no
 * catalogue to choose from, so a call that names none is refused. */
function modelFor(named: string | undefined): string {
  if (typeof named !== 'string' || named.trim() === '') {
    throw new VertexOpenAIConfigError(
      'model',
      'No model: this route has no default model. Pass `model` as <publisher>/<model>.'
    );
  }
  return named;
}

/**
 * Output tokens for one response. The endpoint reports reasoning tokens in
 * `completion_tokens_details.reasoning_tokens`, and the response's own
 * `total_tokens` says whether `completion_tokens` already holds them: when the
 * total equals prompt + completion + reasoning, they were reported apart and
 * are added here; otherwise `completion_tokens` is the whole output. Reasoning
 * tokens are never counted twice and never dropped where the response's own
 * figures show them outside `completion_tokens`.
 */
function outputTokensOf(usage: CompatUsage): number {
  const completion = usage.completion_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  const reportedApart =
    reasoning > 0 && usage.total_tokens === (usage.prompt_tokens ?? 0) + completion + reasoning;
  return reportedApart ? completion + reasoning : completion;
}

const calls = createOpenAICompatCalls({
  provider: PROVIDER,
  route: 'google-cloud',
  getClient: resolveClient,
  modelFor,
  outputTokensOf,
});

/** Run one call; a failure to obtain an access token rejects as this route's
 * own {@link VertexOpenAITokenError}, not as the SDK's wrapper around it.
 * Every other error is rethrown as it is. */
async function withTokenFailureUnwrapped<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw tokenFailureIn(err) ?? err;
  }
}

/** Single-shot text generation. `model` is required. */
export function chat(options: ChatOptions): Promise<ChatReply> {
  return withTokenFailureUnwrapped(() => calls.chat(options));
}

/** Tool-calling variant. Single-shot: the model's tool calls are returned to
 * the caller for execution. `model` is required. */
export function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  return withTokenFailureUnwrapped(() => calls.chatWithTools(options));
}

/** Multi-turn tool-using chat: model → execute tools → feed results back,
 * until the model answers in text or the iteration cap fires. Returned `usage`
 * is the sum across the loop's calls. `model` is required. */
export function chatWithToolLoop(
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  return withTokenFailureUnwrapped(() => calls.chatWithToolLoop(options));
}

/** Namespaced form for callers that prefer `vertexOpenAI.chat(...)`. */
export const vertexOpenAI = {
  PROVIDER,
  chat,
  chatWithTools,
  chatWithToolLoop,
};
