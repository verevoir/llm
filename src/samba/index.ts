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
import { PROVIDER, CATALOG, BASE_URL } from './catalog.js';

export { PROVIDER, BASE_URL };

const adapter = createOpenAICompatAdapter({
  provider: PROVIDER,
  baseURL: BASE_URL,
  baseUrlEnv: 'SAMBA_NOVA_BASE_URL',
  apiKeyEnv: 'SAMBA_NOVA_API_KEY',
  catalog: CATALOG,
});

export const models = adapter.models;
export const rates = adapter.rates;
export const chat = adapter.chat;
export const chatWithTools = adapter.chatWithTools;
export const chatWithToolLoop = adapter.chatWithToolLoop;

/** Namespaced form for callers that prefer `samba.chat(...)`. */
export const samba = adapter;
