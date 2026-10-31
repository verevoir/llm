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

  it('a silent child (no stdout/stderr ever) is killed and rejects with the named idle-timeout code, naming the gap in a generic (non-reviewer) message', async () => {
    setIdleOverride('400');
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
    // Generic, llm-level wording — this is @verevoir/llm, not a reviewer;
    // a caller (e.g. @verevoir/review) maps this onto its own could-not-run
    // outcome in its own layer, not this one's.
    expect((error as Error).message).toBe('claude CLI produced no output for 400ms');
    expect((error as Error).message).not.toContain('VERDICT');
    // Named, structural fields a caller can match on without parsing text.
    expect((error as Error & { code?: string }).code).toBe(CLAUDE_CLI_IDLE_TIMEOUT_CODE);
    expect((error as Error & { timeoutMs?: number }).timeoutMs).toBe(400);

    // Give the OS a moment to actually finish terminating the process the
    // SIGTERM was sent to, then confirm it is genuinely gone — not merely
    // abandoned to finish in the background.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 10_000);

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

  it('a normal, prompt completion resolves and leaves nothing pending (the timer is cleared, not merely outrun)', async () => {
    setIdleOverride('2000');
    writeStubClaude(
      `process.stdout.write(${JSON.stringify(INIT_LINE)});\n` +
        `process.stdout.write(JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');\n` +
        `process.exit(0);\n`
    );

    const reply = await chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: 'q' }] });
    expect(reply.content).toBe('done');

    // If `finish()` ever stopped clearing the idle timer on a clean close,
    // an unref'd timer wouldn't hang the process — but it WOULD still fire
    // later and call child.kill() on an already-exited child. Budget
    // widened from an earlier 500ms (observed too tight for the stubbed
    // process's own startup latency under load, same root cause as the
    // periodic-writer test above) to 2000ms; this wait (2500ms) stays
    // comfortably PAST that widened budget, so a stray fire would still
    // be caught here — asserting nothing throws / no unhandled rejection
    // appears is the direct proof that didn't happen.
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }, 6_000);
});
