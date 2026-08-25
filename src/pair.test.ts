import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the OpenAI SDK before importing the samba adapter (integration test).
// SambaNova speaks the Chat Completions API via the shared OpenAI-compatible
// factory.
const mockCreate = vi.fn();

vi.mock('openai', () => ({
  default: class OpenAI {
    chat = { completions: { create: mockCreate } };
    constructor(_opts: unknown) {}
  },
}));

import { withAdvisor, type ConsultInfo } from './pair.js';
import {
  setModelSpanSink,
  type ChatOptions,
  type ChatReply,
  type ModelSpan,
  type TokenUsage,
  type ToolDef,
  type ToolUse,
} from './index.js';
import { chat as sambaChat, chatWithToolLoop } from './samba/index.js';

const RECORD_TOOL: ToolDef = {
  name: 'record',
  description: 'record a thing',
  input_schema: { type: 'object', properties: { x: { type: 'number' } } },
};

const usageStub: TokenUsage = {
  provider: 'mock',
  model: 'mock-advisor',
  direction: 'reasoning',
  route: 'api-key',
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** A mock advisor chat: reports `usageStub` via onUsage, replies with `content`. */
function mockAdvisorChat(content = 'advisor says') {
  return vi.fn(async (opts: ChatOptions): Promise<ChatReply> => {
    await opts.onUsage?.(usageStub);
    return { content, usage: usageStub, stopReason: 'end_turn' };
  });
}

const consultUse = (input: Record<string, unknown>): ToolUse => ({
  id: 'c1',
  name: 'consult_advisor',
  input,
});

describe('withAdvisor — wrapping', () => {
  it('appends a well-formed consult_advisor tool without mutating the input array', () => {
    const tools = [RECORD_TOOL];
    const { tools: wrapped } = withAdvisor(tools, async () => 'ok', {
      chat: mockAdvisorChat(),
      systemPrompt: 'the bar',
    });

    expect(tools).toEqual([RECORD_TOOL]);
    expect(wrapped).toHaveLength(2);
    expect(wrapped[1]).toMatchObject({
      name: 'consult_advisor',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context: { type: 'string' },
        },
        required: ['question'],
      },
    });
    expect(wrapped[1].description).toContain('Consult your senior advisor');
  });

  it('honours toolName + description overrides on the appended ToolDef', () => {
    const { tools: wrapped } = withAdvisor([], async () => 'ok', {
      chat: mockAdvisorChat(),
      systemPrompt: 'the bar',
      toolName: 'ask_reviewer',
      description: 'Ask the reviewer.',
    });

    expect(wrapped[0]).toMatchObject({ name: 'ask_reviewer', description: 'Ask the reviewer.' });
  });

  it('throws at wrap time when a tool already carries the consult name', () => {
    const clash: ToolDef = { ...RECORD_TOOL, name: 'consult_advisor' };
    expect(() =>
      withAdvisor([clash], async () => 'ok', { chat: mockAdvisorChat(), systemPrompt: 'bar' })
    ).toThrow(/consult_advisor/);
  });
});

describe('withAdvisor — consult routing', () => {
  it('routes a consult to the advisor with its systemPrompt and the question as a user turn, returning the answer', async () => {
    const advisorChat = mockAdvisorChat('use a queue');
    const { executor } = withAdvisor([RECORD_TOOL], async () => 'inner', {
      chat: advisorChat,
      systemPrompt: 'the bar',
    });

    const result = await executor(consultUse({ question: 'queue or cron?' }));

    expect(result).toBe('use a queue');
    expect(advisorChat).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'the bar',
        turns: [{ role: 'user', content: 'queue or cron?' }],
        modelClass: 'reasoning',
      })
    );
  });

  it('appends the context to the question when provided', async () => {
    const advisorChat = mockAdvisorChat();
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: advisorChat,
      systemPrompt: 'the bar',
    });

    await executor(consultUse({ question: 'is this right?', context: 'const x = 1;' }));

    expect(advisorChat.mock.calls[0][0].turns).toEqual([
      { role: 'user', content: 'is this right?\n\nconst x = 1;' },
    ]);
  });

  it('routes a renamed consult tool by the override name', async () => {
    const advisorChat = mockAdvisorChat('renamed answer');
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: advisorChat,
      systemPrompt: 'the bar',
      toolName: 'ask_reviewer',
    });

    const result = await executor({ id: 'c1', name: 'ask_reviewer', input: { question: 'q' } });

    expect(result).toBe('renamed answer');
  });

  it('passes non-consult tool calls through to the inner executor untouched', async () => {
    const advisorChat = mockAdvisorChat();
    const inner = vi.fn(async () => 'recorded');
    const { executor } = withAdvisor([RECORD_TOOL], inner, {
      chat: advisorChat,
      systemPrompt: 'the bar',
    });

    const use: ToolUse = { id: 't1', name: 'record', input: { x: 1 } };
    const result = await executor(use);

    expect(result).toBe('recorded');
    expect(inner).toHaveBeenCalledWith(use);
    expect(advisorChat).not.toHaveBeenCalled();
  });
});

describe('withAdvisor — question validation', () => {
  it('returns an ask-again result without calling the advisor when the question is missing or not a string', async () => {
    const advisorChat = mockAdvisorChat();
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: advisorChat,
      systemPrompt: 'the bar',
    });

    const result = await executor(consultUse({ question: 42 }));

    expect(result).toBe(
      'consult_advisor requires a question — call it again with a specific question'
    );
    expect(advisorChat).not.toHaveBeenCalled();
  });

  it('returns an ask-again result when the question is an empty string', async () => {
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: mockAdvisorChat(),
      systemPrompt: 'the bar',
    });

    const result = await executor(consultUse({ question: '' }));

    expect(result).toBe(
      'consult_advisor requires a question — call it again with a specific question'
    );
  });

  it('names the overridden tool in the ask-again result so the executor retries the right tool', async () => {
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: mockAdvisorChat(),
      systemPrompt: 'the bar',
      toolName: 'ask_reviewer',
    });

    const result = await executor({ id: 'c1', name: 'ask_reviewer', input: {} });

    expect(result).toBe(
      'ask_reviewer requires a question — call it again with a specific question'
    );
  });
});

describe('withAdvisor — advisor failure', () => {
  it('returns a legible advisor-unavailable result instead of throwing when the advisor call fails', async () => {
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: async () => {
        throw new Error('rate limited');
      },
      systemPrompt: 'the bar',
    });

    const result = await executor(consultUse({ question: 'q' }));

    expect(result).toBe(
      'advisor unavailable: rate limited — proceed on your own judgement and note the uncertainty'
    );
  });

  it('does not fire onConsult when the advisor call fails — there is no answer to report', async () => {
    const onConsult = vi.fn();
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: async () => {
        throw new Error('down');
      },
      systemPrompt: 'the bar',
      onConsult,
    });

    await executor(consultUse({ question: 'q' }));

    expect(onConsult).not.toHaveBeenCalled();
  });
});

describe('withAdvisor — onConsult hook', () => {
  it('fires onConsult with the question, context, answer, and the usage the advisor reported', async () => {
    const seen: ConsultInfo[] = [];
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: mockAdvisorChat('the answer'),
      systemPrompt: 'the bar',
      onConsult: (info) => seen.push(info),
    });

    await executor(consultUse({ question: 'q', context: 'ctx' }));

    expect(seen).toEqual([
      { question: 'q', context: 'ctx', answer: 'the answer', usage: usageStub },
    ]);
  });

  it('a throwing onConsult is caught and warned — the consult still returns the answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { executor } = withAdvisor([], async () => 'inner', {
      chat: mockAdvisorChat('still delivered'),
      systemPrompt: 'the bar',
      onConsult: () => {
        throw new Error('metrics boom');
      },
    });

    const result = await executor(consultUse({ question: 'q' }));
    warn.mockRestore();

    expect(result).toBe('still delivered');
  });
});

// ── Integration: a real adapter tool loop consulting a real adapter advisor ──

function textReply(content: string, usage = { prompt_tokens: 12, completion_tokens: 8 }) {
  return {
    choices: [{ message: { content, tool_calls: [] }, finish_reason: 'stop' }],
    usage,
  };
}

function consultCallReply() {
  return {
    choices: [
      {
        message: {
          content: '',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'consult_advisor', arguments: '{"question":"done enough?"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

describe('withAdvisor — through a real tool loop (samba, mocked SDK)', () => {
  beforeEach(() => mockCreate.mockReset());
  afterEach(() => setModelSpanSink(null));

  it('the loop completes with the advisor answer in toolResults, and spans cover both loop iterations and the advisor call', async () => {
    // Call order on the shared mock: loop iteration 1 (consults) → advisor
    // chat (answers) → loop iteration 2 (finishes).
    mockCreate
      .mockResolvedValueOnce(consultCallReply())
      .mockResolvedValueOnce(textReply('yes — ship it'))
      .mockResolvedValueOnce(textReply('done'));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    const { tools, executor } = withAdvisor([RECORD_TOOL], async () => 'recorded', {
      chat: (opts) => sambaChat({ ...opts, apiKey: 'sk-advisor' }),
      systemPrompt: 'hold the bar',
    });
    const r = await chatWithToolLoop({
      systemPrompt: 'do the work',
      turns: [{ role: 'user', content: 'go' }],
      tools,
      executor,
      apiKey: 'sk-executor',
    });

    expect(r.text).toBe('done');
    expect(r.iterations).toBe(2);
    expect(r.toolResults).toEqual([{ toolUseId: 'c1', content: 'yes — ship it', isError: false }]);
    expect(spans.map((s) => s.scope)).toEqual([
      'samba.chatWithToolLoop',
      'samba.chat',
      'samba.chatWithToolLoop',
    ]);
  });
});
