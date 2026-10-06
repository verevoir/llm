/**
 * @verevoir/llm/samba's model catalogue — PURE DATA, no SDK import.
 *
 * Split out of `./index.ts` (STDIO — "catalog without the SDK") so a consumer
 * that only wants to RESOLVE a model term never has to import `openai` (the
 * SDK `./index.ts` uses to actually call SambaNova's OpenAI-compatible
 * endpoint) just to read this array. `./index.ts` still imports this file and
 * registers it exactly as before. See `../catalog.ts` for the SDK-free
 * registration entry point this file exists to serve.
 *
 * Model ids verified against the live SambaNova `/models` catalogue (2026-06):
 * it hosts a small rotating set (Llama-3.3-70B, DeepSeek-V3.x, gpt-oss, gemma,
 * MiniMax). Defaults: reasoning → Llama-3.3-70B, extraction → DeepSeek-V3.2
 * (both tool-capable). Pricing is approximate worst-case USD/Mtok; refresh when
 * SambaNova republishes. Decisions key on provider/family, so the exact id is
 * reporting metadata and a new V3 point-release still normalises via the prefix.
 */

import type { ModelCatalogEntry, ProviderConnection } from '../index.js';

export const PROVIDER = 'samba';

/** SambaNova's OpenAI-compatible base URL. */
export const BASE_URL = 'https://api.sambanova.ai/v1';

// Pure data — see src/anthropic/catalog.ts's CONNECTION comment for why this
// is registered both here and by ../catalog.ts.
export const CONNECTION: ProviderConnection = {
  provider: PROVIDER,
  apiKeyEnv: 'SAMBA_NOVA_API_KEY',
  baseUrlEnv: 'SAMBA_NOVA_BASE_URL',
  defaultBaseUrl: BASE_URL,
};

export const CATALOG: ModelCatalogEntry[] = [
  {
    provider: PROVIDER,
    family: 'llama-70b',
    modelClass: 'reasoning',
    currentId: 'Meta-Llama-3.3-70B-Instruct',
    rates: [0.6, 1.2],
    label: 'Llama 3.3 70B',
    prefixes: ['Meta-Llama-3.3-70B'],
  },
  {
    provider: PROVIDER,
    family: 'deepseek-v3',
    modelClass: 'extraction',
    currentId: 'DeepSeek-V3.2',
    rates: [0.6, 1.5],
    label: 'DeepSeek V3.2',
    prefixes: ['DeepSeek-V3'],
  },
];
