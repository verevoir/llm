import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { chat } from './index.js';

/**
 * Real-binary integration test for this adapter's `chat()` — the one
 * that spawns the actual `claude` CLI, not a mock of it.
 *
 * WHY THIS EXISTS. Every other test in `chat.test.ts` mocks
 * `node:child_process`'s `spawn` — thorough for this file's own logic
 * (argument building, env filtering, exit-code/signal handling, JSON
 * parsing), but none of it has ever proven that this adapter's actual
 * `runClaudeCli`/`chat()` can invoke the real `claude` binary and parse
 * what comes back. This is that proof: one real round trip, through this
 * adapter's own exported `chat()`, nothing else.
 *
 * WHY IT IS OPT-IN, NOT ON BY DEFAULT. A real invocation spends real
 * usage on whatever subscription is logged in via `CLAUDE_CODE_OAUTH_TOKEN`
 * (or an interactive session) — a test that quietly costs money every time
 * `npm test` runs, on every contributor's machine and in CI, is its own
 * defect. Gated two ways, both using vitest's own `skipIf` rather than a
 * bespoke mechanism, so a skip here reads as an ordinary, visible
 * "skipped" in the runner's own summary — never silently absorbed into a
 * pass count, and never a build failure on a machine without `claude`:
 *
 *   1. `RUN_CLAUDE_CLI_INTEGRATION_TEST` must be set to exactly `'1'` —
 *      checked BEFORE anything in this file spawns a process at all.
 *      Unset (the default on every machine that has not deliberately
 *      opted in), the whole `describe` block below is skipped at
 *      collection time and `claude` is never even probed for, let alone
 *      invoked. This is the "never spend tokens on every run" gate.
 *   2. Even opted in, a `claude --version` preflight must succeed before
 *      the real round-trip test runs — if the binary is absent (ENOENT)
 *      or present but not logged in (non-zero exit), the single test
 *      below is individually skipped rather than failing the suite. This
 *      is the "never fail a build on a machine without claude" gate,
 *      independent of the opt-in flag, so an operator who opts in on a
 *      machine that happens not to have a working `claude` session still
 *      gets a clean skip rather than a red build.
 *
 * To actually run this test: `RUN_CLAUDE_CLI_INTEGRATION_TEST=1 npm test`,
 * on a machine where `claude` is installed and authenticated (interactive
 * login, or `CLAUDE_CODE_OAUTH_TOKEN` set via `claude setup-token`).
 */

const OPTED_IN = process.env.RUN_CLAUDE_CLI_INTEGRATION_TEST === '1';

/** Only spawns anything when opted in — an unset flag short-circuits
 * before this ever runs, so the default `npm test` never invokes
 * `claude` at all, not even for a version check. */
function claudeBinaryIsRunnable(): boolean {
  if (!OPTED_IN) return false;
  const result = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10_000 });
  return result.error === undefined && result.status === 0;
}

const CLAUDE_RUNNABLE = claudeBinaryIsRunnable();

describe.skipIf(!OPTED_IN)(
  'claudeCli.chat — real claude binary (opt-in integration test, spends real usage when it runs)',
  () => {
    it.skipIf(!CLAUDE_RUNNABLE)(
      "invokes the real claude CLI through this adapter's own chat() and gets back a parseable reply — skipped if claude is not installed or not logged in",
      async () => {
        const result = await chat({
          systemPrompt: 'You are a test fixture. Reply with exactly the single word: pong',
          turns: [{ role: 'user', content: 'ping' }],
        });

        // Minimal assertions — this proves the artifact and the real
        // dependency actually meet and produce something this adapter's
        // own parsing accepts, not a transcript-quality check.
        expect(typeof result.content).toBe('string');
        expect(result.content.length).toBeGreaterThan(0);
        expect(result.usage.provider).toBe('claude-cli');
        expect(result.usage.route).toBe('subscription-oauth');
        expect(typeof result.stopReason).toBe('string');
      },
      30_000
    );
  }
);
