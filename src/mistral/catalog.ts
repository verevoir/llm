/**
 * @verevoir/llm/mistral's model catalogue — PURE DATA, no SDK import.
 *
 * Split out of `./index.ts` (STDIO — "catalog without the SDK") so a consumer
 * that only wants to RESOLVE a model term never has to import `openai` (the
 * SDK `./index.ts` uses to actually call Mistral's OpenAI-compatible endpoint)
 * just to read this array. `./index.ts` still imports this file and registers
 * it exactly as before. See `../catalog.ts` for the SDK-free registration
 * entry point this file exists to serve.
 *
 * Decisions key on provider/family (STDIO-332); the `-latest` aliases are the
 * stable current ids, so a version bump is a one-line change. Pricing is
 * approximate Mistral-published USD/Mtok (worst-case input rate), 2026-06;
 * refresh when Mistral republishes.
 */

import type { ModelCatalogEntry, ProviderConnection } from '../index.js';

export const PROVIDER = 'mistral';

/** Mistral's OpenAI-compatible base URL. */
export const BASE_URL = 'https://api.mistral.ai/v1';

// Pure data — see src/anthropic/catalog.ts's CONNECTION comment for why this
// is registered both here and by ../catalog.ts.
export const CONNECTION: ProviderConnection = {
  provider: PROVIDER,
  apiKeyEnv: 'MISTRAL_API_KEY',
  baseUrlEnv: 'MISTRAL_BASE_URL',
  defaultBaseUrl: BASE_URL,
};

export const CATALOG: ModelCatalogEntry[] = [
  {
    provider: PROVIDER,
    family: 'large',
    modelClass: 'reasoning',
    currentId: 'mistral-large-latest',
    rates: [2, 6],
    label: 'Mistral Large',
    prefixes: ['mistral-large'],
  },
  {
    provider: PROVIDER,
    family: 'small',
    modelClass: 'extraction',
    currentId: 'mistral-small-latest',
    rates: [0.2, 0.6],
    label: 'Mistral Small',
    prefixes: ['mistral-small'],
  },
];
