import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock node:child_process's spawn before importing the adapter. Each test
// configures the fake child process's stdout/stderr/exit behaviour.
const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import AFTER vi.mock so the mocked spawn is the one captured.
import { chat, PROVIDER, resetClaudeCliVersionCacheForTests } from './index.js';
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

/**
 * Queues ONE spawn invocation. The event emission (`succeed`/`fail`) is
 * scheduled INSIDE the mock implementation, at the moment `spawn()` is
 * actually called by the adapter — not at test-setup time. This matters
 * once a test chains two spawn calls (a main call, then the version
 * fallback): `runClaudeCli` attaches its 'data'/'close' listeners
 * synchronously, right after calling `spawn()`, with no `await` in
 * between — so as long as emission is scheduled at call-time, listeners
 * are always attached before the queued microtask fires. Scheduling the
 * emission at test-setup time instead (before `spawn()` for a LATER call
 * in the chain has even happened) races the listener attachment: the
 * event fires into an EventEmitter nobody is listening to yet, is lost,
 * and the adapter hangs waiting for a 'close' that already happened.
 */
function queueCall(stdout: string, exitCode = 0) {
  const { child, written } = fakeChild();
  mockSpawn.mockImplementationOnce(() => {
    succeed(child, stdout, exitCode);
    return child;
  });
  return { child, written };
}

/** Same call-time-deferred scheduling as {@link queueCall}, for a non-zero
 * exit. */
function queueFailingCall(stderr: string, exitCode = 1) {
  const { child, written } = fakeChild();
  mockSpawn.mockImplementationOnce(() => {
    fail(child, stderr, exitCode);
    return child;
  });
  return { child, written };
}

/** Same call-time-deferred scheduling as {@link queueCall}, for a
 * spawn-level failure (e.g. ENOENT) rather than a process exit. */
function queueErroringCall(err: Error) {
  const { child, written } = fakeChild();
  mockSpawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('error', err));
    return child;
  });
  return { child, written };
}

/** `claude --version`'s real relayed output — see index.ts's `parseVersionOutput`. */
const DEFAULT_VERSION_OUTPUT = '2.1.243 (Claude Code)';

/**
 * Queues the main `-p` call to succeed with `mainStdout`, followed by the
 * `claude --version` fallback call this adapter makes on every real call —
 * the confirmed real payload never carries a version field of its own (see
 * index.ts's file header), so the fallback spawn is now unconditional, not
 * merely a possibility a test fixture needs to trigger. Returns the main
 * call's `written` stdin array, matching what tests asserted before this
 * adapter gained the version fallback.
 */
function mockSuccessfulCall(mainStdout: string, opts: { versionOutput?: string } = {}) {
  const main = queueCall(mainStdout);
  queueCall(opts.versionOutput ?? DEFAULT_VERSION_OUTPUT);
  return { written: main.written };
}

describe('claudeCli.chat', () => {
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    mockSpawn.mockReset();
    // Every test starts with no cached version — otherwise a test earlier
    // in this file would leave a value in the process-wide cache and later
    // tests would silently skip the fallback spawn they expect to see.
    resetClaudeCliVersionCacheForTests();
  });

  afterEach(() => {
    setModelSpanSink(null);
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it('spawns "claude" with -p, --system-prompt, --tools "" (disabled), json output, no persistence, safe-mode', async () => {
    mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'you are a lens', turns: [{ role: 'user', content: 'diff here' }] });

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
    const { written } = mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'the diff text' }] });

    expect(written.join('')).toBe('the diff text');
  });

  it('joins multiple turns as a labelled transcript', async () => {
    const { written } = mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

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
    mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('reports route as the constant subscription-oauth', async () => {
    mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.usage.route).toBe('subscription-oauth');
    expect(result.usage.provider).toBe(PROVIDER);
  });

  it('extracts the reply text from the confirmed "result" field', async () => {
    mockSuccessfulCall(
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

  it('falls back to raw stdout as text and warns when "result" is not a string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Valid JSON, but no string "result" field — an unrecognised envelope.
    mockSuccessfulCall(JSON.stringify({ something_else: 'entirely' }));

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.content).toBe(JSON.stringify({ something_else: 'entirely' }));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not carry a string "result" field')
    );
    warn.mockRestore();
  });

  it('treats non-JSON stdout as the raw reply text', async () => {
    mockSuccessfulCall('plain text reply, not json at all');

    const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(result.content).toBe('plain text reply, not json at all');
  });

  it('emits a model span to the registered sink with scope claudeCli.chat', async () => {
    mockSuccessfulCall(JSON.stringify({ result: 'ok' }));
    const spans: ModelSpan[] = [];
    setModelSpanSink((s) => spans.push(s));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ scope: 'claudeCli.chat', provider: PROVIDER });
  });

  it('fires onUsage with the shaped usage record', async () => {
    mockSuccessfulCall(
      JSON.stringify({ result: 'ok', usage: { input_tokens: 7, output_tokens: 3 } })
    );
    const onUsage = vi.fn<(u: TokenUsage) => Promise<void>>(async () => {});

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }], onUsage });

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].inputTokens).toBe(7);
  });

  it('throws, naming the exit code and stderr, on a non-zero exit', async () => {
    queueFailingCall('auth failed: no session', 1);

    await expect(
      chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
    ).rejects.toThrow(/exited with code 1.*auth failed: no session/);
  });

  it('throws, naming the spawn failure, when claude cannot be run at all (e.g. ENOENT)', async () => {
    queueErroringCall(new Error('spawn claude ENOENT'));

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

  // ── The real, observed --output-format json envelope ──────────────────
  // Everything in this block is against the actual payload the operator
  // relayed from a real `claude -p ... --output-format json` run — see
  // index.ts's file header for the full reasoning behind each decision.

  describe('the real --output-format json envelope', () => {
    it('maps stop_reason from the payload to ChatReply.stopReason', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok', stop_reason: 'max_tokens' }));

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(result.stopReason).toBe('max_tokens');
    });

    it('defaults stopReason to end_turn when the payload carries no stop_reason', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(result.stopReason).toBe('end_turn');
    });

    it('refuses even on a zero exit code when the payload itself reports is_error: true', async () => {
      queueCall(
        JSON.stringify({
          is_error: true,
          subtype: 'error_max_turns',
          result: 'ran out of turns',
        })
      );

      await expect(
        chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
      ).rejects.toThrow(/is_error: true \(subtype=error_max_turns\).*ran out of turns/);

      // The exit code was never in question here — the call succeeded at
      // the process level (queueCall, not queueFailingCall) and refused
      // purely because of the payload's own is_error field.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('reports the model matching the top-level usage figures when modelUsage lists more than one, and warns about the rest rather than silently dropping them', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSuccessfulCall(
        JSON.stringify({
          result: 'VERDICT: approved',
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

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      // The opus entry matches the top-level usage figures (281 in / 10
      // out) — that's the model that produced the visible reply.
      expect(result.usage.model).toBe('claude-opus-5');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invoked more than one model'));
      // The haiku call is NOT silently discarded — it's named in the warning.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude-haiku-4-5'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('claude-opus-5'));
      warn.mockRestore();
    });

    it('does not warn about multiple models when modelUsage names only one', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockSuccessfulCall(
        JSON.stringify({
          result: 'ok',
          usage: { input_tokens: 10, output_tokens: 5 },
          modelUsage: {
            'claude-opus-5[1m]': {
              inputTokens: 10,
              outputTokens: 5,
              costUSD: 0.0001,
              canonicalModel: 'claude-opus-5',
            },
          },
        })
      );

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(result.usage.model).toBe('claude-opus-5');
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('invoked more than one model'));
      warn.mockRestore();
    });

    it('reports model "unknown" when the payload carries no modelUsage at all', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(result.usage.model).toBe('unknown');
    });
  });

  // ── substrateVersion ────────────────────────────────────────────────
  // The confirmed real payload never carries a version field (see index.ts's
  // file header) — this memoized `claude --version` spawn is the only
  // source of substrateVersion, not a fallback for a payload path that
  // turned out not to exist.

  describe('substrateVersion', () => {
    it('spawns "claude --version" exactly once per process and caches the result', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'first' }), {
        versionOutput: '2.1.243 (Claude Code)',
      });
      const first = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q1' }] });
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      const versionCall = mockSpawn.mock.calls[1];
      expect(versionCall[1]).toEqual(['--version']);

      // Second call: only the main call is queued — the version is already
      // cached from the first call, so no second "claude --version" spawn
      // should happen. If the adapter re-spawned it anyway, this call
      // would have nothing queued to answer it and would hang, failing the
      // test on timeout rather than a wrong assertion — the single queued
      // call below IS that missing-mock canary.
      queueCall(JSON.stringify({ result: 'second' }));
      const second = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q2' }] });

      expect(mockSpawn).toHaveBeenCalledTimes(3); // 2 from the first call + 1 main-only from the second
      expect(first.usage.substrateVersion).toBe('2.1.243 (Claude Code)');
      expect(second.usage.substrateVersion).toBe('2.1.243 (Claude Code)');
    });

    it('reports substrateVersion as undefined, without throwing, when the version fallback spawn fails', async () => {
      queueCall(JSON.stringify({ result: 'ok' }));
      queueErroringCall(new Error('spawn claude ENOENT'));

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(result.usage.substrateVersion).toBeUndefined();
      expect(result.content).toBe('ok'); // the main call still succeeded and parsed normally
    });

    it('reports substrateVersion as undefined when "claude --version" exits non-zero', async () => {
      queueCall(JSON.stringify({ result: 'ok' }));
      queueFailingCall('unknown flag', 2);

      const result = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(result.usage.substrateVersion).toBeUndefined();
    });

    it('is included on the model span emitted to the registered sink', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }), {
        versionOutput: '2.1.243 (Claude Code)',
      });
      const spans: ModelSpan[] = [];
      setModelSpanSink((s) => spans.push(s));

      await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      expect(spans[0]).toMatchObject({ substrateVersion: '2.1.243 (Claude Code)' });
    });
  });
});
