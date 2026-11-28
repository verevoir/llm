/**
 * The adapters that send through the `openai` SDK retry at one layer only: the
 * library's own policy, which retries what the SDK's own rule retries, and
 * which each adapter hands its caller's `abortSignal`. Each test counts the
 * requests that reach `fetch`, with the real SDK in between, so a retry the
 * SDK made on its own would be counted too. (The adapters' other tests
 * replace the SDK's `create`, and so cannot see what the SDK does beneath it.)
 *
 * Two SDK paths are here: the OpenAI-compatible factory over Chat Completions
 * (`/samba`, `/mistral`), and `/openai` over the Responses API. The full-row
 * site of each, marked by `fullRows` on its adapter, runs every row of the
 * driver; every other site and call shape runs the rows a site can break on
 * its own. `/deepseek` builds its own client and
 * call over Chat Completions, so it is sites of the factory's path.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import type { ToolDef } from './index.js';
import * as deepseek from './deepseek/index.js';
import * as mistral from './mistral/index.js';
import * as openai from './openai/index.js';
import { RETRY_BACKOFFS_MS } from './retry-policy.js';
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

type Shape = 'chat' | 'chatWithTools' | 'chatWithToolLoop';

/** The three call shapes of an adapter built by the OpenAI-compatible factory. */
const factoryShapes = (a: typeof samba | typeof mistral): Record<Shape, Call> => ({
  chat: async (extra) => (await a.chat({ ...BASE, ...extra })).content,
  chatWithTools: async (extra) =>
    (await a.chatWithTools({ ...BASE, ...extra, tools: [TOOL] })).text,
  chatWithToolLoop: async (extra) =>
    (
      await a.chatWithToolLoop({
        ...BASE,
        ...extra,
        tools: [TOOL],
        executor: async () => 'looked up',
      })
    ).text,
});

/** Each adapter builds a client in two places: one per call for a per-call
 * key, and one kept for the key in the environment. Both are covered. */
const KEYS = {
  perCall: ['a per-call key', { apiKey: 'per-call-key' }],
  environment: ['the environment key', {}],
} as const satisfies Record<string, readonly [string, Extra]>;

/** The SDK paths here: the OpenAI-compatible factory over Chat Completions,
 * and `/openai` over the Responses API. */
const SDK_PATHS = ['Chat Completions', 'Responses'] as const;

/** `fullRows` names the call shape and key that are the adapter's SDK path's
 * full-row site. */
const ADAPTERS: {
  name: string;
  sdkPath: (typeof SDK_PATHS)[number];
  keyEnv: string;
  ok: unknown;
  shapes: Partial<Record<Shape, Call>>;
  fullRows?: { shape: Shape; key: keyof typeof KEYS };
}[] = [
  {
    name: 'samba',
    sdkPath: 'Chat Completions',
    keyEnv: 'SAMBA_NOVA_API_KEY',
    ok: COMPLETION,
    shapes: factoryShapes(samba),
    fullRows: { shape: 'chat', key: 'environment' },
  },
  {
    name: 'mistral',
    sdkPath: 'Chat Completions',
    keyEnv: 'MISTRAL_API_KEY',
    ok: COMPLETION,
    shapes: factoryShapes(mistral),
  },
  {
    name: 'deepseek',
    sdkPath: 'Chat Completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    ok: COMPLETION,
    shapes: { chat: async (extra) => (await deepseek.chat({ ...BASE, ...extra })).content },
  },
  {
    name: 'openai',
    sdkPath: 'Responses',
    keyEnv: 'OPENAI_API_KEY',
    ok: RESPONSE,
    shapes: { chat: async (extra) => (await openai.chat({ ...BASE, ...extra })).content },
    fullRows: { shape: 'chat', key: 'environment' },
  },
];

const CASES = ADAPTERS.flatMap(({ name, sdkPath, ok, shapes, fullRows }) =>
  Object.entries(shapes).flatMap(([shape, call]) =>
    Object.entries(KEYS).map(([keyId, [keyName, key]]) => {
      const site: Site = {
        call,
        key,
        refusal: (status, headers) => json({ error: { message: 'refused' } }, status, headers),
        answer: () => json(ok, 200),
        text: 'ok',
        timeoutMs: OpenAI.DEFAULT_TIMEOUT,
      };
      return {
        title: `${name}.${shape} with ${keyName}`,
        sdkPath,
        site,
        fullRows: shape === fullRows?.shape && keyId === fullRows.key,
      };
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

it('the policy allows at least one retry, so no count the rows make is vacuous', () => {
  expect(RETRY_BACKOFFS_MS.length).toBeGreaterThan(0);
});

it.each(SDK_PATHS)('the %s SDK path has exactly one full-row site', (sdkPath) => {
  expect(CASES.filter((c) => c.sdkPath === sdkPath && c.fullRows)).toHaveLength(1);
});

describe.each(CASES)('$title: the library retry policy is the only one', ({ site, fullRows }) => {
  if (fullRows) pathRows(site, { recoversFrom: [504] });
  else siteRows(site);
});
