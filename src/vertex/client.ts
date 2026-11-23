import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { AnthropicTransport } from '../anthropic/adapter.js';

// Internal client module for the Vertex route: where the project and region
// come from, and the one kept client. It is NOT in the package `exports` map, so
// nothing here — including the test-only reset — ships on the public
// `@verevoir/llm/vertex` surface; the co-located tests import it directly.

/** The environment variable holding the Google Cloud project id. */
const PROJECT_ENV = 'ANTHROPIC_VERTEX_PROJECT_ID';

/** The environment variable holding the Vertex AI region, e.g. `global`. */
const REGION_ENV = 'CLOUD_ML_REGION';

// The client for the current project + region, kept so the Vertex SDK's own
// credential and token cache is reused across calls. Rebuilt when either
// setting changes. Private — reset only via resetClientForTests.
let kept: { projectId: string; region: string; client: AnthropicVertex } | null = null;

/**
 * The client for a call. Refuses, before anything is built or sent, a per-call
 * API key (this route has none) and a missing project or region, each with a
 * plain error that names the setting and never a value. Authentication itself
 * is left wholly to the Vertex SDK: Google Cloud's standard credentials flow.
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
  if (kept?.projectId !== projectId || kept.region !== region) {
    kept = { projectId, region, client: new AnthropicVertex({ projectId, region }) };
  }
  return { client: kept.client, route: 'google-cloud', oauth: false };
};

/** Test seam: drop the kept client between tests. INTERNAL — imported directly
 * by the co-located tests, never re-exported to consumers. */
export function resetClientForTests(): void {
  kept = null;
}
