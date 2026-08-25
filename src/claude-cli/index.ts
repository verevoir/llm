/**
 * @verevoir/llm/claude-cli — the Claude Code CLI (`claude -p`) as a
 * Reviewer-shaped provider, for callers that must run on a subscription
 * credential rather than a billed API key.
 *
 * WHY THIS EXISTS, RATHER THAN A SECOND CREDENTIAL ON THE ANTHROPIC
 * ADAPTER. The Anthropic Messages API accepts a subscription OAuth token
 * only for requests that present themselves AS Claude Code (see
 * anthropic/index.ts's `oauthSystemIdentity()`). Imitating that client to
 * the raw API was ruled out as a route: the sanctioned way to use a
 * subscription credential is to run the thing the credential actually
 * belongs to — `claude -p`, Claude Code's own non-interactive mode — and
 * let IT decide how to authenticate itself, rather than this library
 * forging its identity.
 *
 * PROVIDER ID IS `'claude-cli'`, DELIBERATELY DISTINCT FROM `'anthropic'`.
 * `TokenUsage.provider` is the caller-visible signal for "which substrate
 * actually served this call" — the whole reason `CredentialRoute` /
 * `TokenUsage.route` exists. A caller comparing this substrate against the
 * Messages-API one needs the two to be unmistakably different labels, not
 * two paths sharing a provider id that differ only in an internal detail
 * nobody reads.
 *
 * NEVER REGISTERED INTO THE SHARED MODEL CATALOG / CONNECTION REGISTRY —
 * no `registerModelCatalog`, no `registerProviderConnection`, on purpose.
 * Those exist so `resolveModel` / `resolveModelByTerm` can pick
 * transparently between interchangeable providers serving the same model
 * family — exactly the behaviour this adapter must NOT participate in. A
 * caller wanting this substrate imports and calls it directly, chosen
 * deliberately by whoever wires a panel together, never resolved by
 * policy. Registering this into the shared catalog would let
 * `resolveModelByTerm('sonnet')` transparently return either this adapter
 * or the real API adapter depending on which happens to be configured —
 * silently substituting one substrate for the other, which is the one
 * hazard this whole design exists to avoid.
 *
 * REFUSE, NEVER SUBSTITUTE. "Purchased API credits are for GitHub Actions
 * only" is not negotiable, so three independent mechanisms enforce it —
 * one failing must not silently open the others:
 *   1. Every billed-credential env var this library knows about is
 *      stripped from the CHILD process's environment before it is
 *      spawned — not merely left unset by omission, but deleted from a
 *      COPY of the parent env (see `STRIPPED_ENV_VARS`, `childEnv`). Even
 *      if the installed `claude` binary has its own undocumented fallback
 *      to a billed key when no subscription session is present, it has
 *      nothing to fall back TO.
 *   2. `route` is reported as the CONSTANT `'subscription-oauth'` — never
 *      computed — because with (1) in place, a call that succeeded at
 *      all can only have gone through the CLI's own logged-in session.
 *      There is no other route this call could have taken.
 *   3. A non-zero exit is thrown as a plain `Error`, never retried
 *      against a different credential. This adapter has exactly one
 *      credential path and no fallback ladder — unlike
 *      anthropic/index.ts's OAuth-then-API-key chain, which is the one
 *      precedent in this library that already does the silent
 *      substitution this design exists to avoid.
 *   4. `chat()` REFUSES a caller-supplied `apiKey` outright, rather than
 *      silently ignoring it — a caller passing one would reasonably
 *      believe it took effect. It never can: BYOK has no meaning for a
 *      subprocess that authenticates as whatever is already logged in.
 *
 * `--bare` WAS CONSIDERED AND REJECTED. It strips hooks, LSP, plugin
 * sync, attribution, auto-memory and CLAUDE.md auto-discovery —
 * genuinely the determinism this adapter wants — but its own `--help` is
 * explicit that under `--bare`, "Anthropic auth is strictly
 * ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain
 * are never read)." That means `--bare` either fails outright with no
 * key present, or spends the purchased key when one is set in the
 * environment — the exact violation this adapter exists to prevent,
 * arrived at via the flag that looks most correct for determinism.
 * `--safe-mode` is used instead: per its own `--help`, it disables the
 * same class of customisation (CLAUDE.md, skills, plugins, hooks, MCP
 * servers, custom commands/agents) while leaving "Auth, model selection,
 * built-in tools, and permissions" to work normally — determinism
 * without losing the subscription route.
 *
 * (This reasoning is built from the CLI's own `--help` text as relayed
 * this session by the operator, who ran the real binary — it has not
 * been independently reproduced by anything that built or tested this
 * file. See this change's PR body for exactly what remains unverified,
 * and do not treat the shapes below as confirmed until a real invocation
 * has been run and read.)
 *
 * `--tools ""` IS A POSITIVE DECLARATION, NOT AN OMISSION. Passing no
 * `--tools` flag at all might mean "use the CLI's default tool set" —
 * exactly the un-auditable absence the `route` field elsewhere in this
 * library was built to stop reproducing (the same shape of gap
 * `blankEnvVar` / `attemptSignals` closes on the governance side of this
 * work). `--tools ""` is stated, in the CLI's own `--help`, to disable
 * all tools — an explicit, checkable assertion that this reviewer call
 * had zero tool access, not an assumption resting on whatever the CLI
 * happens to default to.
 *
 * `--json-schema` WAS CONSIDERED AND REJECTED. It could enforce the
 * `VERDICT:` / `FINDING:` reply contract structurally instead of parsing
 * text — tempting, since it would remove a whole class of parsing risk.
 * Rejected because the Messages-API path (anthropic/index.ts) has no
 * equivalent mechanism: adopting it here would mean the two substrates
 * no longer run the same contract, and a cross-substrate comparison —
 * the entire point of building a second substrate at all — would
 * silently compare two different things while appearing to compare one.
 * Text out, parsed the same way on both substrates, is the point.
 *
 * `--output-format json`'S SHAPE IS UNVERIFIED BEYOND WHAT WAS RELAYED
 * THIS SESSION. `extractReply` below parses defensively for exactly that
 * reason — see its own comment.
 *
 * THIS IS `chat()` ONLY — no `chatWithTools` / `chatWithToolLoop`,
 * matching `google/index.ts`'s own staged-rollout precedent for a first
 * cut of an adapter (its header: "v0.4.0 ships chat() only... follow in
 * a subsequent release"). A tool-calling loop over a subprocess boundary
 * is a materially larger design than this reviewer use case needs, and
 * `--tools ""` makes it moot for this adapter's actual purpose anyway.
 *
 * SUBSTRATE VERSION IS RECORDED ON EVERY CALL, THE SAME WAY `route` IS.
 * Flags and auth behaviour can shift between `claude` CLI releases —
 * `--bare`'s own auth behaviour is exactly the kind of thing that could
 * change, and it is the difference between a subscription call and
 * spending purchased credits (see the file header above). A run whose
 * substrate version is not recorded cannot be attributed later if
 * behaviour changes after an upgrade — the same argument that produced
 * `route`, one level down (see `TokenUsage.substrateVersion` in
 * `../index.ts`). This also makes a controlled version-bump measurement
 * possible at all: same corpus, same lenses, same prompts, one version
 * bump, does the finding text change — that comparison needs every run to
 * carry the version it was made under, or "before" and "after" are
 * indistinguishable in the record.
 *
 * `resolveCliVersion()` below reads the payload first (checking whether
 * `--output-format json` already reports a version — unverified, so this
 * is speculative field-name matching, same posture as `extractReply`'s
 * text extraction) and falls back to a SEPARATE, MEMOIZED `claude
 * --version` spawn, cached for the lifetime of the process. The version
 * cannot change mid-run, so this never re-spawns per call — a second
 * process per reviewer call, purely to ask a value that is already known,
 * would double this adapter's process count for no new information.
 */

import { spawn } from 'node:child_process';
import { fireUsageHook } from '../audit-hook.js';
import type { ChatOptions, ChatReply, CredentialRoute, TokenUsage, TurnContent } from '../index.js';

/** Provider id reported on every {@link TokenUsage} this adapter returns —
 * see the file header for why this must never be `'anthropic'`. */
export const PROVIDER = 'claude-cli';

/** Billed-credential env vars stripped from the child process's environment
 * before every invocation. See the file header's "REFUSE, NEVER SUBSTITUTE". */
const STRIPPED_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FILE'] as const;

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/** Flags applied to every invocation. See the file header for why each one
 * is here, and why `--bare` / `--json-schema` are not used instead. */
function buildArgs(systemPrompt: string): string[] {
  return [
    '-p',
    '--system-prompt',
    systemPrompt,
    '--tools',
    '',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--safe-mode',
  ];
}

/**
 * Flatten a turn's content to plain text for the CLI's stdin. Per
 * {@link TurnContent}'s own contract ("adapters that don't support a given
 * block kind should surface a typed error rather than silently dropping
 * content"): a `tool_use` / `tool_result` block is meaningless here — this
 * adapter has no tool loop (`--tools ""` disables tools entirely) — so a
 * turn carrying one is refused rather than silently flattened away.
 */
function contentToText(content: TurnContent): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    throw new Error(
      `claudeCli: turn content block of type "${block.type}" is not supported — this adapter ` +
        'has no tool loop (--tools "" disables tools entirely), so a tool_use/tool_result ' +
        'block would be silently dropped rather than acted on. Use plain text turns.'
    );
  }
  return parts.join('\n');
}

/**
 * Multiple turns are joined as a labelled transcript — not equivalent to a
 * real multi-turn CLI session (there is none; see the file header, this
 * adapter is `chat()`-only, single-shot). Documented rather than silently
 * mishandled. The one real caller this adapter is built for (a governance
 * review lens) always supplies exactly one turn.
 */
function joinTurns(turns: ChatOptions['turns']): string {
  if (turns.length === 1) {
    return contentToText(turns[0].content);
  }
  return turns.map((t) => `## ${t.role}\n${contentToText(t.content)}`).join('\n\n');
}

/**
 * Best-effort field names for `--output-format json`'s envelope — pending
 * real verification (see the file header). Named fields not confirmed
 * present are optional so a shape lacking them still parses. `version` /
 * `cli_version` are speculative candidates for a substrate-version field,
 * on the same unverified footing as `result`/`content`/`text` for the
 * reply body — checked first so a real version in the payload costs
 * nothing extra to use; falls back to `resolveCliVersion()` when absent.
 */
interface ClaudeCliJsonResult {
  result?: string;
  content?: string;
  text?: string;
  version?: string;
  cli_version?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface ExtractedReply {
  text: string;
  usage: ClaudeCliJsonResult['usage'];
  /** A version string found directly in the payload, if the envelope
   * carried a recognised field for it — see `ClaudeCliJsonResult`'s own
   * comment. `undefined` when absent, which is the common case pending
   * confirmation of the real shape; the caller falls back to
   * `resolveCliVersion()` in that case. */
  versionFromPayload: string | undefined;
  /** True when stdout parsed as JSON and a known text field was found —
   * false means the raw-text fallback below was used, which is worth the
   * caller knowing about on first real runs (see the file header). */
  recognisedShape: boolean;
}

/**
 * Parse `--output-format json`'s stdout defensively, because its exact
 * shape was not independently confirmed from this environment (see the
 * file header). A recognised `result`/`content`/`text` field is used
 * directly; anything else degrades to treating the whole of stdout as the
 * reply text, exactly the same posture `parseReply` itself takes toward
 * its OWN input (scan for what's expected, don't fail hard on what
 * surrounds it) — but here it means an unrecognised envelope is silently
 * swallowed as if it were plain text, which could hide a real integration
 * break on first real use. `recognisedShape` surfaces that distinction
 * rather than hiding it.
 */
function extractReply(stdout: string): ExtractedReply {
  try {
    const parsed = JSON.parse(stdout) as ClaudeCliJsonResult;
    const text = parsed.result ?? parsed.content ?? parsed.text;
    if (typeof text === 'string') {
      return {
        text,
        usage: parsed.usage,
        versionFromPayload: parsed.version ?? parsed.cli_version,
        recognisedShape: true,
      };
    }
  } catch {
    // Not JSON at all — fall through to the raw-text fallback below.
  }
  return { text: stdout, usage: undefined, versionFromPayload: undefined, recognisedShape: false };
}

// ── Substrate version, memoized for the process's lifetime ──────────────
// See the file header's "SUBSTRATE VERSION IS RECORDED ON EVERY CALL" for
// why this exists and why it must not re-spawn per call.

let cachedCliVersionPromise: Promise<string | undefined> | null = null;

/** `claude --version`'s stdout is expected to read like `2.1.243 (Claude
 * Code)` — recorded verbatim, trimmed, rather than parsed into parts. Parsing
 * out just the number would assume a stable format this adapter has not
 * independently confirmed; the whole string is unambiguous and just as
 * usable for attribution. */
function parseVersionOutput(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Resolve the installed `claude` CLI's version by spawning `claude
 * --version` once and caching the result for every subsequent call in this
 * process. A failure (spawn error, non-zero exit, empty output) caches as
 * `undefined` rather than retrying — the version cannot change mid-run, so
 * a failed lookup is as stable a fact as a successful one, and retrying it
 * on every `chat()` call would reintroduce the extra spawn this exists to
 * avoid.
 */
function resolveCliVersion(): Promise<string | undefined> {
  if (!cachedCliVersionPromise) {
    cachedCliVersionPromise = (async () => {
      try {
        const { stdout, exitCode } = await runClaudeCli(['--version'], '');
        if (exitCode !== 0) return undefined;
        return parseVersionOutput(stdout);
      } catch {
        return undefined;
      }
    })();
  }
  return cachedCliVersionPromise;
}

/**
 * Test-only: clears the process-wide version cache so tests can observe
 * `resolveCliVersion()`'s spawn-and-cache behaviour in isolation rather
 * than inheriting a value memoized by an earlier test in the same run.
 * Never called from production code — the whole point of the cache is
 * that a real process only needs the version resolved once.
 */
export function resetClaudeCliVersionCacheForTests(): void {
  cachedCliVersionPromise = null;
}

function shapeUsage(
  usage: ClaudeCliJsonResult['usage'],
  substrateVersion: string | undefined
): TokenUsage {
  // Constant, never computed — see the file header's "REFUSE, NEVER
  // SUBSTITUTE" point 2 for why this is safe to assert rather than derive.
  const route: CredentialRoute = 'subscription-oauth';
  return {
    provider: PROVIDER,
    // No --model pin confirmed from what was relayed this session — this
    // adapter cannot yet guarantee which concrete model answered. See the
    // file header and this change's PR body.
    model: 'unknown',
    direction: 'reasoning',
    route,
    substrateVersion,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Runs the CLI once, writing `input` to its stdin and collecting stdout /
 * stderr / exit code. Separated from `chat()` so tests can mock exactly
 * this seam without reimplementing stream plumbing per test. Also used by
 * `resolveCliVersion()` for the (memoized, at most once per process)
 * `--version` invocation. */
function runClaudeCli(args: string[], input: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { env: childEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // e.g. ENOENT — claude is not on PATH at all. A spawn-level failure,
    // distinct from a non-zero exit; both end up refusing (see chat()).
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Single-shot call through `claude -p`. See the file header for every
 * flag's justification and every refuse-rather-than-substitute mechanism.
 */
export async function chat(options: ChatOptions): Promise<ChatReply> {
  if (options.turns.length === 0) {
    throw new Error('claudeCli.chat() requires at least one turn');
  }
  if (options.apiKey != null) {
    // Refused, not silently ignored — see the file header, point 4.
    throw new Error(
      "claudeCli.chat() does not accept apiKey — it always uses the CLI's own logged-in " +
        'subscription session, never a supplied credential.'
    );
  }

  const args = buildArgs(options.systemPrompt);
  const input = joinTurns(options.turns);

  let spawned: SpawnResult;
  try {
    spawned = await runClaudeCli(args, input);
  } catch (err) {
    // Spawn-level failure (e.g. claude not on PATH). No fallback — see the
    // file header's "REFUSE, NEVER SUBSTITUTE".
    throw new Error(
      `claudeCli.chat(): could not run the claude CLI — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (spawned.exitCode !== 0) {
    // No fallback here either — a non-zero exit refuses, it never retries
    // against a different credential path.
    throw new Error(
      `claude -p exited with code ${spawned.exitCode}${spawned.stderr ? `: ${spawned.stderr.trim()}` : ''}`
    );
  }

  const { text, usage, versionFromPayload, recognisedShape } = extractReply(spawned.stdout);
  if (!recognisedShape) {
    console.warn(
      'claudeCli.chat(): --output-format json did not match any known field ' +
        '(result/content/text) — treating stdout as raw text. This shape has not been ' +
        'independently verified; see the file header.'
    );
  }

  // Payload first (costs nothing extra if it's there — see the file
  // header); the memoized `--version` spawn only runs when the payload
  // didn't carry one, and only once per process either way.
  const substrateVersion = versionFromPayload ?? (await resolveCliVersion());

  const usageRecord = shapeUsage(usage, substrateVersion);
  await fireUsageHook(options.onUsage, usageRecord, 'claudeCli.chat');

  return {
    content: text,
    usage: usageRecord,
    // Not confirmed exposed by --output-format json — see the file header.
    stopReason: 'end_turn',
  };
}

export const claudeCli = { PROVIDER, chat };
