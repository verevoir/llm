import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every provider SDK is faked at its constructor, as each adapter's own tests
// fake it, so one table can drive every adapter through its exported calls.
const anthropicStream = vi.fn();
const compatCreate = vi.fn();
const responsesCreate = vi.fn();
const generateContent = vi.fn();
const spawn = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: anthropicStream };
  },
}));
vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class {
    messages = { stream: anthropicStream };
  },
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: compatCreate } };
    responses = { create: responsesCreate };
  },
}));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));
vi.mock('node:child_process', () => ({ spawn: (...a: unknown[]) => spawn(...a) }));

import * as anthropic from './anthropic/index.js';
import * as vertex from './vertex/index.js';
import * as claudeCli from './claude-cli/index.js';
import * as samba from './samba/index.js';
import * as mistral from './mistral/index.js';
import * as vertexOpenAI from './vertex-openai/index.js';
import * as deepseek from './deepseek/index.js';
import * as google from './google/index.js';
import * as openai from './openai/index.js';
import { EmptyResponseError, type ChatOptions, type StopKind, type ToolDef } from './index.js';

/** What one fake reply carries: the provider's word, `incomplete_details.reason`
 * on `/openai`, whether it has text, and whether it calls a tool. */
interface Reply {
  word?: string;
  reason?: string;
  text?: boolean;
  calls?: boolean;
}

const TOOL: ToolDef = {
  name: 'lookup',
  description: 'd',
  input_schema: { type: 'object', properties: {} },
};
const USAGE = { input_tokens: 1, output_tokens: 1 };

function anthropicReply(r: Reply) {
  const content = [
    ...(r.text === false ? [] : [{ type: 'text', text: 'ok' }]),
    ...(r.calls ? [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] : []),
  ];
  const message = { id: 'msg', model: 'm', content, stop_reason: r.word, usage: USAGE };
  anthropicStream.mockReturnValue({ on: () => {}, finalMessage: async () => message });
}

function compatReply(r: Reply) {
  const tool_calls = r.calls
    ? [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
    : undefined;
  compatCreate.mockResolvedValue({
    id: 'c',
    model: 'm',
    choices: [
      { message: { content: r.text === false ? '' : 'ok', tool_calls }, finish_reason: r.word },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

function responsesReply(r: Reply) {
  responsesCreate.mockResolvedValue({
    id: 'resp',
    model: 'm',
    output_text: r.text === false ? '' : 'ok',
    status: r.word,
    incomplete_details: r.reason === undefined ? null : { reason: r.reason },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function googleReply(r: Reply) {
  generateContent.mockResolvedValue({
    text: r.text === false ? '' : 'ok',
    candidates: [{ finishReason: r.word, content: { role: 'model', parts: [] } }],
    functionCalls: r.calls ? [{ name: 'lookup', args: {} }] : undefined,
    usageMetadata: {},
  });
}

function cliReply(r: Reply) {
  spawn.mockImplementation((_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: () => {}, end: () => {}, on: () => {} },
      kill: () => {},
    });
    const out = args.includes('--version')
      ? '2.1.0 (Claude Code)'
      : [
          { type: 'system', subtype: 'init', tools: [], mcp_servers: [] },
          { type: 'result', result: 'ok', stop_reason: r.word, usage: USAGE },
        ]
          .map((e) => JSON.stringify(e) + '\n')
          .join('');
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(out));
      child.emit('close', 0, null);
    });
    return child;
  });
}

const BASE: ChatOptions = {
  systemPrompt: 's',
  turns: [{ role: 'user', content: 'go' }],
  model: 'm',
};
const KEYED = { ...BASE, apiKey: 'k' };

interface Adapter {
  name: string;
  reply: (r: Reply) => void;
  chat: (o: ChatOptions) => Promise<{ stopReason: string; stopKind: StopKind }>;
  chatWithTools?: (
    o: ChatOptions & { tools: ToolDef[] }
  ) => Promise<{ stopReason: string; stopKind: StopKind }>;
  options: ChatOptions;
  /** Whether its `chat` throws {@link EmptyResponseError}. */
  throwsEmpty: boolean;
}

const ADAPTERS = {
  anthropic: {
    name: '/anthropic',
    reply: anthropicReply,
    ...anthropic,
    options: KEYED,
    throwsEmpty: true,
  },
  vertex: { name: '/vertex', reply: anthropicReply, ...vertex, options: BASE, throwsEmpty: true },
  claudeCli: {
    name: '/claude-cli',
    reply: cliReply,
    chat: claudeCli.chat,
    options: BASE,
    throwsEmpty: false,
  },
  samba: { name: '/samba', reply: compatReply, ...samba, options: KEYED, throwsEmpty: true },
  mistral: { name: '/mistral', reply: compatReply, ...mistral, options: KEYED, throwsEmpty: true },
  vertexOpenAI: {
    name: '/vertex-openai',
    reply: compatReply,
    ...vertexOpenAI,
    options: BASE,
    throwsEmpty: true,
  },
  deepseek: {
    name: '/deepseek',
    reply: compatReply,
    ...deepseek,
    options: KEYED,
    throwsEmpty: true,
  },
  google: { name: '/google', reply: googleReply, ...google, options: KEYED, throwsEmpty: true },
  openai: { name: '/openai', reply: responsesReply, ...openai, options: KEYED, throwsEmpty: true },
} satisfies Record<string, Adapter>;
const ALL: Adapter[] = Object.values(ADAPTERS);

/** The map, a row for each provider word: [word, kind], or
 * [status, incomplete reason, kind] on `/openai`. */
const ANTHROPIC_ROWS: [string, StopKind][] = [
  ['end_turn', 'finished'],
  ['max_tokens', 'max_tokens'],
  ['tool_use', 'tool_use'],
  ['stop_sequence', 'stop_sequence'],
  ['refusal', 'refused'],
  ['pause_turn', 'other'],
];
const COMPAT_ROWS: [string, StopKind][] = [
  ['stop', 'finished'],
  ['length', 'max_tokens'],
  ['tool_calls', 'tool_use'],
  ['function_call', 'tool_use'],
  ['content_filter', 'refused'],
];
const GOOGLE_ROWS: [string, StopKind][] = [
  ['STOP', 'finished'],
  ['MAX_TOKENS', 'max_tokens'],
  ...(
    ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'] as const
  ).map((w): [string, StopKind] => [w, 'refused']),
  ...(
    [
      'LANGUAGE',
      'OTHER',
      'MALFORMED_FUNCTION_CALL',
      'UNEXPECTED_TOOL_CALL',
      'TOO_MANY_TOOL_CALLS',
      'FINISH_REASON_UNSPECIFIED',
    ] as const
  ).map((w): [string, StopKind] => [w, 'other']),
];
const OPENAI_ROWS: [string, string | undefined, StopKind][] = [
  ['completed', undefined, 'finished'],
  ['incomplete', 'max_output_tokens', 'max_tokens'],
  ['incomplete', 'content_filter', 'refused'],
  ['incomplete', undefined, 'other'],
  ['incomplete', 'another', 'other'],
  ['failed', undefined, 'other'],
  ['cancelled', undefined, 'other'],
  ['in_progress', undefined, 'other'],
  ['queued', undefined, 'other'],
];

const rowsFor = (adapters: Adapter[], rows: [string, StopKind][]) =>
  adapters.flatMap((a) => rows.map(([word, kind]) => ({ a, reply: { word } as Reply, kind })));

const KIND_ROWS = [
  ...rowsFor([ADAPTERS.anthropic, ADAPTERS.vertex, ADAPTERS.claudeCli], ANTHROPIC_ROWS),
  ...rowsFor(
    [ADAPTERS.samba, ADAPTERS.mistral, ADAPTERS.vertexOpenAI, ADAPTERS.deepseek],
    COMPAT_ROWS
  ),
  ...rowsFor([ADAPTERS.google], GOOGLE_ROWS),
  ...OPENAI_ROWS.map(([word, reason, kind]) => ({
    a: ADAPTERS.openai as Adapter,
    reply: { word, reason },
    kind,
  })),
];

/** The word on each adapter whose kind is `max_tokens`: not `tool_use`, not
 * the `other` an error built without its second argument holds. */
const CUT_OFF: Record<string, Reply> = {
  '/anthropic': { word: 'max_tokens' },
  '/vertex': { word: 'max_tokens' },
  '/samba': { word: 'length' },
  '/mistral': { word: 'length' },
  '/vertex-openai': { word: 'length' },
  '/deepseek': { word: 'length' },
  '/google': { word: 'MAX_TOKENS' },
  '/openai': { word: 'incomplete', reason: 'max_output_tokens' },
};

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_VERTEX_PROJECT_ID', 'proj');
  vi.stubEnv('CLOUD_ML_REGION', 'global');
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'proj');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('stopKind', () => {
  it.each(
    KIND_ROWS.map((r) => ({
      ...r,
      name: r.a.name,
      label: [r.reply.word, r.reply.reason].filter(Boolean).join('/'),
    }))
  )('$name chat: $label is $kind, and stopReason is the word sent', async ({ a, reply, kind }) => {
    a.reply(reply);
    expect(await a.chat(a.options)).toMatchObject({ stopReason: reply.word, stopKind: kind });
  });

  it.each(ALL.filter((a) => a.chatWithTools).map((a) => ({ a, name: a.name })))(
    '$name chatWithTools reads the same map',
    async ({ a }) => {
      a.reply(CUT_OFF[a.name]);
      const result = await a.chatWithTools!({ ...a.options, tools: [TOOL] });
      expect(result).toMatchObject({ stopReason: CUT_OFF[a.name].word, stopKind: 'max_tokens' });
    }
  );

  it("/claude-cli chat: a result that names no stop reason keeps stopReason 'end_turn' and is other", async () => {
    ADAPTERS.claudeCli.reply({});
    expect(await ADAPTERS.claudeCli.chat(ADAPTERS.claudeCli.options)).toMatchObject({
      stopReason: 'end_turn',
      stopKind: 'other',
    });
  });

  it.each(ALL.flatMap((a) => ['invented_word', ''].map((word) => ({ a, name: a.name, word }))))(
    "$name chat: the unknown word '$word' is other, and nothing throws",
    async ({ a, word }) => {
      a.reply({ word });
      expect(await a.chat(a.options)).toMatchObject({ stopReason: word, stopKind: 'other' });
    }
  );

  it.each([
    { call: 'chat', calls: false, kind: 'finished' },
    { call: 'chat', calls: true, kind: 'tool_use' },
    { call: 'chatWithTools', calls: false, kind: 'finished' },
    { call: 'chatWithTools', calls: true, kind: 'tool_use' },
  ] as const)(
    '/google $call: STOP with function calls $calls is $kind',
    async ({ call, calls, kind }) => {
      googleReply({ word: 'STOP', calls });
      const result = await google[call]({ ...KEYED, tools: [TOOL] });
      expect(result).toMatchObject({ stopReason: 'STOP', stopKind: kind });
    }
  );

  // Its message, `name` and classification are held by each adapter's own test.
  it.each(ALL.filter((a) => a.throwsEmpty).map((a) => ({ a, name: a.name })))(
    '$name chat: an EmptyResponseError carries the word and its kind',
    async ({ a }) => {
      a.reply({ ...CUT_OFF[a.name], text: false });
      const err = await a.chat(a.options).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmptyResponseError);
      expect(err).toMatchObject({ stopReason: CUT_OFF[a.name].word, stopKind: 'max_tokens' });
    }
  );
});
