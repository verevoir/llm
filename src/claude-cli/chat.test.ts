import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock node:child_process's spawn before importing the adapter. Each test
// configures the fake child process's stdout/stderr/exit behaviour.
const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import AFTER vi.mock so the mocked spawn is the one captured.
import { chat, PROVIDER } from './index.js';
import { setModelSpanSink, type ModelSpan, type TokenUsage } from '../index.js';

/** A fake child process: stdout/stderr are EventEmitters (matching the
 * real Readable stream .on('data', ...) shape this adapter reads), stdin
 * is a stub write()/end(), and the child itself is an EventEmitter for
 * 'error'/'close'. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const written: string[] = [];
  child.stdin = {
    write: (s: string) => {
      written.push(s);
    },
    end: () => {
      // Emit close on the next tick, after stdout/stderr data + this test's
      // own close() call have had a chance to be scheduled synchronously.
    },
  };
  return { child, written };
}

/** Drive a fake child through a normal exit: emit stdout data, then close. */
function succeed(child: ReturnType<typeof fakeChild>['child'], stdout: string, exitCode = 0) {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode);
  });
}

function fail(child: ReturnType<typeof fakeChild>['child'], stderr: string, exitCode = 1) {
  queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
}

describe('claudeCli.chat', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    mockSpawn.mockReset();
  });

  afterEach(() => {
    setModelSpanSink(null);
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('spawns "claude" with -p, --system-prompt, --tools "" (disabled), json output, no persistence, safe-mode', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'you are a lens', turns: [{ role: 'user', content: 'diff here' }] });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toEqual([
      '-p',
      '--system-prompt',
      'you are a lens',
      '--tools',
      '',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--safe-mode',
    ]);
  });

  it('writes the single turn content to stdin', async () => {
    const { child, written } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'the diff text' }] });

    expect(written.join('')).toBe('the diff text');
  });

  it('joins multiple turns as a labelled transcript', async () => {
    const { child, written } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok' }));

    await chat({
      systemPrompt: 'sys',
      turns: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
    });

    expect(written.join('')).toBe('## user\nfirst\n\n## assistant\nreply');
  });

  it('strips ANTHROPIC_API_KEY from the child environment even when set in the parent', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-reach-the-child';
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('reports route as the constant subscription-oauth', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok' }));

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.usage.route).toBe('subscription-oauth');
    expect(result.usage.provider).toBe(PROVIDER);
  });

  it('extracts content, usage, and returns them from a recognised json envelope', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(
      child,
      JSON.stringify({
        result: 'VERDICT: rejected\nFINDING: something is wrong',
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
      })
    );

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.content).toBe('VERDICT: rejected\nFINDING: something is wrong');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.cacheReadInputTokens).toBe(5);
  });

  it('falls back to raw stdout as text and warns when the json shape is not recognised', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    // Valid JSON, but none of the known fields — an unrecognised envelope.
    succeed(child, JSON.stringify({ something_else: 'entirely' }));

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.content).toBe(JSON.stringify({ something_else: 'entirely' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not match any known field'));
    warn.mockRestore();
  });

  it('treats non-JSON stdout as the raw reply text', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, 'plain text reply, not json at all');

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.content).toBe('plain text reply, not json at all');
  });

  it('emits a model span to the registered sink with scope claudeCli.chat', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok' }));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ scope: 'claudeCli.chat', provider: PROVIDER });
  });

  it('fires onUsage with the shaped usage record', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    succeed(child, JSON.stringify({ result: 'ok', usage: { input_tokens: 7, output_tokens: 3 } }));
    const onUsage = vi.fn<(u: TokenUsage) => Promise<void>>(async () => {});

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }], onUsage });

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].inputTokens).toBe(7);
  });

  it('throws, naming the exit code and stderr, on a non-zero exit', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    fail(child, 'auth failed: no session', 1);

    await expect(
      chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
    ).rejects.toThrow(/exited with code 1.*auth failed: no session/);
  });

  it('throws, naming the spawn failure, when claude cannot be run at all (e.g. ENOENT)', async () => {
    const { child } = fakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('error', new Error('spawn claude ENOENT')));

    await expect(
      chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
    ).rejects.toThrow(/could not run the claude CLI.*ENOENT/);
  });

  it('throws when no turns are supplied', async () => {
    await expect(chat({ systemPrompt: 'sys', turns: [] })).rejects.toThrow(/at least one turn/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a supplied apiKey rather than silently ignoring it', async () => {
    await expect(
      chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }], apiKey: 'sk-byok' })
    ).rejects.toThrow(/does not accept apiKey/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses a turn carrying a tool_use content block rather than silently dropping it', async () => {
    await expect(
      chat({
        systemPrompt: 'sys',
        turns: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }],
          },
        ],
      })
    ).rejects.toThrow(/tool_use.*not supported/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
