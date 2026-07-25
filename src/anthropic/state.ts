import type Anthropic from '@anthropic-ai/sdk';

/**
 * Mutable module state for the Anthropic adapter's client: the cached default
 * client and the session OAuth→API-key fallback latch. Kept in this INTERNAL
 * module — not re-exported from the package's public `@verevoir/llm/anthropic`
 * surface — so the test-only reset below is reachable by the co-located tests
 * without shipping a state-mutation seam as package API.
 */
export const clientState: {
  defaultClient: Anthropic | null;
  /** Set once a subscription OAuth token is rejected with a 401, so subsequent
   * calls skip it and use the metered key (see the adapter's `streamedCall` /
   * `noteOAuthRejected`). */
  oauthDisabled: boolean;
  /** Guards the one-time loud fallback warning. */
  oauthFallbackWarned: boolean;
} = {
  defaultClient: null,
  oauthDisabled: false,
  oauthFallbackWarned: false,
};

/** Test seam: reset the cached client + the fallback latch between tests.
 * INTERNAL — imported directly by the co-located tests, never exported to
 * consumers, so it never appears on the package's public surface. */
export function resetClientStateForTests(): void {
  clientState.defaultClient = null;
  clientState.oauthDisabled = false;
  clientState.oauthFallbackWarned = false;
}
