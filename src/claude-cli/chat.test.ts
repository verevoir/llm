import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';

// Mock node:child_process's spawn before importing the adapter. Each test
// configures the fake child process's stdout/stderr/exit behaviour.
const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Import AFTER vi.mock so the mocked spawn is the one captured.
import {
  ALLOWED_ENV_VARS,
  allowedEnv,
  chat,
  CLAUDE_CLI_CREDENTIAL_ENV_VAR,
  PROVIDER,
  resetClaudeCliVersionCacheForTests,
} from './index.js';
import { setModelSpanSink, type ModelSpan, type TokenUsage } from '../index.js';

/** A fake child process: stdout/stderr are EventEmitters (matching the
 * real Readable stream .on('data', ...) shape this adapter reads), stdin
 * is a stub write()/end(), `kill` is a stub so abort tests can assert the
 * subprocess was actually asked to terminate, and the child itself is an
 * EventEmitter for 'error'/'close'. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
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

/** Drive a fake child through a normal exit: emit stdout data, then close.
 * Always closes with a `null` signal — a real Node close event carries
 * `(exitCode, signal)` with exactly one of the two non-null, and every
 * ordinary exit in this suite is the exit-code half of that pair. */
function succeed(child: ReturnType<typeof fakeChild>['child'], stdout: string, exitCode = 0) {
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', exitCode, null);
  });
}

function fail(child: ReturnType<typeof fakeChild>['child'], stderr: string, exitCode = 1) {
  queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode, null);
  });
}

/** Drive a fake child through a signal-terminated close — the shape
 * `describeExit` (index.ts) exists to report distinguishably from a bare
 * null exit code. Used directly by the exit-signal tests below rather
 * than through `queueCall`/`queueFailingCall`, since neither of those
 * shapes a signal-terminated close. */
function queueClosingWith(exitCode: number | null, signal: NodeJS.Signals | null) {
  const { child, written } = fakeChild();
  mockSpawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('close', exitCode, signal));
    return child;
  });
  return { child, written };
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
  const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const originalUseVertex = process.env.CLAUDE_CODE_USE_VERTEX;

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
    if (originalAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
    if (originalUseBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = originalUseBedrock;
    if (originalUseVertex === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
    else process.env.CLAUDE_CODE_USE_VERTEX = originalUseVertex;
  });

  it('spawns "claude" with -p, --system-prompt, --tools "" (disabled), strict MCP isolation, json output, no persistence, safe-mode', async () => {
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
      '--strict-mcp-config',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--safe-mode',
    ]);
  });

  describe('model pinning', () => {
    it('does not pass --model when options.model is not set — unchanged, unpinned behaviour', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      const [, args] = mockSpawn.mock.calls[0];
      expect(args).not.toContain('--model');
    });

    it('passes --model <id> verbatim when options.model is set', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      await chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        model: 'claude-sonnet-5',
      });

      const [, args] = mockSpawn.mock.calls[0];
      const modelIndex = args.indexOf('--model');
      expect(modelIndex).toBeGreaterThan(-1);
      expect(args[modelIndex + 1]).toBe('claude-sonnet-5');
    });
  });

  describe('isolation from project/local configuration', () => {
    it('always passes --strict-mcp-config, so no MCP server outside an explicit --mcp-config can reach the call', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      const [, args] = mockSpawn.mock.calls[0];
      expect(args).toContain('--strict-mcp-config');
    });

    it("spawns with cwd set to the platform temp directory, never the caller's own working directory", async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      const spawnOptions = mockSpawn.mock.calls[0][2] as { cwd: string };
      expect(spawnOptions.cwd).toBe(tmpdir());
      // The load-bearing half: proving this differs from the test process's
      // OWN cwd (this repository's root, during this suite's run — exactly
      // the directory whose CLAUDE.md/.mcp.json this isolation exists to
      // keep out) rules out a mutant that silently swaps tmpdir() for
      // process.cwd(), which the first assertion alone could not catch if
      // the two ever happened to coincide.
      expect(spawnOptions.cwd).not.toBe(process.cwd());
    });

    it('sets cwd on the claude --version fallback spawn too, not only the main call', async () => {
      mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

      await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

      const versionSpawnOptions = mockSpawn.mock.calls[1][2] as { cwd: string };
      expect(versionSpawnOptions.cwd).toBe(tmpdir());
    });
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

  it('spawns claude with exactly the allowlisted environment, never a copy of the full parent env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-should-never-reach-the-child';
    mockSuccessfulCall(JSON.stringify({ result: 'ok' }));

    await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });

    const spawnOptions = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOptions.env).toEqual(allowedEnv(process.env));
    expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  describe('allowedEnv', () => {
    // A realistic caller environment: the one credential this adapter
    // reads, the base names every process needs, and a pile of things it
    // must never see — the operator's own billed key, an unrelated cloud
    // credential, an SSH agent socket, a CI token. None of
    // PATH/HOME/TMPDIR/CLAUDE_CODE_OAUTH_TOKEN is what this block is
    // pinning; UNDECLARED is — this is the mutation target for the
    // denylist-to-allowlist fix: a version that merely names its
    // permitted set but still spreads the source through underneath has
    // every one of these still leaking.
    const CALLER_ENV: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/it',
      TMPDIR: '/tmp',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-should-reach-the-child',
      ANTHROPIC_API_KEY: 'sk-should-never-reach-the-child',
      ANTHROPIC_API_KEY_FILE: '/path/should-never-reach-the-child',
      ANTHROPIC_AUTH_TOKEN: 'sk-should-never-reach-the-child',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      AWS_SECRET_ACCESS_KEY: 'aws-should-never-reach-the-child',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      GITHUB_TOKEN: 'gh-should-never-reach-the-child',
    };

    it('carries every ALLOWED_ENV_VARS name that is present in the source', () => {
      const child = allowedEnv(CALLER_ENV);
      for (const key of ALLOWED_ENV_VARS) {
        expect(child[key]).toBe(CALLER_ENV[key]);
      }
    });

    it('does not let an undeclared variable in the source reach the child, however sensitive — including every name the old denylist used to strip by name', () => {
      const child = allowedEnv(CALLER_ENV);
      expect(child.ANTHROPIC_API_KEY).toBeUndefined();
      expect(child.ANTHROPIC_API_KEY_FILE).toBeUndefined();
      expect(child.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(child.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
      expect(child.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
      expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(child.SSH_AUTH_SOCK).toBeUndefined();
      expect(child.GITHUB_TOKEN).toBeUndefined();
      // Nothing beyond ALLOWED_ENV_VARS reached the child at all — not just
      // the eight named above.
      expect(Object.keys(child).sort()).toEqual([...ALLOWED_ENV_VARS].sort());
    });

    it('carries the subscription credential by name — CLAUDE_CODE_OAUTH_TOKEN specifically', () => {
      expect(ALLOWED_ENV_VARS).toContain(CLAUDE_CLI_CREDENTIAL_ENV_VAR);
      expect(allowedEnv(CALLER_ENV)[CLAUDE_CLI_CREDENTIAL_ENV_VAR]).toBe(
        CALLER_ENV[CLAUDE_CLI_CREDENTIAL_ENV_VAR]
      );
    });

    it('omits an allowed name the source simply does not have, rather than inventing it', () => {
      const child = allowedEnv({ PATH: '/usr/bin' });
      expect(child.HOME).toBeUndefined();
      expect(child[CLAUDE_CLI_CREDENTIAL_ENV_VAR]).toBeUndefined();
      expect(child.PATH).toBe('/usr/bin');
    });

    it('leaves the original object untouched — a copy, not a mutation', () => {
      allowedEnv(CALLER_ENV);
      expect(CALLER_ENV.ANTHROPIC_API_KEY).toBe('sk-should-never-reach-the-child');
    });
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

  // THE MUTATION TARGET for the discarded-signal fix. Before it, `close`'s
  // second argument was never read and `SpawnResult` had no `signal`
  // field at all — so a SIGKILL-terminated run and a bare `exitCode: null`
  // carrying no signal were reported IDENTICALLY, both as "exited with
  // code null". This pins that the two are now told apart.
  /** The error a call rejected with — restructured to avoid casting across
   * the `ChatReply | Error` union `.catch()`'s callback return type
   * produces (that cast is what typecheck rejected: `error: Error`
   * annotated against a `.catch()` chain that resolves to the wider
   * union). Awaiting inside a try/catch instead means `error` is typed
   * from the `catch` clause itself, not asserted past the outer union.
   * Throws if the call resolves rather than rejects, so a regression that
   * stops throwing fails this test rather than reading `error` as
   * `undefined`. */
  async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
    try {
      await promise;
    } catch (e) {
      return e as Error;
    }
    throw new Error('expected the call to reject, and it resolved');
  }

  describe('exit signal', () => {
    it('reports a signal-terminated close distinguishably from a null exit carrying no signal', async () => {
      queueClosingWith(null, 'SIGKILL');
      await expect(
        chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
      ).rejects.toThrow(/killed by signal SIGKILL/);

      queueClosingWith(null, null);
      const error = await rejectionOf(
        chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
      );
      expect(error.message).toContain('exited with code null');
      expect(error.message).not.toMatch(/signal/i);
    });

    it('does not mention a signal when the process exited normally with a non-zero code', async () => {
      queueFailingCall('boom', 1);
      const error = await rejectionOf(
        chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] })
      );
      expect(error.message).toContain('exited with code 1');
      expect(error.message).not.toMatch(/signal/i);
    });
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

  // ── abortSignal ───────────────────────────────────────────────────────
  // Every other chat() in this package (anthropic, google, openai, the
  // OpenAI-compatible factory, deepseek) calls throwIfAborted(options
  // .abortSignal) at entry, honouring the shared ChatOptions.abortSignal
  // contract (see index.ts's own doc comment — aborting on an exceeded
  // budget is its canonical use case). This adapter previously never
  // referenced options.abortSignal at all: an abort mid-call did nothing
  // and the spawned `claude` process ran to completion regardless. Both
  // halves of the fix are covered below — the entry check, AND the
  // wiring that actually terminates a still-running child.

  describe('abortSignal', () => {
    it('throws the signal reason before spawning, when the signal is already aborted at entry', async () => {
      const controller = new AbortController();
      controller.abort(new Error('budget exceeded'));

      await expect(
        chat({
          systemPrompt: 'sys',
          turns: [{ role: 'user', content: 'q' }],
          abortSignal: controller.signal,
        })
      ).rejects.toThrow('budget exceeded');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('kills the spawned child and rejects with the signal reason when aborted while claude is still running', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      // Deliberately never emits 'close' or 'error' — as far as this test
      // is concerned, the process stays "running" for its entire duration.
      // This is the exact case the finding named: an abort while the call
      // has NOT naturally finished, as opposed to one that arrives after.

      const controller = new AbortController();
      // chat() is async but runs synchronously up to its first internal
      // await (on runClaudeCli's own promise) — so by the time this call
      // returns control here, spawn() has already been invoked and the
      // abort listener already attached. No manual tick is needed before
      // aborting; if the wiring under test were missing, this would hang
      // rather than resolve, which is exactly the failure this test
      // exists to catch.
      const chatPromise = chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'q' }],
        abortSignal: controller.signal,
      });
      controller.abort(new Error('aborted mid-call'));

      await expect(chatPromise).rejects.toThrow('aborted mid-call');
      expect(child.kill).toHaveBeenCalledTimes(1);
    });
  });

  // ── The real, observed --output-format json envelope ───────────────────
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

  // ── substrateVersion ────────────────────────────────────────────
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
