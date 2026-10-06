import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { chat } from './index.js';

/**
 * #289: a real EPIPE crash hypothesis in claude-cli's `chat()`.
 *
 * `runClaudeCli` (index.ts) calls `child.stdin.write(input)` /
 * `child.stdin.end()` with NO `child.stdin.on('error', ...)` handler of
 * its own — only `child.on('error', ...)` (the whole-process spawn-level
 * failure, e.g. ENOENT) is wired. If the spawned `claude` process exits
 * BEFORE it ever reads stdin (e.g. an auth failure that exits non-zero
 * immediately), writing a payload LARGER than the OS pipe buffer
 * (commonly 64KB on Linux — this uses >128KB so EPIPE is deterministic
 * on every OS, not timing-dependent) raises EPIPE on the write. Node
 * emits that as an 'error' event on the `stdin` STREAM itself, distinct
 * from the child's own 'error' event — with zero listeners on it, Node
 * throws rather than swallows, an UNCAUGHT exception that can crash the
 * host process instead of giving `chat()` a normal, typed rejection.
 *
 * A REAL subprocess, not a mock: `chat.test.ts` mocks `node:child_process`
 * throughout, which cannot reproduce a genuine OS-level EPIPE at all — a
 * mocked `child.stdin.write()` never touches a real pipe. This test
 * instead PATH-prepends a real, tiny stub `claude` script that exits
 * non-zero without ever reading its own stdin, so the write genuinely
 * races a closed pipe.
 */
describe('claudeCli.chat — EPIPE when the real CLI exits before reading stdin (#289)', () => {
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
