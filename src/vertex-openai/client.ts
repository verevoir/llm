/**
 * Internal client module for the Vertex AI OpenAI-compatible route: where the
 * project and location come from, how the endpoint's URL is built, where the
 * access token comes from, and the one kept client. It is NOT in the package
 * `exports` map, so the test-only seam does not ship on the public
 * `@verevoir/llm/vertex-openai` surface; the co-located tests import it
 * directly. The two error classes are re-exported by `./index.js`.
 */

import OpenAI from 'openai';
import { GoogleAuth } from 'google-auth-library';

/** The environment variable holding the Google Cloud project id. */
export const PROJECT_ENV = 'GOOGLE_CLOUD_PROJECT';

/** The environment variable holding the Vertex AI location, e.g. `europe-west4`. */
export const LOCATION_ENV = 'GOOGLE_CLOUD_LOCATION';

/** The location used when {@link LOCATION_ENV} is unset or blank. */
export const DEFAULT_LOCATION = 'global';

/** The OAuth scope an access token for Vertex AI is asked for. */
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// Both values become part of the request URL, and the location becomes part of
// the HOST the bearer token is sent to. Neither is sent anywhere unless it is
// made only of characters that cannot change the host or leave the path.
const PROJECT_PATTERN = /^[a-z0-9][a-z0-9.:-]*$/;
const LOCATION_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** What a {@link VertexOpenAIConfigError} is about: an environment variable,
 * or one of the two call options this route has a rule for. */
export type VertexOpenAISetting = typeof PROJECT_ENV | typeof LOCATION_ENV | 'model' | 'apiKey';

/**
 * A call this route refused before anything was sent and before any access
 * token was asked for, because a setting is missing or cannot be used.
 * `setting` names it; the message names it too and never repeats a value.
 */
export class VertexOpenAIConfigError extends Error {
  override name = 'VertexOpenAIConfigError';
  constructor(
    readonly setting: VertexOpenAISetting,
    message: string
  ) {
    super(message);
  }
}

/**
 * No Google Cloud access token could be obtained, so no request was sent. The
 * message is fixed: it holds no text from the credentials library. Whatever
 * that library threw is on `cause`, untouched; `cause` is absent when the
 * library answered without a token. Carries no `status`: the endpoint was
 * never asked, so this is not the endpoint's answer.
 */
export class VertexOpenAITokenError extends Error {
  override name = 'VertexOpenAITokenError';
  constructor(options?: ErrorOptions) {
    super(
      'Could not obtain a Google Cloud access token for Vertex AI. No request was sent.',
      options
    );
  }
}

/** Where an access token comes from. Called before every request. */
export type TokenSource = () => Promise<string | null | undefined>;

/** The credentials object. Built on first use, never at import: importing the
 * subpath looks for no credential. */
let googleAuth: GoogleAuth | null = null;

/** The real token source. The library keeps the token it holds and replaces
 * it shortly before it expires, so asking before every request costs a
 * network round trip only when the token is due. */
const googleTokenSource: TokenSource = () => {
  googleAuth ??= new GoogleAuth({ scopes: SCOPE });
  return googleAuth.getAccessToken();
};

/** What a test may replace: the token source, and the `fetch` the client uses. */
export interface TransportForTests {
  tokenSource?: TokenSource;
  fetch?: typeof fetch;
}
let seam: TransportForTests = {};

/** The token for one request. The OpenAI SDK calls this before every request
 * it sends, so the token is asked for before each request the adapter makes,
 * an adapter retry included. The SDK makes no retry of its own on this client
 * (see `maxRetries` in {@link resolveClient}). */
async function accessToken(): Promise<string> {
  let token: string | null | undefined;
  try {
    token = await (seam.tokenSource ?? googleTokenSource)();
  } catch (cause) {
    throw new VertexOpenAITokenError({ cause });
  }
  if (typeof token !== 'string' || token === '') throw new VertexOpenAITokenError();
  return token;
}

/** The endpoint's base URL; the SDK appends `/chat/completions`. The `global`
 * location is served by the plain host, every other by its regional host. */
export function baseUrlFor(project: string, location: string): string {
  const host =
    location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

// The client for the current project + location. Rebuilt when either changes.
// It holds no credential of its own: the token is asked for on every request.
let kept: { project: string; location: string; client: OpenAI } | null = null;

/**
 * The client for a call. Refuses, before anything is built, sent or asked of
 * the token source: a per-call API key (this route has none), a missing
 * project, and a project or location that is not a plain identifier.
 */
export function resolveClient(perCallApiKey: string | null): OpenAI {
  if (perCallApiKey) {
    throw new VertexOpenAIConfigError(
      'apiKey',
      'Vertex AI takes no API key: it authenticates with Google Cloud credentials. Remove the per-call apiKey.'
    );
  }
  const project = process.env[PROJECT_ENV]?.trim();
  if (!project) {
    throw new VertexOpenAIConfigError(PROJECT_ENV, `No Vertex AI project: set ${PROJECT_ENV}.`);
  }
  if (!PROJECT_PATTERN.test(project)) {
    throw new VertexOpenAIConfigError(
      PROJECT_ENV,
      `${PROJECT_ENV} is not a Google Cloud project id.`
    );
  }
  const location = process.env[LOCATION_ENV]?.trim() || DEFAULT_LOCATION;
  if (!LOCATION_PATTERN.test(location)) {
    throw new VertexOpenAIConfigError(LOCATION_ENV, `${LOCATION_ENV} is not a Vertex AI location.`);
  }
  if (kept?.project !== project || kept.location !== location) {
    const client = new OpenAI({
      apiKey: accessToken,
      baseURL: baseUrlFor(project, location),
      // Explicit nulls: otherwise the SDK reads OPENAI_ORG_ID and
      // OPENAI_PROJECT_ID and sends each as a header on every request.
      organization: null,
      project: null,
      // `callWithRetries` in `../retry-policy.js` already retries each
      // request; the SDK's own retries are off so that policy is the only one.
      maxRetries: 0,
      fetch: seam.fetch,
    });
    kept = { project, location, client };
  }
  return kept.client;
}

/** If `err` is, or wraps, this route's token failure, that failure. The SDK
 * wraps whatever its `apiKey` function throws in an error of its own, with
 * the original as `cause`. */
export function tokenFailureIn(err: unknown): VertexOpenAITokenError | undefined {
  if (err instanceof VertexOpenAITokenError) return err;
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof VertexOpenAITokenError ? cause : undefined;
}

/** Test seam: replace the token source and/or `fetch`, and drop the kept
 * client and credentials object. Call with no argument to restore the real
 * ones. INTERNAL — imported directly by the co-located tests, never
 * re-exported to consumers. */
export function setTransportForTests(next: TransportForTests = {}): void {
  seam = next;
  kept = null;
  googleAuth = null;
}
