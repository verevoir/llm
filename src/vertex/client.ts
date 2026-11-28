import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { AnthropicTransport } from '../anthropic/adapter.js';
import { resolveBaseUrl } from '../index.js';

// Internal client module for the Vertex route: where the project, region,
// address and token come from, and the one kept client. It is NOT in the
// package `exports` map, so nothing here — including the test-only reset —
// ships on the public `@verevoir/llm/vertex` surface; the co-located tests
// import it directly.

/** The environment variable holding the Google Cloud project id. */
const PROJECT_ENV = 'ANTHROPIC_VERTEX_PROJECT_ID';

/** The environment variable holding the Vertex AI region, e.g. `global`. */
const REGION_ENV = 'CLOUD_ML_REGION';

/** The environment variable holding the address requests go to, version
 * segment included, e.g. `https://gateway.example/v1`. The Vertex SDK's own name. */
const BASE_URL_ENV = 'ANTHROPIC_VERTEX_BASE_URL';

/** The environment variable holding a fixed bearer token. When it is set, no
 * Google Cloud credential is looked for. */
const ACCESS_TOKEN_ENV = 'ANTHROPIC_VERTEX_ACCESS_TOKEN';

type VertexAuthClient = NonNullable<
  NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>['authClient']
>;

/**
 * An auth client that gives every request exactly one header, the bearer
 * token. The Vertex SDK reads two things from its `authClient`:
 * `googleAuthHeaders = await authClient.getRequestHeaders();` and
 * `authClient.projectId ?? googleAuthHeaders.get('x-goog-user-project')`, which
 * it uses only when no project was given; here one always is. The token is held
 * in the closure, not on the object, so serialising the object never shows it.
 */
function fixedTokenAuth(token: string): VertexAuthClient {
  return {
    getRequestHeaders: async () => new Headers({ authorization: `Bearer ${token}` }),
  } as unknown as VertexAuthClient;
}

interface Settings {
  projectId: string;
  region: string;
  baseURL: string | undefined;
  accessToken: string | undefined;
}

// The client for the current settings, kept so the Vertex SDK's own credential
// and token cache is reused across calls. Rebuilt when any of the four
// settings changes. Private — reset only via resetClientForTests.
let kept: (Settings & { client: AnthropicVertex }) | null = null;

const sameSettings = (a: Settings, b: Settings): boolean =>
  a.projectId === b.projectId &&
  a.region === b.region &&
  a.baseURL === b.baseURL &&
  a.accessToken === b.accessToken;

/**
 * The client for a call. Refuses, before anything is built or sent, a per-call
 * API key (this route has none) and a missing project or region, each with a
 * plain error that names the setting and never a value. With
 * `ANTHROPIC_VERTEX_ACCESS_TOKEN` set, every request carries that token as its
 * bearer header and no Google Cloud credential is looked for; otherwise
 * authentication is left wholly to the Vertex SDK: Google Cloud's standard
 * credentials flow. `ANTHROPIC_VERTEX_BASE_URL` is read as the library's other
 * base-address overrides are, through `resolveBaseUrl`, with no check of its form.
 */
export const resolveClient: AnthropicTransport['resolveClient'] = (perCallApiKey) => {
  if (perCallApiKey) {
    throw new Error(
      'Vertex AI takes no API key: it authenticates with Google Cloud credentials. Remove the per-call apiKey.'
    );
  }
  const projectId = process.env[PROJECT_ENV]?.trim();
  if (!projectId) throw new Error(`No Vertex AI project: set ${PROJECT_ENV}.`);
  const region = process.env[REGION_ENV]?.trim();
  if (!region) throw new Error(`No Vertex AI region: set ${REGION_ENV}.`);
  const settings: Settings = {
    projectId,
    region,
    baseURL: resolveBaseUrl(BASE_URL_ENV),
    accessToken: process.env[ACCESS_TOKEN_ENV]?.trim() || undefined,
  };
  if (!kept || !sameSettings(kept, settings)) {
    // maxRetries: 0 turns the SDK's own retries off: the library's retry policy,
    // applied in the shared adapter, is the only retry a request gets.
    const client = new AnthropicVertex({
      projectId,
      region,
      maxRetries: 0,
      ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      ...(settings.accessToken ? { authClient: fixedTokenAuth(settings.accessToken) } : {}),
    });
    kept = { ...settings, client };
  }
  return { client: kept.client, route: 'google-cloud' };
};

/** Test seam: drop the kept client between tests. INTERNAL — imported directly
 * by the co-located tests, never re-exported to consumers. */
export function resetClientForTests(): void {
  kept = null;
}
