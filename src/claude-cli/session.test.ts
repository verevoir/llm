import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  closeSession,
  createSession,
  resetClaudeCliSessionsForTests,
  runSessionTurn,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_HELD,
  SESSION_TURN_TIMEOUT_MS,
} from './session.js';
import type { ToolDef } from '../index.js';

/** A fake `claude` child for the session-holding transport: stdout is an
 * EventEmitter tests push stream-json lines onto directly (`emitLine`),
 * stdin.write is recorded per call (one entry per turn written, since a
 * held session's stdin is never `.end()`-ed between turns), and `kill`
 * is a spy so eviction/teardown tests can assert the process was
 * actually asked to stop. Unlike `chat.test.ts`'s single-shot fixture,
 * this child stays "open" — no close is scheduled automatically. */
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

describe('claude-cli session lifecycle', () => {
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
    const { child, emitLine } = fakeChild();
    mockSpawn.mockImplementationOnce(() => {
      setImmediate(() => emitLine({ type: 'result', result: 'ok' }));
      return child;
    });
    const session = createSession();

    await runSessionTurn({
      session,
      systemPrompt: 'sys',
      message: 'hi',
      tools: [],
      maxToolCalls: 0,
    });

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
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--safe-mode',
    ]);
  });

  it('includes --mcp-config and --model when tools/model are supplied', async () => {
    const { child, emitLine } = fakeChild();
    mockSpawn.mockImplementationOnce(() => {
      setImmediate(() => emitLine({ type: 'result', result: 'ok' }));
      return child;
    });
    const session = createSession();

    await runSessionTurn({
      session,
      systemPrompt: 'sys',
      message: 'hi',
      tools: [ECHO_TOOL],
      executor: async () => 'x',
      maxToolCalls: 5,
      model: 'claude-sonnet-5',
    });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toContain('--mcp-config');
    const modelIndex = args.indexOf('--model');
    expect(args[modelIndex + 1]).toBe('claude-sonnet-5');
  });

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

  describe('dead-handle safety', () => {
    it('a handle that was never used spawns fresh — the same as one that died', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => emitLine({ type: 'result', result: 'ok' }));
        return child;
      });
      const session = createSession(); // never used before this call

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.text).toBe('ok');
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('presenting a handle whose process already exited respawns rather than erroring', async () => {
      const first = fakeChild();
      mockSpawn.mockImplementationOnce(() => first.child);
      const session = createSession();
      setImmediate(() => first.emitLine({ type: 'result', result: 'first' }));
      await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      // The process dies between turns — a real crash, not a call this
      // adapter made.
      first.child.emit('close', 1, null);

      const second = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => second.emitLine({ type: 'result', result: 'second' }));
        return second.child;
      });

      const r = await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'b',
        tools: [],
        maxToolCalls: 0,
      });

      expect(r.text).toBe('second');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
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
  });

  it('refuses a rebind with a different systemPrompt/model/tools on a still-live handle', async () => {
    const { child, emitLine } = fakeChild();
    mockSpawn.mockImplementationOnce(() => child);
    const session = createSession();
    setImmediate(() => emitLine({ type: 'result', result: 'first' }));
    await runSessionTurn({
      session,
      systemPrompt: 'sys A',
      message: 'a',
      tools: [],
      maxToolCalls: 0,
    });

    await expect(
      runSessionTurn({ session, systemPrompt: 'sys B', message: 'b', tools: [], maxToolCalls: 0 })
    ).rejects.toThrow(/already bound to a different systemPrompt\/model\/tool set/);
    expect(mockSpawn).toHaveBeenCalledTimes(1); // no respawn attempted for an incompatible rebind
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

  describe('closeSession', () => {
    it('kills the live process behind a handle', async () => {
      const { child, emitLine } = fakeChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => emitLine({ type: 'result', result: 'ok' }));
        return child;
      });
      const session = createSession();
      await runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });

      await closeSession(session);

      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it('is a no-op on an unknown or already-closed handle', async () => {
      const session = createSession(); // never used
      await expect(closeSession(session)).resolves.toBeUndefined();
      await expect(closeSession(session)).resolves.toBeUndefined(); // idempotent
    });
  });

  describe('bounds', () => {
    it('kills an idle session after SESSION_IDLE_TIMEOUT_MS and respawns fresh on the next use', async () => {
      vi.useFakeTimers();
      const first = fakeChild();
      mockSpawn.mockImplementationOnce(() => first.child);
      const session = createSession();
      const p1 = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'a',
        tools: [],
        maxToolCalls: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      first.emitLine({ type: 'result', result: 'first' });
      await p1;

      await vi.advanceTimersByTimeAsync(SESSION_IDLE_TIMEOUT_MS + 1);
      expect(first.child.kill).toHaveBeenCalledTimes(1);

      const second = fakeChild();
      mockSpawn.mockImplementationOnce(() => second.child);
      const p2 = runSessionTurn({
        session,
        systemPrompt: 'sys',
        message: 'b',
        tools: [],
        maxToolCalls: 0,
      });
      await vi.advanceTimersByTimeAsync(0);
      second.emitLine({ type: 'result', result: 'second' });
      const r2 = await p2;

      expect(r2.text).toBe('second');
      expect(mockSpawn).toHaveBeenCalledTimes(2);
    });

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

    it('evicts the least-recently-used session once more than SESSION_MAX_HELD are live', async () => {
      const children: ReturnType<typeof fakeChild>[] = [];
      const sessions = Array.from({ length: SESSION_MAX_HELD + 1 }, () => createSession());

      for (let i = 0; i < sessions.length; i++) {
        const c = fakeChild();
        children.push(c);
        mockSpawn.mockImplementationOnce(() => {
          setImmediate(() => c.emitLine({ type: 'result', result: `r${i}` }));
          return c.child;
        });
        await runSessionTurn({
          session: sessions[i],
          systemPrompt: `sys ${i}`, // distinct binding per handle — no incompatible-rebind collision
          message: 'a',
          tools: [],
          maxToolCalls: 0,
        });
      }

      // The FIRST session created (least recently used, since it was
      // never touched again) should have been evicted to make room.
      expect(children[0].child.kill).toHaveBeenCalledTimes(1);
      // The most recently used ones are still live.
      expect(children[children.length - 1].child.kill).not.toHaveBeenCalled();
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
  });
});
