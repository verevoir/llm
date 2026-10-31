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
import { afterEach, describe, expect, it } from 'vitest';

import { chat } from './index.js';

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
    process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = ms;
  }

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    else delete process.env.PATH;
    if (stubDir !== undefined) rmSync(stubDir, { recursive: true, force: true });
    stubDir = undefined;
    originalPath = undefined;
    if (originalIdleOverride === undefined) delete process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS;
    else process.env.CLAUDE_CLI_IDLE_TIMEOUT_MS = originalIdleOverride;
    originalIdleOverride = undefined;
    if (pidFileToClean !== undefined) {
      rmSync(pidFileToClean, { force: true });
      pidFileToClean = undefined;
    }
  });

  it('a silent child (no stdout/stderr ever) is killed and rejects as could-not-run, naming the idle gap', async () => {
    setIdleOverride('80');
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

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('reviewer produced no output for 80ms');
    // Never a plain hang reported as something else, and never approved —
    // this IS the rejection chat()'s own catch wraps into its existing
    // "could not run the claude CLI" could-not-run outcome.
    expect((error as Error).message).not.toContain('VERDICT');

    // Give the OS a moment to actually finish terminating the process the
    // SIGTERM was sent to, then confirm it is genuinely gone — not merely
    // abandoned to finish in the background.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10_000);

  it('a periodic writer that runs well past the idle budget IN TOTAL is never timed out — only a GAP trips it', async () => {
    setIdleOverride('100');
    // Emits a chunk every 30ms, ten times (~300ms total — three times the
    // 100ms idle budget), then a real result event and a clean exit. Each
    // chunk must reset the idle timer; cumulative runtime must never be
    // read as idleness.
    writeStubClaude(
      `process.stdout.write(${JSON.stringify(INIT_LINE)});\n` +
        `let n = 0;\n` +
        `const iv = setInterval(() => {\n` +
        `  n++;\n` +
        `  if (n >= 10) {\n` +
        `    clearInterval(iv);\n` +
        `    process.stdout.write(JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');\n` +
        `    process.exit(0);\n` +
        `    return;\n` +
        `  }\n` +
        `  process.stdout.write(JSON.stringify({ type: 'assistant', n }) + '\\n');\n` +
        `}, 30);\n`
    );

    const reply = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });
    expect(reply.content).toBe('ok');
  }, 10_000);

  it('a normal, prompt completion resolves and leaves nothing pending (the timer is cleared, not merely outrun)', async () => {
    setIdleOverride('500');
    writeStubClaude(
      `process.stdout.write(${JSON.stringify(INIT_LINE)});\n` +
        `process.stdout.write(JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');\n` +
        `process.exit(0);\n`
    );

    const reply = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });
    expect(reply.content).toBe('done');

    // If `finish()` ever stopped clearing the idle timer on a clean close,
    // an unref'd timer wouldn't hang the process — but it WOULD still fire
    // later and call child.kill() on an already-exited child. Waiting past
    // the 500ms budget here and asserting nothing throws / no unhandled
    // rejection appears is the direct proof that didn't happen.
    await new Promise((resolve) => setTimeout(resolve, 600));
  }, 2_000);
});
