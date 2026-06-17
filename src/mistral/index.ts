/**
 * @verevoir/llm/mistral — Mistral adapter (OpenAI-compatible).
 *
 * Mistral exposes an OpenAI-compatible Chat Completions API, so this adapter is
 * built from the shared {@link createOpenAICompatAdapter} factory — a base URL,
 * key env var, and a model catalogue. Importing this subpath requires `openai`
 * as a peer dependency (the same one `/openai` + `/deepseek` use). Auth via
 * `MISTRAL_API_KEY` (or a per-call `apiKey`). Ships `chat()` only.
 */

import { createOpenAICompatAdapter } from '../openai-compat.js';
import type { ModelCatalogEntry } from '../index.js';

/** Provider id reported on every TokenUsage this adapter returns. */
export const PROVIDER = 'mistral';

/** Mistral's OpenAI-compatible base URL. */
export const BASE_URL = 'https://api.mistral.ai/v1';

// Model catalogue — decisions key on provider/family (STDIO-332); the `-latest`
// aliases are the stable current ids, so a version bump is a one-line change.
// Pricing is approximate Mistral-published USD/Mtok (worst-case input rate),
// 2026-06; refresh when Mistral republishes.
const CATALOG: ModelCatalogEntry[] = [
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

const adapter = createOpenAICompatAdapter({
  provider: PROVIDER,
  baseURL: BASE_URL,
  baseUrlEnv: 'MISTRAL_BASE_URL',
  apiKeyEnv: 'MISTRAL_API_KEY',
  catalog: CATALOG,
});

export const models = adapter.models;
export const rates = adapter.rates;
export const chat = adapter.chat;
export const chatWithTools = adapter.chatWithTools;
export const chatWithToolLoop = adapter.chatWithToolLoop;

/** Namespaced form for callers that prefer `mistral.chat(...)`. */
export const mistral = adapter;
