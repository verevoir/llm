import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSpawn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

import {
  chat,
  chatWithTools,
  chatWithToolLoop,
  closeSession,
  createSession,
  resetClaudeCliSessionsForTests,
  resetClaudeCliVersionCacheForTests,
} from './index.js';
import type { ToolDef, ToolUse } from '../index.js';

function fakeSessionChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  const written: string[] = [];
  child.stdin = { write: (s: string) => written.push(s), end: () => {} };
  return {
    child,
    written,
    emitLine: (obj: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')),
  };
}

/** Queues one `claude --version` spawn (the single-shot path's own
 * `runClaudeCli`, used by `resolveCliVersion`) — needed because both
 * `chat()`'s session branch and `chatWithToolLoop` call it after every
 * turn resolves. Memoized process-wide, so only the FIRST call in a
 * given test needs one queued. */
function queueVersionSpawn(output = '2.1.243 (Claude Code)') {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (s: string) => void; end: () => void };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  mockSpawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(output));
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

describe('claude-cli chat(session) / chatWithTools / chatWithToolLoop', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    resetClaudeCliVersionCacheForTests();
    resetClaudeCliSessionsForTests();
  });

  afterEach(() => {
    resetClaudeCliSessionsForTests();
  });

  describe('chatWithTools', () => {
    it('always refuses, naming why, without spawning anything', async () => {
      await expect(
        chatWithTools({
          systemPrompt: 'sys',
          turns: [{ role: 'user', content: 'q' }],
          tools: [ECHO_TOOL],
        })
      ).rejects.toThrow(/not supported on this transport.*chatWithToolLoop/s);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('chat() with a session', () => {
    it('runs one turn on the held session and reports usage/route', async () => {
      const { child, emitLine } = fakeSessionChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() =>
          emitLine({
            type: 'result',
            result: 'hi there',
            usage: { input_tokens: 3, output_tokens: 2 },
          })
        );
        return child;
      });
      queueVersionSpawn();
      const session = createSession();

      const reply = await chat({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'hello' }],
        session,
      });

      expect(reply.content).toBe('hi there');
      expect(reply.usage.route).toBe('subscription-oauth');
      expect(reply.usage.inputTokens).toBe(3);
    });

    it('refuses more than one turn — a held session already remembers everything before it', async () => {
      const session = createSession();
      await expect(
        chat({
          systemPrompt: 'sys',
          turns: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
          ],
          session,
        })
      ).rejects.toThrow(/exactly the ONE new message/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('refuses a supplied apiKey rather than silently ignoring it', async () => {
      const session = createSession();
      await expect(
        chat({
          systemPrompt: 'sys',
          turns: [{ role: 'user', content: 'q' }],
          session,
          apiKey: 'sk-byok',
        })
      ).rejects.toThrow(/does not accept apiKey/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('chatWithToolLoop', () => {
    it('closes its own throwaway session after the call when none was supplied', async () => {
      const { child, emitLine } = fakeSessionChild();
      mockSpawn.mockImplementationOnce(() => {
        setImmediate(() => emitLine({ type: 'result', result: 'done' }));
        return child;
      });
      queueVersionSpawn();

      await chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'go' }],
        tools: [ECHO_TOOL],
        executor: async () => 'never called in this test',
      });

      expect(child.kill).toHaveBeenCalledTimes(1); // the throwaway session was torn down
    });

    it('reuses the process across two calls on an explicit session', async () => {
      const { child, written, emitLine } = fakeSessionChild();
      mockSpawn.mockImplementationOnce(() => child);
      queueVersionSpawn();
      const session = createSession();

      const p1 = chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'a' }],
        tools: [ECHO_TOOL],
        executor: async () => 'x',
        session,
      });
      // written[0] only exists once session.pending has been set and the
      // turn's line has actually reached stdin.write — the precise point
      // after which it's safe to emit the reply, regardless of how long
      // createToolBridge's real I/O (TCP listen, mkdtemp, writeFile) took
      // to get there.
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(0));
      emitLine({ type: 'result', result: 'first' });
      await p1;

      const p2 = chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'b' }],
        tools: [ECHO_TOOL],
        executor: async () => 'x',
        session,
      });
      await vi.waitFor(() => expect(written.length).toBeGreaterThan(1));
      emitLine({ type: 'result', result: 'second' });
      const r2 = await p2;

      expect(r2.text).toBe('second');
      expect(child.kill).not.toHaveBeenCalled(); // held open across both calls
      expect(mockSpawn).toHaveBeenCalledTimes(2); // one process spawn + one memoized version spawn

      await closeSession(session);
    });

    it('drives a real tool call through the MCP bridge and reports it on the result', async () => {
      const { child, written, emitLine } = fakeSessionChild();
      mockSpawn.mockImplementationOnce(() => child);
      queueVersionSpawn();
      const seen: ToolUse[] = [];

      const resultPromise = chatWithToolLoop({
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'call echo' }],
        tools: [ECHO_TOOL],
        executor: async (use) => {
          seen.push(use);
          return `echoed:${JSON.stringify(use.input)}`;
        },
        maxIterations: 3,
      });

      // Recover the bridge's port the same way the real shim would: read
      // the --mcp-config this call's spawn was given, then the shim
      // script it names, then the PORT constant baked into it.
      await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(1));
      const [, args] = mockSpawn.mock.calls[0];
      const mcpConfigPath = args[args.indexOf('--mcp-config') + 1];
      const config = JSON.parse(await readFile(mcpConfigPath, 'utf8'));
      const scriptPath = config.mcpServers['llm-tools'].args[0];
      const script = await readFile(scriptPath, 'utf8');
      const port = Number(script.match(/const PORT = (\d+);/)![1]);

      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.write(JSON.stringify({ id: 't1', name: 'echo', arguments: { text: 'hi' } }) + '\n');
      });
      await new Promise<void>((resolve) => socket.once('data', () => resolve()));
      socket.end();

      emitLine({ type: 'assistant' });
      emitLine({ type: 'result', result: 'all done', stop_reason: 'end_turn' });

      const result = await resultPromise;

      expect(seen).toEqual([{ id: 't1', name: 'echo', input: { text: 'hi' } }]);
      expect(result.text).toBe('all done');
      expect(result.toolUses).toEqual([{ id: 't1', name: 'echo', input: { text: 'hi' } }]);
      expect(result.toolResults).toEqual([
        { toolUseId: 't1', content: 'echoed:{"text":"hi"}', isError: false },
      ]);
      expect(result.iterations).toBe(1); // one assistant event observed
      expect(JSON.parse(written[0])).toEqual({
        type: 'user',
        message: { role: 'user', content: 'call echo' },
      });
    });

    it('requires at least one tool', async () => {
      await expect(
        chatWithToolLoop({
          systemPrompt: 'sys',
          turns: [{ role: 'user', content: 'q' }],
          tools: [],
          executor: async () => 'x',
        })
      ).rejects.toThrow(/at least one tool/);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
