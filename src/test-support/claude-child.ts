/**
 * A fake of `node:child_process` for the `/claude-cli` tests that mock it:
 *
 *   vi.mock('node:child_process', () => import('../test-support/claude-child.js'));
 *
 * `spawn` is a `vi.fn` each test scripts, usually to return a `fakeClaudeChild`.
 * Vitest gives each test file its own copy of this module.
 *
 * The build leaves this directory out (`tsconfig.build.json`), so nothing here
 * is published.
 */

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

export const spawn = vi.fn();

export type FakeClaudeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: {
    write: (s: string) => void;
    end: () => void;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  kill: ReturnType<typeof vi.fn>;
};

/**
 * A fake `claude` child: the child, its stdout and its stderr are
 * EventEmitters, as the adapter reads them; `stdin.write` records each write
 * in `written`; `stdin.end` and `stdin.on` do nothing; `kill` is a spy. The
 * test emits the output and the `close` itself, or through `emitLine` (one
 * stream-json line) and `emitRaw` (stdout text as given).
 */
export function fakeClaudeChild() {
  const written: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: {
      write: (s: string) => {
        written.push(s);
      },
      end: () => {},
      on: () => {},
    },
    kill: vi.fn(),
  }) as FakeClaudeChild;
  return {
    child,
    written,
    emitLine: (obj: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n')),
    emitRaw: (text: string) => child.stdout.emit('data', Buffer.from(text)),
  };
}

/** Queue one spawn: a child that writes `stdout` and then closes with code 0. */
export function queueClaudeOutput(stdout: string) {
  spawn.mockImplementationOnce(() => {
    const { child } = fakeClaudeChild();
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', 0, null);
    });
    return child;
  });
}
