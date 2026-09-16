import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// This file tests wave 3's WIRING — chatOnSession, chat()'s session
// branch, chatWithTools's refusal, and chatWithToolLoop — not
// session.ts's own spawn/reuse/watchdog machinery, which already has its
// own dedicated, already-reviewed test coverage. session.ts's exports
// are mocked at the module boundary, the same way chat.test.ts mocks
// node:child_process for the single-shot path — this is what lets this
// file assert "chatWithToolLoop calls runSessionTurn with exactly these
// arguments" without needing a real process.
const mockCreateSession = vi.fn();
const mockCloseSession = vi.fn();
const mockRunSessionTurn = vi.fn();

vi.mock('./session.js', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
  closeSession: (...args: unknown[]) => mockCloseSession(...args),
  runSessionTurn: (...args: unknown[]) => mockRunSessionTurn(...args),
  resetClaudeCliSessionsForTests: vi.fn(),
  SESSION_IDLE_TIMEOUT_MS: 5 * 60 * 1000,
  SESSION_MAX_HELD: 4,
  SESSION_TURN_TIMEOUT_MS: 10 * 60 * 1000,
}));

// The ONLY thing in this file that ever reaches the real (mocked)
// node:child_process spawn is resolveCliVersion()'s `claude --version`
// fallback — chatOnSession/chatWithToolLoop both call it, exactly as
// the single-shot chat() path does. runSessionTurn itself is mocked
// above, so session.ts's own spawn logic never runs.
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  chat,
  chatWithTools,
  chatWithToolLoop,
  resetClaudeCliVersionCacheForTests,
} from './index.js';
import type { ToolDef, ToolUse, TokenUsage } from '../index.js';

function fakeVersionChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.stdin = { write: () => {}, end: () => {} };
  return child;
}

/** Queues one `claude --version` spawn response — needed every test,
 * since resolveCliVersion() is memoized process-wide and this file
 * resets that cache in beforeEach so each test's own assertions about
 * mockSpawn stay independent. */
function queueVersionSpawn(version = '2.1.243 (Claude Code)') {
  mockSpawn.mockImplementationOnce(() => {
    const child = fakeVersionChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(version + '\n'));
      child.emit('close', 0, null);
    });
    return child;
  });
}

const ECHO_TOOL: ToolDef = {
  name: 'echo',
  description: 'echoes',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
};

const SESSION_HANDLE = { id: 'fake-session-id' };

function baseSessionTurnResult(overrides: Record<string, unknown> = {}) {
  return {
    text: 'ok',
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: undefined,
    toolUses: [] as ToolUse[],
    toolResults: [] as { toolUseId: string; content: string; isError: boolean }[],
    permissionDenials: [],
    assistantEventCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockCreateSession.mockReset();
  mockCloseSession.mockReset();
  mockRunSessionTurn.mockReset();
  mockSpawn.mockReset();
  resetClaudeCliVersionCacheForTests();
  mockCreateSession.mockReturnValue(SESSION_HANDLE);
});

describe('chat() — session branch', () => {
  it('runs exactly one turn on the held session via runSessionTurn, never spawning the single-shot path', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult({ text: 'session reply' }));

    const result = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'the new message' }],
      session: SESSION_HANDLE,
    });

    expect(mockRunSessionTurn).toHaveBeenCalledTimes(1);
    expect(mockRunSessionTurn.mock.calls[0][0]).toMatchObject({
      session: SESSION_HANDLE,
      systemPrompt: 'sys',
      message: 'the new message',
      tools: [],
      maxToolCalls: 0,
    });
    expect(result.content).toBe('session reply');
    // Exactly one spawn happened — the --version fallback — never a
    // second, single-shot-path `-p` invocation.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('refuses more than one turn when a session is supplied', async () => {
    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ],
        session: SESSION_HANDLE,
      })
    ).rejects.toThrow(/already carries the prior turns/);
    expect(mockRunSessionTurn).not.toHaveBeenCalled();
  });

  it('refuses a supplied apiKey on the session branch too', async () => {
    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        session: SESSION_HANDLE,
        apiKey: 'sk-byok',
      })
    ).rejects.toThrow(/does not accept apiKey/);
    expect(mockRunSessionTurn).not.toHaveBeenCalled();
  });

  it('reports usage/stopReason from the session turn result, same shape as the single-shot path', async () => {
    queueVersionSpawn('9.9.9 (Claude Code)');
    mockRunSessionTurn.mockResolvedValueOnce(
      baseSessionTurnResult({
        text: 'done',
        stopReason: 'max_tokens',
        usage: { input_tokens: 42, output_tokens: 8 },
      })
    );

    const result = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      session: SESSION_HANDLE,
    });

    expect(result.stopReason).toBe('max_tokens');
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(8);
    expect(result.usage.route).toBe('subscription-oauth');
    expect(result.usage.substrateVersion).toBe('9.9.9 (Claude Code)');
  });

  it('propagates a rejection from runSessionTurn rather than swallowing it', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockRejectedValueOnce(new Error('claude-cli: session timed out'));

    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        session: SESSION_HANDLE,
      })
    ).rejects.toThrow(/session timed out/);
  });
});

describe('chatWithTools', () => {
  it('always refuses on this transport, session or not', async () => {
    await expect(
      chatWithTools({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        tools: [ECHO_TOOL],
      })
    ).rejects.toThrow(/not supported on this transport.*chatWithToolLoop/);

    await expect(
      chatWithTools({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        tools: [ECHO_TOOL],
        session: SESSION_HANDLE,
      })
    ).rejects.toThrow(/not supported on this transport/);

    expect(mockRunSessionTurn).not.toHaveBeenCalled();
  });
});

describe('chatWithToolLoop', () => {
  it('throws when no turns are supplied', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [],
        tools: [ECHO_TOOL],
        executor: async () => 'x',
      })
    ).rejects.toThrow(/at least one turn/);
  });

  it('throws when no tools are supplied', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        tools: [],
        executor: async () => 'x',
      })
    ).rejects.toThrow(/at least one tool/);
  });

  it('refuses a supplied apiKey', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        tools: [ECHO_TOOL],
        executor: async () => 'x',
        apiKey: 'sk-byok',
      })
    ).rejects.toThrow(/does not accept apiKey/);
    expect(mockRunSessionTurn).not.toHaveBeenCalled();
  });

  it('opens a throwaway session when none is supplied, and closes it after — even though the caller never saw a handle', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult());

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
    });

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockCloseSession).toHaveBeenCalledTimes(1);
    expect(mockCloseSession).toHaveBeenCalledWith(SESSION_HANDLE);
  });

  it('closes the throwaway session even when runSessionTurn rejects — the finally must not be skipped by an error path', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockRejectedValueOnce(new Error('boom'));

    await expect(
      chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        tools: [ECHO_TOOL],
        executor: async () => 'x',
      })
    ).rejects.toThrow('boom');

    expect(mockCloseSession).toHaveBeenCalledTimes(1);
  });

  it('reuses a supplied session and does NOT close it', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult());

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
      session: SESSION_HANDLE,
    });

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(mockRunSessionTurn.mock.calls[0][0]).toMatchObject({ session: SESSION_HANDLE });
  });

  it('refuses more than one turn when a session is supplied', async () => {
    await expect(
      chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ],
        tools: [ECHO_TOOL],
        executor: async () => 'x',
        session: SESSION_HANDLE,
      })
    ).rejects.toThrow(/already carries the prior turns/);
    expect(mockRunSessionTurn).not.toHaveBeenCalled();
  });

  it('joins multiple turns as a labelled transcript when NO session is supplied — same as the single-shot path', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult());

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
    });

    expect(mockRunSessionTurn.mock.calls[0][0].message).toBe(
      '## user\nfirst\n\n## assistant\nreply'
    );
  });

  it('passes options.executor and options.tools straight through, and defaults maxToolCalls to 5 when maxIterations is omitted', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult());
    const executor = async () => 'x';

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor,
    });

    expect(mockRunSessionTurn.mock.calls[0][0]).toMatchObject({
      tools: [ECHO_TOOL],
      executor,
      maxToolCalls: 5,
    });
  });

  it('maps options.maxIterations onto maxToolCalls when supplied', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult());

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
      maxIterations: 2,
    });

    expect(mockRunSessionTurn.mock.calls[0][0]).toMatchObject({ maxToolCalls: 2 });
  });

  it('returns toolUses/toolResults/text/usage/iterations/permissionDenials from the session turn result', async () => {
    queueVersionSpawn();
    const toolUses: ToolUse[] = [{ id: 'c1', name: 'echo', input: { text: 'hi' } }];
    const toolResults = [{ toolUseId: 'c1', content: 'echoed', isError: false }];
    const permissionDenials = [{ raw: { tool_name: 'Bash' }, toolName: 'Bash' }];
    mockRunSessionTurn.mockResolvedValueOnce(
      baseSessionTurnResult({
        text: 'final answer',
        toolUses,
        toolResults,
        permissionDenials,
        assistantEventCount: 3,
      })
    );

    const result = await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'echoed',
    });

    expect(result.text).toBe('final answer');
    expect(result.toolUses).toEqual(toolUses);
    expect(result.toolResults).toEqual(toolResults);
    expect(result.iterations).toBe(3);
    expect(result.permissionDenials).toEqual(permissionDenials);
  });

  it('fires onIteration once, with iteration/toolUses/stopReason from the session result', async () => {
    queueVersionSpawn();
    const toolUses: ToolUse[] = [{ id: 'c1', name: 'echo', input: {} }];
    mockRunSessionTurn.mockResolvedValueOnce(
      baseSessionTurnResult({ toolUses, stopReason: 'end_turn', assistantEventCount: 2 })
    );
    const onIteration = vi.fn<(info: unknown) => Promise<void>>(async () => {});

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
      onIteration,
    });

    expect(onIteration).toHaveBeenCalledTimes(1);
    expect(onIteration).toHaveBeenCalledWith({
      iteration: 2,
      toolUses,
      stopReason: 'end_turn',
    });
  });

  it('swallows a throw from onIteration, warning rather than crashing the call', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(baseSessionTurnResult());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onIteration = vi.fn(async () => {
      throw new Error('onIteration blew up');
    });

    const result = await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
      onIteration,
    });

    expect(result.text).toBe('ok'); // the call still completed successfully
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('onIteration callback threw'),
      expect.any(Error)
    );
    warn.mockRestore();
  });

  it('fires onUsage with the shaped usage record', async () => {
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(
      baseSessionTurnResult({ usage: { input_tokens: 12, output_tokens: 4 } })
    );
    const onUsage = vi.fn<(u: TokenUsage) => Promise<void>>(async () => {});

    await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
      onUsage,
    });

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].inputTokens).toBe(12);
  });

  it('reports the model matching the top-level usage figures when modelUsage lists more than one, and warns about the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queueVersionSpawn();
    mockRunSessionTurn.mockResolvedValueOnce(
      baseSessionTurnResult({
        usage: { input_tokens: 281, output_tokens: 10 },
        modelUsage: {
          'claude-haiku-4-5-20251001': {
            inputTokens: 896,
            outputTokens: 11,
            costUSD: 0.000951,
            canonicalModel: 'claude-haiku-4-5',
          },
          'claude-opus-5[1m]': {
            inputTokens: 281,
            outputTokens: 10,
            costUSD: 0.001655,
            canonicalModel: 'claude-opus-5',
          },
        },
      })
    );

    const result = await chatWithToolLoop({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      tools: [ECHO_TOOL],
      executor: async () => 'x',
    });

    expect(result.usage.model).toBe('claude-opus-5');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invoked more than one model'));
    warn.mockRestore();
  });
});
