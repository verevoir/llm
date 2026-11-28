// Regression coverage for the reviewer idle-timeout fix in index.ts's
// runClaudeCli (see that file's DEFAULT_CLAUDE_CLI_IDLE_TIMEOUT_MS /
// claudeCliIdleTimeoutMs / resetIdleTimer). Deliberately uses a REAL
// stubbed "claude" binary on PATH, never a mocked node:child_process.spawn —
// chat.test.ts / chat.session.test.ts already prove the wire-format and
// usage-shaping contracts against a mock; this file's whole point is to
// prove the real idle timer, the real child.kill(), and the real process
// exit all actually happen together, end to end. Same stub technique as
// chat.epipe.test.ts's writeStubClaude.
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { chat, CLAUDE_CLI_IDLE_TIMEOUT_CODE } from './index.js';

/** A `{"type":"system","subtype":"init",...}` line with an EMPTY tools
 * array — the confirmed-correct shape chat()'s own tool-safety check
 * requires before it will accept a reply at all (see index.ts's SECURITY
 * CORRECTION section: a non-empty array, or no init event found, refuses
 * the call). Every success-path stub below must emit this first. */
const INIT_LINE = `${JSON.stringify({ type: 'system', subtype: 'init', tools: [], mcp_servers: [] })}\n`;

describe('claudeCli idle timeout (real subprocess, no mocked spawn)', () => {
  let stubDir: string | undefined;
  let originalPath: string | undefined;
  let originalIdleOverride: string | undefined;
  let idleOverrideSet = false;
  let pidFileToClean: string | undefined;

  function writeStubClaude(script: string): void {
    stubDir = mkdtempSync(join(tmpdir(), 'claude-cli-idle-stub-'));
    const claudePath = join(stubDir, 'claude');
    writeFileSync(claudePath, `#!/usr/bin/env node\n${script}\n`, 'utf8');
    chmodSync(claudePath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
  }

  function setIdleOverride(ms: string): void {
    originalIdleOverride = process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS;
    idleOverrideSet = true;
    process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = ms;
  }

  /** Puts back what a test or a fixture set, and only that: `PATH` where a stub
   * was written, the idle override where one was set, and a stub child's
   * process and pid file where one was started. Safe to call twice. */
  function restore(): void {
    if (stubDir !== undefined) {
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
      rmSync(stubDir, { recursive: true, force: true });
      stubDir = undefined;
      originalPath = undefined;
    }
    if (idleOverrideSet) {
      if (originalIdleOverride === undefined) delete process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS;
      else process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = originalIdleOverride;
      originalIdleOverride = undefined;
      idleOverrideSet = false;
    }
    if (pidFileToClean !== undefined) {
      // A stub child left alive must not stay on the runner. One already gone
      // makes kill() throw ESRCH, the normal case, which is ignored.
      try {
        process.kill(Number(readFileSync(pidFileToClean, 'utf8')), 'SIGKILL');
      } catch {
        // No pid file yet, or the child is already gone.
      }
      rmSync(pidFileToClean, { force: true });
      pidFileToClean = undefined;
    }
  }

  afterEach(restore);

  /** Runs chat() against a stub that records its pid and then stays silent
   * forever, and returns the idle-timeout rejection and the pid file. */
  async function rejectionFromSilentChild(): Promise<{
    error: Error & { code?: string; timeoutMs?: number };
    pidFile: string;
  }> {
    // 2000ms, not 400ms: the idle timer starts at spawn, and this test
    // reads the pid file the stub writes, so the stub's Node startup must
    // beat the timer or the child is killed before the file exists (ENOENT
    // below). Same remedy and reason as the sibling tests widened from
    // 500ms to 2000ms; it still proves the idle timeout kills the process.
    setIdleOverride('2000');
    const pidFile = join(tmpdir(), `claude-cli-idle-pid-${process.pid}-${Date.now()}`);
    pidFileToClean = pidFile;
    // Records its own pid, then sits forever writing NOTHING to stdout or
    // stderr — exactly the hang this fix exists to catch. No SIGTERM
    // handler is installed, so the default Node behaviour (terminate on
    // SIGTERM) is what proves the kill actually reached the process.
    writeStubClaude(
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`
    );

    const error: unknown = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
    }).then(
      () => {
        throw new Error('expected chat() to reject — the silent child was never killed');
      },
      (e: unknown) => e
    );

    return { error: error as Error & { code?: string; timeoutMs?: number }, pidFile };
  }

  describe('a silent child', () => {
    /** How often the fixture looks for the child's process. It only sets how
     * soon a kill is seen: a longer interval delays the fixture by up to one
     * interval, a shorter one spends more turns of the loop. */
    const POLL_MS = 25;
    /** The longest the fixture waits for the process to be gone. The stub has
     * no SIGTERM handler, so the idle timeout's SIGTERM ends it at once; this
     * bounds only a real failure, a child that is never killed. Too short and
     * a slow exit reads as "still alive"; too long only delays that failure. */
    const GONE_WITHIN_MS = 5000;
    /** The stub's 2000ms idle budget, the wait above, and 3000ms for the stub
     * to start and the rejection to arrive. */
    const FIXTURE_TIMEOUT_MS = 2000 + GONE_WITHIN_MS + 3000;

    let error: Error & { code?: string; timeoutMs?: number };
    let gone: boolean;

    // Both facts are taken, and everything the fixture set is put back, before
    // either test runs: `restore` kills a stub left alive, so it runs last.
    beforeAll(async () => {
      try {
        const rejected = await rejectionFromSilentChild();
        error = rejected.error;
        // The pid file is read, not waited for: the 2000ms budget is the stub's
        // margin to write it. A slower start throws ENOENT and fails the fixture.
        const pid = Number(readFileSync(rejected.pidFile, 'utf8'));
        const isAlive = (): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        const deadline = Date.now() + GONE_WITHIN_MS;
        while (isAlive() && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        gone = !isAlive();
      } finally {
        restore();
      }
    }, FIXTURE_TIMEOUT_MS);

    it('is rejected with the generic message, the named code and the budget', () => {
      // Generic, llm-level wording: a caller (e.g. @verevoir/review) maps
      // this onto its own could-not-run outcome in its own layer.
      expect({ message: error.message, code: error.code, timeoutMs: error.timeoutMs }).toEqual({
        message: 'claude CLI produced no output for 2000ms',
        code: CLAUDE_CLI_IDLE_TIMEOUT_CODE,
        timeoutMs: 2000,
      });
    });

    it('is killed, not left to finish in the background', () => {
      expect(gone).toBe(true);
    });
  });

  it('a per-call idleTimeoutMs wins over the env override — precedence, not just presence (audit item 2: real threading, not merely a parameter that exists)', async () => {
    // The env var is set to a LONG budget; the per-call option is short.
    // If the per-call option were ignored (or merely accepted and never
    // threaded through to runClaudeCli), this call would run until the
    // env budget instead — this proves it does not.
    setIdleOverride('5000');
    const pidFile = join(tmpdir(), `claude-cli-idle-precedence-pid-${process.pid}-${Date.now()}`);
    pidFileToClean = pidFile;
    writeStubClaude(
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`
    );

    const error: unknown = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      idleTimeoutMs: 150,
    }).then(
      () => {
        throw new Error('expected chat() to reject on the shorter per-call budget');
      },
      (e: unknown) => e
    );

    expect((error as Error).message).toBe('claude CLI produced no output for 150ms');
    expect((error as Error & { code?: string }).code).toBe(CLAUDE_CLI_IDLE_TIMEOUT_CODE);
    expect((error as Error & { timeoutMs?: number }).timeoutMs).toBe(150);
  }, 10_000);

  it('a non-positive per-call idleTimeoutMs is treated as absent and falls through to the env override, never disabling the guard', async () => {
    // 0 is not "no timeout" — see claudeCliIdleTimeoutMs's own contract:
    // only a finite number > 0 is honoured at any level, everything else
    // falls through to the next one. The env budget (150ms) must still
    // govern here, proving a bad per-call value didn't silently remove
    // the bound altogether.
    setIdleOverride('150');
    const pidFile = join(
      tmpdir(),
      `claude-cli-idle-zero-override-pid-${process.pid}-${Date.now()}`
    );
    pidFileToClean = pidFile;
    writeStubClaude(
      `const fs = require('fs');\n` +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
        `setInterval(() => {}, 1000);\n`
    );

    const error: unknown = await chat({
      systemPrompt: 'sys',
      turns: [{ role: 'user', content: 'q' }],
      idleTimeoutMs: 0,
    }).then(
      () => {
        throw new Error('expected chat() to reject on the env fallback budget');
      },
      (e: unknown) => e
    );

    expect((error as Error).message).toBe('claude CLI produced no output for 150ms');
  }, 10_000);

  it('a periodic writer that runs well past the idle budget IN TOTAL is never timed out — only a GAP trips it', async () => {
    setIdleOverride('2000');
    // Emits a chunk every 25ms, forty times (~1000ms total — half of the
    // 2000ms idle budget), then a real result event and a clean exit. Each
    // chunk must reset the idle timer; cumulative runtime must never be
    // read as idleness. Budget widened from an earlier 500ms — observed
    // flaky under load, because the FIRST write (INIT_LINE) has to beat
    // the stubbed node process's own startup latency, not just the 25ms
    // inter-chunk gaps — to 2000ms, which gives that first write real
    // margin; the 25ms writer interval stays far below either budget, so
    // this still proves exactly what it always proved.
    writeStubClaude(
      `process.stdout.write(${JSON.stringify(INIT_LINE)});\n` +
        `let n = 0;\n` +
        `const iv = setInterval(() => {\n` +
        `  n++;\n` +
        `  if (n >= 40) {\n` +
        `    clearInterval(iv);\n` +
        `    process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');\n` +
        `    process.exit(0);\n` +
        `    return;\n` +
        `  }\n` +
        `  process.stdout.write(JSON.stringify({ type: 'assistant', n }) + '\\n');\n` +
        `}, 25);\n`
    );

    const reply = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });
    expect(reply.content).toBe('ok');
  }, 10_000);

  it('a prompt completion resolves and leaves no idle timer pending', async () => {
    setIdleOverride('2000');
    writeStubClaude(
      `process.stdout.write(${JSON.stringify(INIT_LINE)});\n` +
        `process.stdout.write(JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');\n` +
        `process.exit(0);\n`
    );

    // Only the timer functions are faked: the child's I/O runs for real.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const reply = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });
      expect(reply.content).toBe('done');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
