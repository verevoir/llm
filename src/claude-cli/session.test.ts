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
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_HELD,
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

  describe('bounds', () => {
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
