/**
 * @verevoir/llm/samba — SambaNova adapter (OpenAI-compatible).
 *
 * SambaNova serves open models behind an OpenAI-compatible Chat Completions
 * API, so this adapter is built from the shared {@link createOpenAICompatAdapter}
 * factory. Importing this subpath requires `openai` as a peer dependency. Auth
 * via `SAMBA_NOVA_API_KEY` (or a per-call `apiKey`). Ships `chat()` only.
 *
 * SambaNova hosts a rotating catalogue of open models; the ids + pricing below
 * are sensible defaults — verify against the current SambaNova catalogue. Since
 * decisions key on `provider/family` (STDIO-332), the exact version id is
 * reporting metadata, and a new version of a listed family still normalises via
 * its prefix.
 */

import { createOpenAICompatAdapter } from '../openai-compat.js';
import type { ModelCatalogEntry } from '../index.js';

/** Provider id reported on every TokenUsage this adapter returns. */
export const PROVIDER = 'samba';

/** SambaNova's OpenAI-compatible base URL. */
export const BASE_URL = 'https://api.sambanova.ai/v1';

// Pricing is approximate SambaNova-published USD/Mtok (worst-case input rate),
// 2026-06; refresh when SambaNova republishes.
const CATALOG: ModelCatalogEntry[] = [
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
    family: 'llama-8b',
    modelClass: 'extraction',
    currentId: 'Meta-Llama-3.1-8B-Instruct',
    rates: [0.1, 0.2],
    label: 'Llama 3.1 8B',
    prefixes: ['Meta-Llama-3.1-8B'],
  },
];

const adapter = createOpenAICompatAdapter({
  provider: PROVIDER,
  baseURL: BASE_URL,
  apiKeyEnv: 'SAMBA_NOVA_API_KEY',
  catalog: CATALOG,
});

export const models = adapter.models;
export const rates = adapter.rates;
export const chat = adapter.chat;

/** Namespaced form for callers that prefer `samba.chat(...)`. */
export const samba = adapter;
