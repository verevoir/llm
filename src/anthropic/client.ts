import Anthropic from '@anthropic-ai/sdk';
import { resolveBaseUrl } from '../index.js';

// Internal auth/client module for the Anthropic adapter: credential resolution,
// client construction, and the session OAuth→API-key fallback. It is NOT in the
// package `exports` map, so nothing here — including the test-only reset — ships
// on the public `@verevoir/llm/anthropic` surface; the co-located tests import it
// directly. Its mutable state (the cached default client + the fallback latch) is
// module-private, encapsulated behind functions rather than exposed as an object.

// The cached default client, and the session OAuth→API-key fallback latch: a 401
// on a subscription token latches OAuth off for the rest of the process (auth
// does not change mid-session), so later calls skip it rather than re-hitting the
// same 401. Private — mutated only here, reset only via resetClientStateForTests.
let defaultClient: Anthropic | null = null;
let oauthDisabled = false;
let oauthFallbackWarned = false;

/** The `anthropic-beta` flag a Claude subscription token
 * (`CLAUDE_CODE_OAUTH_TOKEN`) must carry to be accepted on the Messages API —
 * the same credential the Claude Code CLI and the CI review action use.
 * Overridable via `ANTHROPIC_OAUTH_BETA` so an Anthropic change to the flag is a
 * config edit, not a code release. */
function oauthBetaHeader(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANTHROPIC_OAUTH_BETA?.trim() || 'oauth-2025-04-20';
}

/** The identity Anthropic requires as the FIRST system block when a request is
 * authenticated with a subscription OAuth token — the token is authorised only
 * for Claude-Code-shaped requests. Overridable via `ANTHROPIC_OAUTH_SYSTEM` for
 * resilience if the required string changes. Used by the adapter's buildRequest. */
export function oauthSystemIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ANTHROPIC_OAUTH_SYSTEM?.trim() ||
    "You are Claude Code, Anthropic's official CLI for Claude."
  );
}

/**
 * Resolve which Anthropic credential to use, in precedence order:
 *   1. an explicit per-call `apiKey` (BYOK);
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` — the subscription token, **preferred over the
 *      metered API key** so local review/generation runs on the subscription and
 *      does not burn `ANTHROPIC_API_KEY`;
 *   3. `ANTHROPIC_API_KEY`.
 * Returns null when none is set (the caller turns that into a clear error). The
 * returned token/key is for immediate client construction and is NEVER logged.
 */
function resolveAnthropicAuth(
  perCallApiKey: string | null,
  env: NodeJS.ProcessEnv = process.env
): { kind: 'apiKey'; apiKey: string } | { kind: 'oauth'; authToken: string } | null {
  if (perCallApiKey) return { kind: 'apiKey', apiKey: perCallApiKey };
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { kind: 'oauth', authToken: oauth };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: 'apiKey', apiKey };
  return null;
}

/** Construct an SDK client for a resolved credential. A subscription OAuth token
 * is sent as a bearer `authToken` with the required `anthropic-beta` header; an
 * API key is sent as `apiKey`. */
function buildClient(auth: NonNullable<ReturnType<typeof resolveAnthropicAuth>>): Anthropic {
  const baseURL = resolveBaseUrl('ANTHROPIC_BASE_URL');
  if (auth.kind === 'oauth') {
    // apiKey: null stops the SDK defaulting it from process.env.ANTHROPIC_API_KEY
    // and sending x-api-key beside the bearer token (which would bill the metered
    // key) — only the subscription token is sent.
    return new Anthropic({
      apiKey: null,
      authToken: auth.authToken,
      baseURL,
      defaultHeaders: { 'anthropic-beta': oauthBetaHeader() },
    });
  }
  // authToken: null so a stray ANTHROPIC_AUTH_TOKEN can't override an explicit key.
  return new Anthropic({ apiKey: auth.apiKey, authToken: null, baseURL });
}

/** Resolve the client for a call plus whether it authenticates with a
 * subscription OAuth token (which needs the Claude-Code system identity on every
 * request). The no-per-call-key client is cached (the common path); a BYOK
 * per-call key builds a fresh client and is never the OAuth path. Throws a clear
 * error when no credential is configured. */
export function resolveClient(perCallApiKey: string | null): {
  client: Anthropic;
  oauth: boolean;
} {
  let auth = resolveAnthropicAuth(perCallApiKey);
  if (!auth) {
    throw new Error(
      'No Anthropic credential: set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY, or pass a per-call apiKey.'
    );
  }
  // A prior 401 latched OAuth off — fall back to the metered key when present.
  if (auth.kind === 'oauth' && oauthDisabled) {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (apiKey) auth = { kind: 'apiKey', apiKey };
  }
  if (perCallApiKey) return { client: buildClient(auth), oauth: false };
  if (!defaultClient) defaultClient = buildClient(auth);
  return { client: defaultClient, oauth: auth.kind === 'oauth' };
}

/** A 401 from the Anthropic SDK — an authentication rejection (a rejected or
 * expired OAuth token, a missing/blocked Claude-Code identity, a bad key), as
 * opposed to a transient 429/5xx that the caller's retry ladder handles. A 403 is
 * deliberately EXCLUDED: it is authorization (permission denied on the org /
 * project), not a bad token, so it must not trigger the metered-key fallback. */
export function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  if ((err as { status?: number }).status === 401) return true;
  const message =
    typeof (err as { message?: string }).message === 'string'
      ? (err as { message: string }).message
      : '';
  return /\b401\b|authentication_error|invalid[ _-]?x-api-key|unauthorized/i.test(message);
}

/** Latch OAuth off after a 401 and warn ONCE — loudly, because the fallback
 * bills the metered key, the very cost the OAuth path exists to avoid. Never
 * silent: a user who set CLAUDE_CODE_OAUTH_TOKEN must SEE that it was rejected
 * and that spend has moved onto ANTHROPIC_API_KEY. Only the HTTP status is
 * emitted — never the error message or any token (secret-handling). */
export function noteOAuthRejected(err: unknown): void {
  oauthDisabled = true;
  defaultClient = null; // force a rebuild on the metered key
  if (oauthFallbackWarned) return;
  oauthFallbackWarned = true;
  const status = (err as { status?: number })?.status;
  process.stderr.write(
    `@verevoir/llm: CLAUDE_CODE_OAUTH_TOKEN was rejected${status ? ` (HTTP ${status})` : ''} — ` +
      `falling back to the metered ANTHROPIC_API_KEY. THIS BILLS YOUR API KEY. Check the token, ` +
      `and ANTHROPIC_OAUTH_BETA / ANTHROPIC_OAUTH_SYSTEM if Anthropic has changed the requirements.\n`
  );
}

/** Test seam: reset the cached client + the fallback latch between tests.
 * INTERNAL — imported directly by the co-located tests, never re-exported to
 * consumers, so it never appears on the package's public surface. */
export function resetClientStateForTests(): void {
  defaultClient = null;
  oauthDisabled = false;
  oauthFallbackWarned = false;
}
