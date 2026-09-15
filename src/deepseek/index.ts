/**
 * @verevoir/llm/deepseek — DeepSeek adapter (OpenAI-compatible).
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions API, so this adapter
 * is built from the shared {@link createOpenAICompatAdapter} factory — a base
 * URL, key env var, and a model catalogue — the same factory `/samba` and
 * `/mistral` are built from. Importing this subpath requires `openai` as a
 * peer dependency (the same one `/openai` uses). Auth via `DEEPSEEK_API_KEY`
 * (or a per-call `apiKey`).
 *
 * Ships `chat()`, `chatWithTools()` and `chatWithToolLoop()` — full parity
 * with Anthropic, Gemini, SambaNova and Mistral, all via the factory. This
 * adapter previously duplicated the factory's Chat Completions logic by hand,
 * `chat()`-only, and carried a cached-token double-count the factory itself
 * fixed under STDIO-487 (`inputTokens` included the cached subset instead of
 * excluding it) — adopting the factory here both closes the tool-calling gap
 * and picks up that fix as a consequence, not a separate change.
 */

import { createOpenAICompatAdapter } from '../openai-compat.js';
import type { ModelCatalogEntry } from '../index.js';

/** Provider id reported on every TokenUsage this adapter returns. */
export const PROVIDER = 'deepseek';

/** DeepSeek's OpenAI-compatible endpoint. */
export const BASE_URL = 'https://api.deepseek.com';

// Model catalogue — decisions key on provider/family (STDIO-332). DeepSeek's
// two model lines are distinct families, not versions of one: `reasoner`
// (the R1-style reasoning model) and `chat` (the general V3 model, used for
// fast/cheap structured extraction) — mirroring the Anthropic catalog's
// multi-family shape rather than a single-family tier ladder. Pricing is
// DeepSeek-published standard (cache-miss) rates as of 2026-05-26; refresh
// when DeepSeek republishes.
const CATALOG: ModelCatalogEntry[] = [
  {
    provider: PROVIDER,
    family: 'reasoner',
    modelClass: 'reasoning',
    currentId: 'deepseek-reasoner',
    rates: [0.55, 2.19],
    label: 'DeepSeek Reasoner',
    prefixes: ['deepseek-reasoner'],
  },
  {
    provider: PROVIDER,
    family: 'chat',
    modelClass: 'extraction',
    currentId: 'deepseek-chat',
    rates: [0.27, 1.1],
    label: 'DeepSeek Chat',
    prefixes: ['deepseek-chat'],
  },
];

const adapter = createOpenAICompatAdapter({
  provider: PROVIDER,
  baseURL: BASE_URL,
  baseUrlEnv: 'DEEPSEEK_BASE_URL',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  catalog: CATALOG,
});

export const models = adapter.models;
export const rates = adapter.rates;
export const chat = adapter.chat;
export const chatWithTools = adapter.chatWithTools;
export const chatWithToolLoop = adapter.chatWithToolLoop;

/** Namespaced form for callers that prefer `deepseek.chat(...)`. */
export const deepseek = adapter;
