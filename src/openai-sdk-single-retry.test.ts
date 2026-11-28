/**
 * The adapters that send through the `openai` SDK retry at one layer only: the
 * library's own policy, which retries what the SDK's own rule retries, and
 * which each adapter hands its caller's `abortSignal`. Each test counts the
 * requests that reach `fetch`, with the real SDK in between, so a retry the
 * SDK made on its own would be counted too. (The adapters' other tests
 * replace the SDK's `create`, and so cannot see what the SDK does beneath it.)
 *
 * Two SDK paths are here: the OpenAI-compatible factory over Chat Completions
 * (`/samba`, `/mistral`), and `/openai` over the Responses API. One site of
 * each runs every row of the driver; every other site and call shape runs
 * the rows a site can break on its own. `/deepseek` builds its own client and
 * call over Chat Completions, so it is sites of the factory's path.
 */

import { beforeEach, describe } from 'vitest';
import OpenAI from 'openai';
import type { ToolDef } from './index.js';
import * as deepseek from './deepseek/index.js';
import * as mistral from './mistral/index.js';
import * as openai from './openai/index.js';
import * as samba from './samba/index.js';
import {
  isolateEnv,
  json,
  pathRows,
  siteRows,
  useFakeFetch,
  type Call,
  type Extra,
  type Site,
} from './test-support/fetch-driver.js';

/** A Chat Completions answer in text, with no tool call. */
const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** A Responses API answer in text. */
const RESPONSE = {
  id: 'resp_1',
  object: 'response',
  model: 'm',
  status: 'completed',
  output: [
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'ok', annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const BASE = { systemPrompt: 'sys', turns: [{ role: 'user' as const, content: 'hi' }] };
const TOOL: ToolDef = {
  name: 'lookup',
  description: 'Look something up',
  input_schema: { type: 'object', properties: {} },
};

/** The three call shapes of an adapter built by the OpenAI-compatible factory. */
const factoryShapes = (a: typeof samba | typeof mistral): [string, Call][] => [
  ['chat', async (extra) => (await a.chat({ ...BASE, ...extra })).content],
  [
    'chatWithTools',
    async (extra) => (await a.chatWithTools({ ...BASE, ...extra, tools: [TOOL] })).text,
  ],
  [
    'chatWithToolLoop',
    async (extra) =>
      (
        await a.chatWithToolLoop({
          ...BASE,
          ...extra,
          tools: [TOOL],
          executor: async () => 'looked up',
        })
      ).text,
  ],
];

const ADAPTERS: { name: string; keyEnv: string; ok: unknown; shapes: [string, Call][] }[] = [
  { name: 'samba', keyEnv: 'SAMBA_NOVA_API_KEY', ok: COMPLETION, shapes: factoryShapes(samba) },
  { name: 'mistral', keyEnv: 'MISTRAL_API_KEY', ok: COMPLETION, shapes: factoryShapes(mistral) },
  {
    name: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    ok: COMPLETION,
    shapes: [['chat', async (extra) => (await deepseek.chat({ ...BASE, ...extra })).content]],
  },
  {
    name: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    ok: RESPONSE,
    shapes: [['chat', async (extra) => (await openai.chat({ ...BASE, ...extra })).content]],
  },
];

/** Each adapter builds a client in two places: one per call for a per-call
 * key, and one kept for the key in the environment. Both are covered. */
const KEYS: [string, Extra][] = [
  ['a per-call key', { apiKey: 'per-call-key' }],
  ['the environment key', {}],
];

/** The site that stands for each SDK path. */
const PATHS = ['samba.chat with the environment key', 'openai.chat with the environment key'];

const CASES = ADAPTERS.flatMap(({ name, ok, shapes }) =>
  shapes.flatMap(([shape, call]) =>
    KEYS.map(([keyName, key]) => {
      const title = `${name}.${shape} with ${keyName}`;
      const site: Site = {
        call,
        key,
        refusal: (status, headers) => json({ error: { message: 'refused' } }, status, headers),
        answer: () => json(ok, 200),
        text: 'ok',
        timeoutMs: OpenAI.DEFAULT_TIMEOUT,
      };
      return { title, site, path: PATHS.includes(title) };
    })
  )
);

useFakeFetch();
isolateEnv([
  ...ADAPTERS.map((a) => a.keyEnv),
  'SAMBA_NOVA_BASE_URL',
  'MISTRAL_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT_ID',
]);

// Each adapter keeps its environment-key client for the life of the module,
// so the key it is built with is the same in every test.
beforeEach(() => {
  for (const { keyEnv } of ADAPTERS) process.env[keyEnv] = 'environment-key';
});

describe.each(CASES)('$title: the library retry policy is the only one', ({ site, path }) => {
  if (path) pathRows(site, { recoversFrom: [504] });
  else siteRows(site);
});
