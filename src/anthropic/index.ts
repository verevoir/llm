/**
 * @verevoir/llm/anthropic — Anthropic SDK adapter.
 *
 * Wraps `@anthropic-ai/sdk` in the provider-agnostic surface defined in
 * the core. Importing this subpath requires `@anthropic-ai/sdk` as a
 * peer dependency on the consumer.
 *
 * The model catalogue itself (PROVIDER, CATALOG) lives in `./catalog.js`,
 * which has no SDK import — a consumer that only needs to resolve a model
 * term (not place a real call) can import `@verevoir/llm/catalog` instead
 * and never pull in `@anthropic-ai/sdk` at all. This file still imports and
 * registers it exactly as before, so nothing here changes for an existing
 * consumer of this subpath.
 *
 * The calls themselves (request building, cache breakpoints, streaming, the
 * tool loop, each request under the library's one retry policy) are
 * implemented in `./adapter.js`, which is internal.
 * This file is the direct-API route over it: it supplies the client, the
 * credential rules and the subscription-token system identity from
 * `./client.js`, which the shared implementation never imports.
 */

import * as adapter from './adapter.js';
import { isAuthError, noteOAuthRejected, oauthSystemIdentity, resolveClient } from './client.js';
import { PROVIDER, CATALOG, CONNECTION } from './catalog.js';
import {
  type ChatOptions,
  type ChatReply,
  type ChatWithToolLoopOptions,
  type ChatWithToolLoopResult,
  type ChatWithToolsOptions,
  type ChatWithToolsResult,
  type ContentBlock,
  type RatesTable,
  registerModelCatalog,
  registerProviderConnection,
} from '../index.js';

// ────────────────────────────────────────────────────────────────────
// Public model table
// ────────────────────────────────────────────────────────────────────

export { PROVIDER };

// Re-exported so a caller can write `import { chatWithToolLoop, type
// ContentBlock } from '@verevoir/llm/anthropic'` without reaching back
// into the core package — ContentBlock is only ever imported, never
// re-exported, otherwise.
export type { ContentBlock };

// Register the catalog into the core so normalisation, family-level pricing,
// and labels work for any consumer (and any future version of these families).
// Import side-effect; idempotent. Also registers currentId + aliases as labels.
registerModelCatalog([...CATALOG]);

/**
 * Concrete model id per {@link ModelClass}, derived from {@link CATALOG} — the
 * only place a call site needs. Upgrades happen in the catalog, not here.
 */
export const models = adapter.models;

/**
 * Per-model pricing keyed by the concrete current id, derived from
 * {@link CATALOG}. Kept for back-compat with consumers that look pricing up by
 * exact id.
 *
 * @deprecated Part of the old static-rates cost API. Use
 * `createPriceBook(...)` / `book.costOf(...)` instead (see `src/pricing.ts`)
 * — it prices from LiteLLM's live table (the bundled snapshot as fallback)
 * and reports an unmatched model as `unpriced` rather than `0`.
 */
export const rates: RatesTable = Object.fromEntries(CATALOG.map((e) => [e.currentId, e.rates]));

// ────────────────────────────────────────────────────────────────────
// Internal
// ────────────────────────────────────────────────────────────────────

registerProviderConnection(CONNECTION);

// Credential resolution, client construction, and the OAuth→API-key fallback live
// in ./client.js (internal — off the public surface): `resolveClient`,
// `isAuthError`, `noteOAuthRejected` and `oauthSystemIdentity` (imported above), plus
// `resolveAnthropicAuth` + the reset seam the co-located tests import. The
// mutable client/latch state is private to that module.

/**
 * The direct-API transport: the client `./client.js` resolves, reported as
 * `'subscription-oauth'` or `'api-key'`, with a one-time, session-wide
 * OAuth→API-key fallback on an authentication error. A request on the
 * subscription token carries the Claude-Code identity as its first system
 * block, which Anthropic requires of that credential; a request on an API key
 * carries nothing extra. The subscription-OAuth
 * path leans on undocumented headers + an identity gate that can change; rather
 * than hard-fail every call when they do, a 401 falls back to the metered key —
 * but LOUDLY (see {@link noteOAuthRejected}), never silently resuming the spend
 * the OAuth path exists to avoid. Fallback fires only when the failed call was
 * OAuth-authed, no per-call key was supplied, and a metered key is available.
 */
const transport: adapter.AnthropicTransport = {
  provider: PROVIDER,
  resolveClient(perCallApiKey) {
    const { client, oauth } = resolveClient(perCallApiKey);
    return { client, route: oauth ? 'subscription-oauth' : 'api-key' };
  },
  systemPrefix(resolved) {
    return resolved.route === 'subscription-oauth'
      ? [{ type: 'text', text: oauthSystemIdentity() }]
      : [];
  },
  switchCredentialAfter(failed, perCallApiKey, err) {
    const canFallBack =
      failed.route === 'subscription-oauth' &&
      !perCallApiKey &&
      isAuthError(err) &&
      !!process.env.ANTHROPIC_API_KEY?.trim();
    if (canFallBack) noteOAuthRejected(err); // the next resolve is the metered-key client
    return canFallBack;
  },
};

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Single-shot LLM call. Streams the response, supports retry with
 * narration, BYOK, and live progress reporting via the auto-injected
 * `report_progress` tool when `onProgress` is set.
 */
export function chat(options: ChatOptions): Promise<ChatReply> {
  return adapter.chat(transport, options);
}

/**
 * Tool-calling variant. The model decides which tools to invoke
 * against the supplied definitions; we surface every non-progress
 * tool_use to the caller for execution. Single-shot — no automated
 * multi-turn tool dance.
 */
export function chatWithTools(options: ChatWithToolsOptions): Promise<ChatWithToolsResult> {
  return adapter.chatWithTools(transport, options);
}

/**
 * Multi-turn tool-using chat. The caller supplies an executor; this
 * function runs the model → execute tools → feed results back loop
 * internally until the model produces a text-only response (or the
 * iteration cap fires).
 *
 * Each loop iteration is a full Anthropic call. Tool execution
 * happens between iterations; tool failures are surfaced to the model
 * as `tool_result` blocks with `is_error: true` so it can recover
 * (apologise, retry, switch approach) rather than the loop crashing.
 *
 * Usage and progress hooks fire per-iteration. Returned `usage` is
 * the sum across all iterations of the loop, so cost accounting at
 * the call site stays per-conversation-turn.
 */
export function chatWithToolLoop(
  options: ChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  return adapter.chatWithToolLoop(transport, options);
}

/**
 * Namespaced re-export for callers that prefer the namespace form
 * (`anthropic.chat(...)`) over named imports.
 */
export const anthropic = {
  PROVIDER,
  models,
  rates,
  chat,
  chatWithTools,
  chatWithToolLoop,
};
