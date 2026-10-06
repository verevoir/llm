import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chat } from './index.js';

/**
 * #289: a BEST-EFFORT SMOKE TEST, NOT the regression proof.
 *
 * This spawns a real `claude` stub and writes a >128KB prompt to it,
 * hoping to hit a genuine OS-level EPIPE on a closed pipe. A review
 * found this non-deterministic across environments: on at least one
 * real CI container, this exact scenario never raised EPIPE at all, so
 * it could not tell the fixed code from the broken code there — the
 * opposite of a regression test. The actual, environment-independent
 * proof is `chat.test.ts`'s "stdin EPIPE when the process exits before
 * reading it (#289, deterministic)" block, which exercises Node's own
 * no-listener-throws rule for EventEmitter directly, via a mock, rather
 * than hoping a real pipe-buffer race lands. This file is kept only as
 * an opportunistic real-process sanity check, allowed to be silent.
 */
describe('claudeCli.chat — EPIPE when the real CLI exits before reading stdin (#289, best-effort smoke, NOT the regression proof — see chat.test.ts)', () => {
  let stubDir: string | undefined;
  let originalPath: string | undefined;

  function writeStubClaude(script: string): void {
    stubDir = mkdtempSync(join(tmpdir(), 'claude-cli-epipe-stub-'));
    const claudePath = join(stubDir, 'claude');
    writeFileSync(claudePath, `#!/usr/bin/env node\n${script}\n`, 'utf8');
    chmodSync(claudePath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.platform === 'win32' ? ';' : ':'}${originalPath}`;
  }

  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    else delete process.env.PATH;
    if (stubDir !== undefined) rmSync(stubDir, { recursive: true, force: true });
    stubDir = undefined;
    originalPath = undefined;
  });

  it('(red until fixed) a >128KB prompt to a claude that exits 1 before reading stdin must reject with a typed, named failure — not crash the host', async () => {
    // Exits immediately, WITHOUT ever touching process.stdin — the
    // exact precondition the hypothesis names. Writes to stderr first
    // so the fixed failure path has something real to name.
    writeStubClaude(
      "process.stderr.write('stub claude: simulated early exit before reading stdin\\n'); " +
        'process.exit(1);'
    );

    // > 128KB — clears any OS pipe buffer (commonly 64KB on Linux)
    // deterministically, on every OS, not merely "usually".
    const bigContent = 'x'.repeat(200_000);

    await expect(
      chat({ systemPrompt: 'sys', turns: [{ role: 'user', content: bigContent }] })
    ).rejects.toThrow(/exited with code 1.*simulated early exit before reading stdin/s);
  }, 15_000);
});
