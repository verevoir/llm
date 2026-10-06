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
import { PROVIDER, CATALOG, BASE_URL } from './catalog.js';

export { PROVIDER, BASE_URL };

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
