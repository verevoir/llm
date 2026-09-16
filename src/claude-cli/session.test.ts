import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  closeSession,
  createSession,
  getOrCreateSession,
  resetClaudeCliSessionsForTests,
  runSessionTurn,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_HELD,
  SESSION_TURN_TIMEOUT_MS,
} from './session.js';
import type { ToolDef } from '../index.js';

/** A fake `claude` child for the session-holding transport: stdout is an
 * EventEmitter tests push stream-json lines onto directly (`emitLine`),
 * stdin.write is recorded per call, and `kill` is a spy so
 * eviction/teardown tests can assert the process was actually asked to
 * stop. This file never writes to stdin or waits on a `result` event
 * itself — that's wave 2b's `runSessionTurn` — but `getOrCreateSession`
 * still wires the child's stdout/close/error listeners (`wireSessionEvents`),
 * so a fake child needs the same shape as wave 2b's fixture. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  const written: string[] = [];
  child.stdin = {
    write: (s: string) => {
      written.push(s);
    },
    end: () => {},
  };
  return {
    child,
    written,
    emitLine: (obj: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')),
    emitRaw: (text: string) => child.stdout.emit('data', Buffer.from(text)),
  };
}

const ECHO_TOOL: ToolDef = {
  name: 'echo',
  description: 'echoes',
  input_schema: { type: 'object', properties: { text: { type: 'string' } } },
};

const NO_TOOLS = { tools: [], systemPrompt: 'sys', model: undefined };

describe('claude-cli session lifecycle (wave 2a)', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetClaudeCliSessionsForTests();
  });

  afterEach(() => {
    resetClaudeCliSessionsForTests();
    vi.useRealTimers();
  });

  it('createSession spawns nothing by itself', () => {
    createSession();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('createSession returns a fresh id each time', () => {
    expect(createSession().id).not.toBe(createSession().id);
  });

  it('spawns claude with the stream-json flags and no --mcp-config when there are no tools', async () => {
    const { child } = fakeChild();
    mockSpawn.mockImplementationOnce(() => child);
    const session = createSession();

    await getOrCreateSession(session, NO_TOOLS);

    const [command, args] = mockSpawn.mock.calls[0];
    expect(command).toBe('claude');
    expect(args).toEqual([
      '-p',
      '--system-prompt',
      'sys',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--disallowedTools',
      '*',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--safe-mode',
    ]);
  });

  it('includes --mcp-config and --model when tools/model are supplied', async () => {
    const { child } = fakeChild();
    mockSpawn.mockImplementationOnce(() => child);
    const session = createSession();

    await getOrCreateSession(session, {
      tools: [ECHO_TOOL],
      systemPrompt: 'sys',
      model: 'claude-sonnet-5',
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--mcp-config');
    const modelIndex = args.indexOf('--model');
    expect(args[modelIndex + 1]).toBe('claude-sonnet-5');
  });

  it('reuses the same process for a second call on the same handle with a compatible binding', async () => {
    const { child } = fakeChild();
    mockSpawn.mockImplementationOnce(() => child);
    const session = createSession();

    const s1 = await getOrCreateSession(session, NO_TOOLS);
    const s2 = await getOrCreateSession(session, NO_TOOLS);

    expect(s1).toBe(s2);
    expect(mockSpawn).toHaveBeenCalledTimes(1); // one process served both calls
  });

  it('refuses a rebind with a different systemPrompt/model/tools on a still-live handle', async () => {
    const { child } = fakeChild();
    mockSpawn.mockImplementationOnce(() => child);
    const session = createSession();
    await getOrCreateSession(session, { tools: [], systemPrompt: 'sys A', model: undefined });

    await expect(
      getOrCreateSession(session, { tools: [], systemPrompt: 'sys B', model: undefined })
    ).rejects.toThrow(/already bound to a different systemPrompt\/model\/tool set/);
    expect(mockSpawn).toHaveBeenCalledTimes(1); // no respawn attempted for an incompatible rebind
  });

  describe('dead-handle safety', () => {
    it('a handle that was never used spawns fresh', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession(); // never used before this call

      await getOrCreateSession(session, NO_TOOLS);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('presenting a handle whose process already exited respawns rather than erroring', async () => {
      const first = fakeChild();
      mockSpawn.mockImplementationOnce(() => first.child);
      const session = createSession();
      await getOrCreateSession(session, NO_TOOLS);

      // The process dies between turns — a real crash, not a call this
      // adapter made.
      first.child.emit('close', 1, null);

      const second = fakeChild();
      mockSpawn.mockImplementationOnce(() => second.child);
      const s2 = await getOrCreateSession(session, NO_TOOLS);

      expect(s2.child).toBe(second.child);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent first use of a fresh handle', () => {
    it('two getOrCreateSession calls fired without awaiting spawn exactly ONE process, not two — the check-then-act race a review caught', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      // Fired back-to-back, WITHOUT awaiting between them — exactly the
      // shape the review's finding described: two calls racing past the
      // same check-then-act window on a handle that has never been used.
      // Real (unmocked) createToolBridge is deliberately in play here —
      // its genuine async fs/socket work is exactly what created the
      // window this test exists to close.
      const p1 = getOrCreateSession(session, {
        tools: [ECHO_TOOL],
        systemPrompt: 'sys',
        model: undefined,
      });
      const p2 = getOrCreateSession(session, {
        tools: [ECHO_TOOL],
        systemPrompt: 'sys',
        model: undefined,
      });

      const [s1, s2] = await Promise.all([p1, p2]);

      expect(s1).toBe(s2); // both calls got the SAME session, not two
      expect(mockSpawn).toHaveBeenCalledTimes(1); // exactly one process spawned
    });

    it('two getOrCreateSession calls on the same fresh handle with an INCOMPATIBLE second binding refuse the second, rather than silently rebinding mid-spawn', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      const p1 = getOrCreateSession(session, {
        tools: [ECHO_TOOL],
        systemPrompt: 'sys A',
        model: undefined,
      });
      const p2 = getOrCreateSession(session, {
        tools: [], // deliberately different — the two calls disagree on binding
        systemPrompt: 'sys B',
        model: undefined,
      });
      p1.catch(() => {});
      p2.catch(() => {});

      const settled = await Promise.allSettled([p1, p2]);
      const fulfilled = settled.filter((r) => r.status === 'fulfilled');
      const rejected = settled.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toMatch(
        /already bound to a different systemPrompt\/model\/tool/
      );
      expect(mockSpawn).toHaveBeenCalledTimes(1); // one spawn regardless of which call won
    });
  });

  describe('closeSession', () => {
    it('kills the live process behind a handle', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();
      await getOrCreateSession(session, NO_TOOLS);

      await closeSession(session);

      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on an unknown or already-closed handle', async () => {
      const session = createSession(); // never used
      await expect(closeSession(session)).resolves.toBeUndefined();
      await expect(closeSession(session)).resolves.toBeUndefined(); // idempotent
    });
  });

  describe('turn execution (wave 2b)', () => {
    it('writes the turn as a stream-json user message line', async () => {
      const { child, written, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => emitLine({ type: 'result', result: 'ok' }));
        return child;
      });
      const session = createSession();

      await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'hello',
        tools: [],
        maxToolCalls: 0,
      });

      expect(JSON.parse(written[0])).toEqual({
        type: 'user',
        message: { role: 'user', content: 'hello' },
      });
    });

    it('reuses the same process for a second turn on the same handle', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      setImmediate(() => emitLine({ type: 'result', result: 'first' }));
      const r1 = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      setImmediate(() => emitLine({ type: 'result', result: 'second' }));
      const r2 = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'b',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r1.text).toBe('first');
      expect(r2.text).toBe('second');
      expect(mockSpawn).toHaveBeenCalledTimes(1); // one process served both turns
    });

    it('counts assistant stream events before the terminal result as the iteration proxy', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => {
          emitLine({ type: 'assistant' });
          emitLine({ type: 'assistant' });
          emitLine({ type: 'result', result: 'done' });
        });
        return child;
      });
      const session = createSession();

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.assistantEventCount).toBe(2);
    });

    it('ignores a malformed stream-json line rather than failing the turn', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { child, emitRaw, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => {
          emitRaw('not json at all\n');
          emitLine({ type: 'result', result: 'ok' });
        });
        return child;
      });
      const session = createSession();

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.text).toBe('ok');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid'));
      warn.mockRestore();
    });

    it('throws when the terminal envelope reports is_error: true', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() =>
          emitLine({ type: 'result', is_error: true, subtype: 'error_max_turns', result: 'nope' })
        );
        return child;
      });
      const session = createSession();

      await expect(
        runSessionTurn({ session, systemPrompt: 'sys', message: 'a', tools: [], maxToolCalls: 0 })
      ).rejects.toThrow(/is_error: true.*nope/);
    });

    it('a process dying WHILE a turn is pending rejects that turn, rather than hanging', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      const pending = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      setImmediate(() => child.emit('close', 1, null));

      await expect(pending).rejects.toThrow(/mid-turn/);
    });

    it('refuses a second turn on a handle that already has one in flight', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      const first = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      await expect(
        runSessionTurn({ session, systemPrompt: 'sys', message: 'b', tools: [], maxToolCalls: 0 })
      ).rejects.toThrow(/already has a turn in flight/);

      // Settle the first turn so it doesn't leak an unhandled rejection warning.
      child.emit('close', 1, null);
      await expect(first).rejects.toThrow();
    });
  });

  describe('the per-turn watchdog', () => {
    it('kills the process and refuses rather than hanging when no terminal result event ever arrives', async () => {
      vi.useFakeTimers();
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      const pending = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      // Nothing ever arrives on stdout for this turn.
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(SESSION_TURN_TIMEOUT_MS + 1);
      await assertion;
      expect(child.kill).toHaveBeenCalledTimes(1);
    });
  });

  describe('abortSignal', () => {
    it('throws the signal reason before spawning, when already aborted at entry', async () => {
      const controller = new AbortController();
      controller.abort(new Error('budget exceeded'));
      const session = createSession();

      await expect(
        runSessionTurn({
          session,
          systemPrompt: 'sys',
          message: 'a',
          tools: [],
          maxToolCalls: 0,
          signal: controller.signal,
        })
      ).rejects.toThrow('budget exceeded');
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('kills the held process and rejects with the signal reason when aborted mid-turn', async () => {
      const { child } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();
      const controller = new AbortController();

      const pending = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
        signal: controller.signal,
      });
      controller.abort(new Error('aborted mid-call'));

      await expect(pending).rejects.toThrow('aborted mid-call');
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    // NOT covered in this wave, deliberately: result-then-abort on a
    // reused AbortController. See this file's commit message / the
    // KNOWN LIMITATION comments in session.ts — that scenario currently
    // DOES incorrectly kill the session, and the regression test proving
    // both the bug and its fix lands in wave 4 of this split, alongside
    // the fix itself, rather than being added here to document a defect
    // this wave isn't fixing.
  });

  describe('the confirmed real envelope shape', () => {
    // Taken, field-for-field, from a real operator-run invocation (see
    // session.ts's WIRE-SHAPE VERIFICATION HISTORY, above the
    // SESSION_TURN_TIMEOUT_MS declaration) that failed on expired OAuth.
    // Confirms two things at once: unmodeled fields don't break parsing,
    // and is_error — never subtype, which reads "success" right alongside
    // it — is what this file treats as the failure signal.
    const REAL_AUTH_FAILURE_ENVELOPE = {
      duration_api_ms: 0,
      stop_reason: 'stop_sequence',
      session_id: '71523995-3e20-4996-9149-7f41a76fa5a5',
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      terminal_reason: 'api_error',
      subagent_stats: { spawned: 0 },
      is_error: true,
      num_turns: 1,
      subtype: 'success',
      api_error_status: null,
      result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      type: 'result',
      duration_ms: 430,
      uuid: 'c321f6ed-ffa8-41b1-bae5-baa548d3940d',
      queued_turn_count: 0,
      result_index: 0,
    };

    it('throws on is_error:true even though subtype reads "success" — subtype is never the failure signal', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => emitLine(REAL_AUTH_FAILURE_ENVELOPE));
        return child;
      });
      const session = createSession();

      await expect(
        runSessionTurn({ session, systemPrompt: 'sys', message: 'a', tools: [], maxToolCalls: 0 })
      ).rejects.toThrow(/is_error: true.*Failed to authenticate/);
    });

    it('does not choke on the unmodeled fields a real envelope carries alongside the ones this file reads', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() =>
          emitLine({ ...REAL_AUTH_FAILURE_ENVELOPE, is_error: false, result: 'ok' })
        );
        return child;
      });
      const session = createSession();

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.text).toBe('ok');
      expect(r.stopReason).toBe('stop_sequence');
    });
  });

  describe('permissionDenials', () => {
    it('is an empty array when the envelope has no permission_denials field at all', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => emitLine({ type: 'result', result: 'ok' }));
        return child;
      });
      const session = createSession();

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.permissionDenials).toEqual([]);
    });

    it('keeps a populated entry raw and extracts a best-effort toolName — shape is UNCONFIRMED, never seen non-empty on a real invocation', async () => {
      const { child, emitLine } = fakeChild();
      const denial = { tool_name: 'Bash', reason: 'not allowed in this session' };
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() =>
          emitLine({ type: 'result', result: 'ok', permission_denials: [denial] })
        );
        return child;
      });
      const session = createSession();

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.permissionDenials).toEqual([{ raw: denial, toolName: 'Bash' }]);
    });

    it('leaves toolName undefined — never guessed — when no candidate key holds a string', async () => {
      const { child, emitLine } = fakeChild();
      const denial = { code: 'PERMISSION_DENIED' };
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() =>
          emitLine({ type: 'result', result: 'ok', permission_denials: [denial] })
        );
        return child;
      });
      const session = createSession();

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.permissionDenials).toEqual([{ raw: denial, toolName: undefined }]);
    });

    it('does not throw on a populated permission_denials — surfaced as data, per the is_error-only failure signal', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() =>
          emitLine({
            type: 'result',
            result: 'ok',
            is_error: false,
            permission_denials: [{ toolName: 'Bash' }],
          })
        );
        return child;
      });
      const session = createSession();

      await expect(
        runSessionTurn({ session, systemPrompt: 'sys', message: 'a', tools: [], maxToolCalls: 0 })
      ).resolves.toMatchObject({ text: 'ok' });
    });
  });

  describe('bounds', () => {
    it("does not evict a session while a turn is still in flight, even past the idle timeout — only the per-turn watchdog governs a turn's own length", async () => {
      vi.useFakeTimers();
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      const pending = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      // Advance well past the idle timeout while the turn is still pending —
      // a long single turn must stay safe; only a long GAP between turns
      // should ever trip the idle timer.
      await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS + 1);
      expect(child.kill).not.toHaveBeenCalled();

      emitLine({ type: 'result', result: 'done' });
      const r = await pending;
      expect(r.text).toBe('done');
    });

    it('resumes the idle countdown only once a turn settles, so a gap AFTER that point does evict', async () => {
      vi.useFakeTimers();
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => child);
      const session = createSession();

      const p1 = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      emitLine({ type: 'result', result: 'first' });
      await p1;

      await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS + 1);
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it('kills an idle session after SESSION_IDLE_TIMEOUT_MS and respawns fresh on the next use', async () => {
      vi.useFakeTimers();
      const first = fakeChild();
      mockSpawn.mockImplementationOnce(() => first.child);
      const session = createSession();
      await getOrCreateSession(session, NO_TOOLS);

      await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS + 1);
      expect(first.child.kill).toHaveBeenCalledTimes(1);

      const second = fakeChild();
      mockSpawn.mockImplementationOnce(() => second.child);
      const s2 = await getOrCreateSession(session, NO_TOOLS);

      expect(s2.child).toBe(second.child);
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

    it('evicts the least-recently-used session once more than SESSION_MAX_HELD are live', async () => {
      const children: ReturnType<typeof fakeChild>[] = [];
      const sessions = Array.from({ length: SESSION_MAX_HELD + 1 }, () => createSession());

      for (let i = 0; i < sessions.length; i++) {
        const c = fakeChild();
        children.push(c);
        mockSpawn.mockImplementationOnce(() => c.child);
        await getOrCreateSession(sessions[i], {
          tools: [],
          systemPrompt: `sys ${i}`, // distinct binding per handle — no incompatible-rebind collision
          model: undefined,
        });
      }

      // The FIRST session created (least recently used, since it was
      // never touched again) should have been evicted to make room.
      expect(children[0].child.kill).toHaveBeenCalledTimes(1);
      // The most recently used ones are still live.
      expect(children[children.length - 1].child.kill).not.toHaveBeenCalled();
    });
  });
});
