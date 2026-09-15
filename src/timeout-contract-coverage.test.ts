import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

/**
 * THE EXPLICIT ENTRY-POINT TABLE, AND WHY IT IS A TABLE RATHER THAN
 * INFERENCE.
 *
 * The timeout contract (see index.ts's own "Timeout contract" section
 * header) is only as good as its coverage: a `chat`-family export that
 * lands without going through `runWithTimeoutContract` or
 * `withTimeoutSignal` is a route silently outside the contract, reachable
 * with no conflict and no warning after an ordinary, clean merge — the
 * exact failure mode this whole change exists to close, reproduced by
 * the change itself if nothing enumerates its own coverage.
 *
 * An earlier draft of this file inferred entry points structurally
 * (`Object.keys(module)` filtered to a naming convention) specifically
 * to avoid a maintained list, on the reasoning that a maintained list
 * has the same omission problem one level up. That reasoning is
 * calibrated to a HUMAN failure mode — lists drift because people get
 * bored, forget, or don't notice — and doesn't transfer to whoever is
 * actually maintaining this one: an agent re-reads this whole file
 * every time it's touched and will not forget a row exists. So this is
 * built the other way round, deliberately: an EXPLICIT list below,
 * readable as documentation of what is covered and what is not, plus a
 * CHECK (the first describe block) that fails the moment this list and
 * reality diverge in either direction — a real export missing from the
 * table, or a table row naming an export that no longer exists. Do not
 * replace this table with a cleverer structural inference; the point of
 * it being explicit is that a person (or another agent) can read it and
 * know, without running anything, what this package currently promises.
 *
 * `covered: true` — this entry point is reachable ONLY through
 * `runWithTimeoutContract` or a bespoke `withTimeoutSignal` integration;
 * proved, not just claimed, by the second describe block below.
 * `covered: false` — a KNOWN, NAMED gap. An entry point outside the
 * contract must be visible here as outside it, never simply absent from
 * the table — the same posture `TIMEOUT_TEARDOWN_CONFIRMED` already
 * takes one layer down, for teardown rather than shape.
 */
type EntryPointName = 'chat' | 'chatWithTools' | 'chatWithToolLoop';

interface EntryPoint {
  route: string;
  /** Relative to THIS file (src/), matching this codebase's own
   * `.js`-suffixed-even-in-`.ts`-source import convention. */
  modulePath: string;
  fn: EntryPointName;
  /** `chatWithTools`/`chatWithToolLoop` refuse before the timeout check
   * if `tools` is empty — the behavioural test below supplies a single
   * placeholder tool so that refusal doesn't happen first and mask the
   * one this file actually wants to observe. */
  needsTools: boolean;
  covered: boolean;
  note: string;
}

const ENTRY_POINTS: EntryPoint[] = [
  // ── anthropic — the exemplar: bespoke teardown, not just shape. ──────
  {
    route: 'anthropic',
    modulePath: './anthropic/index.js',
    fn: 'chat',
    needsTools: false,
    covered: true,
    note: 'bespoke: withTimeoutSignal threaded into messages.stream; client.ts neutralises maxRetries/timeout at construction',
  },
  {
    route: 'anthropic',
    modulePath: './anthropic/index.js',
    fn: 'chatWithTools',
    needsTools: true,
    covered: true,
    note: 'bespoke: withTimeoutSignal threaded into messages.stream',
  },
  {
    route: 'anthropic',
    modulePath: './anthropic/index.js',
    fn: 'chatWithToolLoop',
    needsTools: true,
    covered: true,
    note: 'bespoke: withTimeoutSignal threaded into every iteration, the OAuth fallback, and the final synthesis call',
  },

  // ── openai — generic wrap on chat() only. ────────────────────────────
  // chatWithTools/chatWithToolLoop do NOT exist on this PR's base
  // (main @ 2e3b485) — #49 (open, concurrent, additive) adds them. The
  // moment those exports land, the drift check below FAILS THE BUILD,
  // because they'd be exported and not listed here. That failure is the
  // mechanism working, not a defect in this file: it is what stops a
  // newly-added entry point from silently escaping the contract after a
  // clean merge. Fix: add two rows here (covered: true, same
  // runWithTimeoutContract wrap as chat()) in the PR that extends the
  // wrap to them — do not delete or weaken this comment to make the
  // check pass without doing that.
  {
    route: 'openai',
    modulePath: './openai/index.js',
    fn: 'chat',
    needsTools: false,
    covered: true,
    note: 'generic wrap (runWithTimeoutContract)',
  },

  // ── deepseek — generic wrap on chat() only, over the CURRENT hand- ───
  // rolled implementation. #49 (open, concurrent) replaces this file's
  // implementation entirely with a re-export of the same openai-compat
  // factory `mistral`/`samba` already use — at that point
  // deepseek.chat/chatWithTools/chatWithToolLoop become the identical
  // wrapped function objects listed under mistral/samba below, and this
  // table needs three deepseek rows (all covered: true, inherited
  // through the factory) instead of the current one. Until that update
  // lands, the drift check below will fail the same way the openai one
  // does — expected, not a bug.
  {
    route: 'deepseek',
    modulePath: './deepseek/index.js',
    fn: 'chat',
    needsTools: false,
    covered: true,
    note: 'generic wrap (runWithTimeoutContract) — hand-rolled implementation, pre-#49',
  },

  // ── google — all three existed on this PR's base; full generic wrap. ─
  {
    route: 'google',
    modulePath: './google/index.js',
    fn: 'chat',
    needsTools: false,
    covered: true,
    note: 'generic wrap (runWithTimeoutContract)',
  },
  {
    route: 'google',
    modulePath: './google/index.js',
    fn: 'chatWithTools',
    needsTools: true,
    covered: true,
    note: 'generic wrap (runWithTimeoutContract)',
  },
  {
    route: 'google',
    modulePath: './google/index.js',
    fn: 'chatWithToolLoop',
    needsTools: true,
    covered: true,
    note: 'generic wrap (runWithTimeoutContract)',
  },

  // ── mistral / samba — thin configuration over the shared OpenAI- ─────
  // compatible factory (src/openai-compat.ts). These three exports per
  // route ARE the factory's own chat/chatWithTools/chatWithToolLoop
  // function objects — wrapped exactly once, in openai-compat.ts, and
  // inherited here, not wrapped per-route.
  {
    route: 'mistral',
    modulePath: './mistral/index.js',
    fn: 'chat',
    needsTools: false,
    covered: true,
    note: 'generic wrap via the shared openai-compat factory',
  },
  {
    route: 'mistral',
    modulePath: './mistral/index.js',
    fn: 'chatWithTools',
    needsTools: true,
    covered: true,
    note: 'generic wrap via the shared openai-compat factory',
  },
  {
    route: 'mistral',
    modulePath: './mistral/index.js',
    fn: 'chatWithToolLoop',
    needsTools: true,
    covered: true,
    note: 'generic wrap via the shared openai-compat factory',
  },
  {
    route: 'samba',
    modulePath: './samba/index.js',
    fn: 'chat',
    needsTools: false,
    covered: true,
    note: 'generic wrap via the shared openai-compat factory',
  },
  {
    route: 'samba',
    modulePath: './samba/index.js',
    fn: 'chatWithTools',
    needsTools: true,
    covered: true,
    note: 'generic wrap via the shared openai-compat factory',
  },
  {
    route: 'samba',
    modulePath: './samba/index.js',
    fn: 'chatWithToolLoop',
    needsTools: true,
    covered: true,
    note: 'generic wrap via the shared openai-compat factory',
  },

  // ── claude-cli — the exemplar this WHOLE contract was lifted from, ───
  // and the one entry point this PR deliberately does not wrap: its
  // session.ts/index.ts are under active, same-day development on the
  // concurrent #45 branch (see this PR's own body for why touching
  // either risked a collision). Its SESSION_TURN_TIMEOUT_MS watchdog is
  // real and pre-dates this contract, but chat() here does not read
  // ChatOptions.timeoutMs at all — a caller who sets it today has that
  // option silently accepted and ignored, not refused. KNOWINGLY
  // uncovered; recorded here as exactly that, not merely missing.
  {
    route: 'claude-cli',
    modulePath: './claude-cli/index.js',
    fn: 'chat',
    needsTools: false,
    covered: false,
    note: 'ChatOptions.timeoutMs is accepted and silently ignored — follow-up once #45 lands, see CHANGELOG',
  },
];

function groupByRoute(): Map<string, { modulePath: string; entries: EntryPoint[] }> {
  const byRoute = new Map<string, { modulePath: string; entries: EntryPoint[] }>();
  for (const e of ENTRY_POINTS) {
    const existing = byRoute.get(e.route);
    if (existing) existing.entries.push(e);
    else byRoute.set(e.route, { modulePath: e.modulePath, entries: [e] });
  }
  return byRoute;
}

describe('timeout-contract coverage — the explicit table vs. reality (drift check, both directions)', () => {
  const byRoute = groupByRoute();

  it('lists exactly one module path per route — a route split across two paths would defeat every check below', () => {
    for (const [route, { entries }] of byRoute) {
      const modulePaths = new Set(entries.map((e) => e.modulePath));
      expect(modulePaths.size, `${route} has rows pointing at different module paths`).toBe(1);
    }
  });

  for (const [route, { modulePath, entries }] of byRoute) {
    it(`${route}: every listed entry point is really exported, and every exported chat-family function is listed`, async () => {
      const mod = (await import(modulePath)) as Record<string, unknown>;
      const listedNames = new Set(entries.map((e) => e.fn));
      const exportedChatFamily = Object.keys(mod).filter((k) =>
        /^chat(WithTools|WithToolLoop)?$/.test(k)
      );

      for (const name of listedNames) {
        expect(
          typeof mod[name],
          `${route}.${name} is listed in ENTRY_POINTS but is not exported as a function from ` +
            `${modulePath} — the table is stale (renamed or removed); fix the table, not this test.`
        ).toBe('function');
      }

      for (const name of exportedChatFamily) {
        expect(
          listedNames.has(name as EntryPointName),
          `${route}.${name} is exported from ${modulePath} but is NOT in ENTRY_POINTS — a chat-` +
            'family entry point was added (by this branch or by a merge) without its coverage ' +
            'being recorded, which is exactly the silent-omission failure this table exists to ' +
            'catch. Add a row: covered: true if it goes through runWithTimeoutContract / ' +
            'withTimeoutSignal, covered: false with a note otherwise.'
        ).toBe(true);
      }
    });
  }

  it('every published subpath in package.json has rows here, and every route here is a real published subpath', () => {
    const pkgPath = path.resolve(fileURLToPath(import.meta.url), '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { exports: Record<string, unknown> };
    const publishedRoutes = Object.keys(pkg.exports)
      .filter((k) => k !== '.')
      .map((k) => k.replace(/^\.\//, ''));
    const listedRoutes = new Set(byRoute.keys());

    for (const route of publishedRoutes) {
      expect(
        listedRoutes.has(route),
        `package.json publishes "./${route}" but ENTRY_POINTS has no rows for it — a new ` +
          'provider subpath was added without recording its chat-family coverage.'
      ).toBe(true);
    }
    for (const route of listedRoutes) {
      expect(
        publishedRoutes.includes(route),
        `ENTRY_POINTS has rows for "${route}" but package.json does not publish it — a stale ` +
          'route was left in the table after its subpath was removed.'
      ).toBe(true);
    }
  });
});

describe('timeout-contract coverage — behavioural: every covered:true entry point genuinely goes through the contract', () => {
  // resolveTimeoutMs (called first, synchronously, by both
  // runWithTimeoutContract and withTimeoutSignal — see index.ts) refuses
  // timeoutMs: 0 BEFORE any client is constructed or credential is read.
  // If a route's wrap is missing, absent, or bypassed, the call instead
  // proceeds into that route's own "no credential" throw — a DIFFERENT
  // message — so this assertion fails with a clear diff rather than
  // silently passing either way. Credentials are stripped so no route
  // can proceed past that point even if the wrap were somehow bypassed —
  // this test must never risk a real network call.
  const ENV_KEYS = [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'MISTRAL_API_KEY',
    'SAMBA_NOVA_API_KEY',
  ];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  for (const entry of ENTRY_POINTS.filter((e) => e.covered)) {
    it(`${entry.route}.${entry.fn}: timeoutMs is validated before any credential or client work`, async () => {
      const mod = (await import(entry.modulePath)) as Record<
        string,
        (options: Record<string, unknown>) => Promise<unknown>
      >;
      const fn = mod[entry.fn];
      const options: Record<string, unknown> = {
        systemPrompt: 'sys',
        turns: [{ role: 'user', content: 'hi' }],
        timeoutMs: 0,
      };
      if (entry.needsTools) {
        options.tools = [{ name: 'noop', description: 'noop' }];
      }

      await expect(fn(options)).rejects.toThrow(/finite number greater than 0/);
    });
  }

  it("claude-cli.chat is correctly recorded as covered: false — timeoutMs isn't validated there yet, disclosed rather than silently missing", () => {
    const entry = ENTRY_POINTS.find((e) => e.route === 'claude-cli' && e.fn === 'chat');
    expect(entry?.covered).toBe(false);
  });
});
