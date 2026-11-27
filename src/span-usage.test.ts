import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// Every provider SDK is mocked at its constructor, before any adapter is
// imported, so one file reaches every span every adapter reports. The
// claude-cli transport is mocked where its own tests mock it: the held
// session module and `node:child_process`.
const anthropicStream = vi.fn();
const vertexStream = vi.fn();
const chatCompletionsCreate = vi.fn();
const responsesCreate = vi.fn();
const generateContent = vi.fn();
const mockRunSessionTurn = vi.fn();
const mockSpawn = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { stream: anthropicStream };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: class AnthropicVertex {
    messages = { stream: vertexStream };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: chatCompletionsCreate } };
    responses = { create: responsesCreate };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class GoogleGenAI {
    models = { generateContent };
    constructor(_opts: unknown) {}
  },
}));

vi.mock('./claude-cli/session.js', () => ({
  createSession: () => ({ id: 'fake-session-id' }),
  closeSession: async () => {},
  runSessionTurn: (...args: unknown[]) => mockRunSessionTurn(...args),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import AFTER vi.mock so the mocked constructors are the ones captured.
import * as anthropic from './anthropic/index.js';
import * as vertex from './vertex/index.js';
import * as claudeCli from './claude-cli/index.js';
import * as deepseek from './deepseek/index.js';
import * as openai from './openai/index.js';
import * as google from './google/index.js';
import * as samba from './samba/index.js';
import * as mistral from './mistral/index.js';
import * as vertexOpenAI from './vertex-openai/index.js';
import {
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from './otel.js';
import type { TokenUsage, ToolDef } from './index.js';

// ── The four usage counts, named apart from any provider ─────────────────

type Count = 'input' | 'output' | 'cacheRead' | 'cacheWrite';
type Counts = Partial<Record<Count, number>>;

const ATTRIBUTE: Record<Count, string> = {
  input: ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  output: ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  cacheRead: ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  cacheWrite: ATTR_GEN_AI_USAGE_CACHE_WRITE_INPUT_TOKENS,
};

/** Every count present, each a different number. */
const FULL: Required<Counts> = { input: 100, output: 7, cacheRead: 40, cacheWrite: 30 };

/** An object of the keys whose value is defined. */
function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

/** How one provider's reply carries the counts, what the span should say of
 * them, and what the call returns today. */
interface Shape {
  /** The provider's usage object for these counts; a count left out is a
   * field left out. */
  wire: (c: Counts) => Record<string, unknown>;
  /** The counts this provider has a field for. */
  fields: readonly Count[];
  /** The span's four attributes: `undefined` is unset. */
  span: (c: Counts) => Record<Count, number | undefined>;
  /** The four counts the call returns, as it returns them today. */
  returned: (
    c: Counts
  ) => Pick<
    TokenUsage,
    'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens'
  >;
}

/** Anthropic's shape, shared by `/claude-cli`: `input_tokens` leaves cached
 * tokens out, so the span's input adds the cache counts to it. */
const ANTHROPIC_SHAPE: Shape = {
  wire: (c) =>
    defined({
      input_tokens: c.input,
      output_tokens: c.output,
      cache_read_input_tokens: c.cacheRead,
      cache_creation_input_tokens: c.cacheWrite,
    }),
  fields: ['input', 'output', 'cacheRead', 'cacheWrite'],
  span: (c) => ({
    input: c.input === undefined ? undefined : c.input + (c.cacheRead ?? 0) + (c.cacheWrite ?? 0),
    output: c.output,
    cacheRead: c.cacheRead,
    cacheWrite: c.cacheWrite,
  }),
  returned: (c) => ({
    inputTokens: c.input ?? 0,
    outputTokens: c.output ?? 0,
    cacheReadInputTokens: c.cacheRead ?? 0,
    cacheCreationInputTokens: c.cacheWrite ?? 0,
  }),
};

/** A provider whose input count already holds the cached tokens and which
 * reports no cache write. */
function inclusiveShape(
  wire: Shape['wire'],
  returnedInput: (c: Counts) => number = (c) => c.input ?? 0
): Shape {
  return {
    wire,
    fields: ['input', 'output', 'cacheRead'],
    span: (c) => ({
      input: c.input,
      output: c.output,
      cacheRead: c.cacheRead,
      cacheWrite: undefined,
    }),
    returned: (c) => ({
      inputTokens: returnedInput(c),
      outputTokens: c.output ?? 0,
      cacheReadInputTokens: c.cacheRead ?? 0,
      cacheCreationInputTokens: 0,
    }),
  };
}

const DEEPSEEK_SHAPE = inclusiveShape((c) =>
  defined({
    prompt_tokens: c.input,
    completion_tokens: c.output,
    prompt_cache_hit_tokens: c.cacheRead,
  })
);

const OPENAI_SHAPE = inclusiveShape((c) =>
  defined({
    input_tokens: c.input,
    output_tokens: c.output,
    input_tokens_details: c.cacheRead === undefined ? undefined : { cached_tokens: c.cacheRead },
  })
);

const GOOGLE_SHAPE = inclusiveShape((c) =>
  defined({
    promptTokenCount: c.input,
    candidatesTokenCount: c.output,
    cachedContentTokenCount: c.cacheRead,
  })
);

/** The OpenAI-compatible factory's: the returned input is `prompt_tokens`
 * less the cached tokens. */
const COMPAT_SHAPE = inclusiveShape(
  (c) =>
    defined({
      prompt_tokens: c.input,
      completion_tokens: c.output,
      prompt_tokens_details: c.cacheRead === undefined ? undefined : { cached_tokens: c.cacheRead },
    }),
  (c) => Math.max(0, (c.input ?? 0) - (c.cacheRead ?? 0))
);

// ── The fakes each provider answers with ─────────────────────────────────

function anthropicReply(usage: Record<string, unknown> | undefined) {
  return {
    on: () => {},
    finalMessage: async () => ({
      id: 'msg_1',
      model: 'answered-model',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage,
    }),
  };
}

function completionReply(usage: Record<string, unknown> | undefined) {
  return defined({
    id: 'chatcmpl-1',
    model: 'answered-model',
    choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
    usage,
  });
}

function responsesReply(usage: Record<string, unknown> | undefined) {
  return defined({
    id: 'resp_1',
    model: 'answered-model',
    output_text: 'ok',
    status: 'completed',
    usage,
  });
}

function googleReply(usage: Record<string, unknown> | undefined) {
  return defined({ text: 'ok', candidates: [{ finishReason: 'STOP' }], usageMetadata: usage });
}

/** One `claude` process: its stdout, then a clean exit. */
function queueSpawn(stdout: string) {
  mockSpawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.stdin = { write: () => {}, end: () => {}, on: () => {} };
    queueMicrotask(() => {
      (child.stdout as EventEmitter).emit('data', Buffer.from(stdout + '\n'));
      child.emit('close', 0, null);
    });
    return child;
  });
}

function sessionTurn(usage: Record<string, unknown> | undefined) {
  return {
    text: 'ok',
    stopReason: 'end_turn',
    stopKind: 'finished',
    usage,
    modelUsage: undefined,
    toolUses: [],
    toolResults: [],
    permissionDenials: [],
    assistantEventCount: 1,
  };
}

// ── Every place an adapter reports a span ────────────────────────────────

const TOOL: ToolDef = {
  name: 'lookup',
  description: 'look something up',
  input_schema: { type: 'object', properties: {} },
};
const BASE = { systemPrompt: 'sys', turns: [{ role: 'user' as const, content: 'q' }] };
const KEYED = { ...BASE, apiKey: 'k' };

interface Site {
  site: string;
  shape: Shape;
  /** Whether the call survives a reply with no usage object at all. The
   * Anthropic SDK declares `usage` on every message, and the adapter reads
   * it unguarded, so those sites are given an empty usage object instead. */
  toleratesNoUsage: boolean;
  /** Answer with `usage` (or none), make one call, return what it returns. */
  run: (usage: Record<string, unknown> | undefined) => Promise<{ usage: TokenUsage }>;
}

const SITES: Site[] = [
  ...(
    [
      ['anthropic', anthropicStream, anthropic, { ...BASE, apiKey: 'sk-test' }],
      ['vertex', vertexStream, vertex, BASE],
    ] as const
  ).flatMap(([name, stream, a, base]): Site[] => [
    {
      site: `${name}.chat`,
      shape: ANTHROPIC_SHAPE,
      toleratesNoUsage: false,
      run: (u) => {
        stream.mockReturnValueOnce(anthropicReply(u));
        return a.chat(base);
      },
    },
    {
      site: `${name}.chatWithTools`,
      shape: ANTHROPIC_SHAPE,
      toleratesNoUsage: false,
      run: (u) => {
        stream.mockReturnValueOnce(anthropicReply(u));
        return a.chatWithTools({ ...base, tools: [TOOL] });
      },
    },
  ]),
  {
    site: 'claude-cli.chat (one-shot)',
    shape: ANTHROPIC_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      // The `claude -p` spawn, then the `claude --version` one.
      queueSpawn(
        JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] }) +
          '\n' +
          JSON.stringify(defined({ type: 'result', result: 'ok', usage: u }))
      );
      queueSpawn('2.1.243 (Claude Code)');
      return claudeCli.chat(BASE);
    },
  },
  {
    site: 'claude-cli.chat (held session)',
    shape: ANTHROPIC_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      queueSpawn('2.1.243 (Claude Code)');
      mockRunSessionTurn.mockResolvedValueOnce(sessionTurn(u));
      return claudeCli.chat({ ...BASE, session: { id: 'fake-session-id' } as never });
    },
  },
  {
    site: 'claude-cli.chatWithToolLoop',
    shape: ANTHROPIC_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      queueSpawn('2.1.243 (Claude Code)');
      mockRunSessionTurn.mockResolvedValueOnce(sessionTurn(u));
      return claudeCli.chatWithToolLoop({ ...BASE, tools: [TOOL], executor: async () => 'x' });
    },
  },
  {
    site: 'deepseek.chat',
    shape: DEEPSEEK_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      chatCompletionsCreate.mockResolvedValueOnce(completionReply(u));
      return deepseek.chat(KEYED);
    },
  },
  {
    site: 'openai.chat',
    shape: OPENAI_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      responsesCreate.mockResolvedValueOnce(responsesReply(u));
      return openai.chat(KEYED);
    },
  },
  {
    site: 'google.chat',
    shape: GOOGLE_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      generateContent.mockResolvedValueOnce(googleReply(u));
      return google.chat(KEYED);
    },
  },
  {
    site: 'google.chatWithTools',
    shape: GOOGLE_SHAPE,
    toleratesNoUsage: true,
    run: (u) => {
      generateContent.mockResolvedValueOnce(googleReply(u));
      return google.chatWithTools({ ...KEYED, tools: [TOOL] });
    },
  },
  ...(
    [
      ['samba', samba, KEYED],
      ['mistral', mistral, KEYED],
      ['vertex-openai', vertexOpenAI, { ...BASE, model: 'google/gemini-3.5-flash' }],
    ] as const
  ).flatMap(([name, a, base]): Site[] => [
    {
      site: `${name}.chat`,
      shape: COMPAT_SHAPE,
      toleratesNoUsage: true,
      run: (u) => {
        chatCompletionsCreate.mockResolvedValueOnce(completionReply(u));
        return a.chat(base);
      },
    },
    {
      site: `${name}.chatWithTools`,
      shape: COMPAT_SHAPE,
      toleratesNoUsage: true,
      run: (u) => {
        chatCompletionsCreate.mockResolvedValueOnce(completionReply(u));
        return a.chatWithTools({ ...base, tools: [TOOL] });
      },
    },
  ]),
];

// ── The cases: each count absent, each count 0, no usage at all ──────────

const COUNTS: Count[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

interface Case {
  name: string;
  site: Site;
  /** The counts the provider's reply carries; `undefined` is no usage
   * object at all. */
  counts: Counts | undefined;
}

function without(c: Count): Counts {
  const { [c]: _omitted, ...rest } = FULL;
  return rest;
}

const CASES: Case[] = SITES.flatMap((site) => [
  ...COUNTS.map((c) => ({ name: `${site.site}: no ${c} count`, site, counts: without(c) })),
  ...COUNTS.filter((c) => site.shape.fields.includes(c)).map((c) => ({
    name: `${site.site}: a ${c} count of 0`,
    site,
    counts: { ...FULL, [c]: 0 },
  })),
  {
    name: `${site.site}: no usage ${site.toleratesNoUsage ? 'object' : 'field at all'}`,
    site,
    counts: site.toleratesNoUsage ? undefined : {},
  },
]);

// ── The test ─────────────────────────────────────────────────────────────

describe('every adapter — a usage count the provider gave no value for is unset on the span', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  const ENV = ['ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'GOOGLE_CLOUD_PROJECT'];
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'proj-a';
    process.env.CLOUD_ML_REGION = 'region-a';
    process.env.GOOGLE_CLOUD_PROJECT = 'proj-a';
    for (const m of [
      anthropicStream,
      vertexStream,
      chatCompletionsCreate,
      responsesCreate,
      generateContent,
      mockRunSessionTurn,
      mockSpawn,
    ]) {
      m.mockReset();
    }
    claudeCli.resetClaudeCliVersionCacheForTests();
    exporter.reset();
  });

  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it.each(CASES)(
    '$name: each attribute is the provider’s value or unset; the returned counts are as before',
    async ({ site, counts }) => {
      const reply = await site.run(counts === undefined ? undefined : site.shape.wire(counts));

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const attributes = spans[0].attributes;
      const expected = site.shape.span(counts ?? {});
      for (const c of COUNTS) {
        if (expected[c] === undefined) {
          expect(Object.keys(attributes), ATTRIBUTE[c]).not.toContain(ATTRIBUTE[c]);
        } else {
          expect(attributes[ATTRIBUTE[c]], ATTRIBUTE[c]).toBe(expected[c]);
        }
      }
      // The span leaving a count unset changes nothing the call returns: a
      // count the provider didn't give is returned as 0, as it was.
      expect(reply.usage).toMatchObject(site.shape.returned(counts ?? {}));
    }
  );
});
