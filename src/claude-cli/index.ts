/**
 * @verevoir/llm/claude-cli — `claude -p` as a subscription-only
 * `chat()`-shaped substrate, for a caller that must run on the Claude Code
 * OAuth subscription rather than a billed API key.
 *
 * WHY THIS EXISTS. The Anthropic Messages API only accepts the subscription
 * OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) for requests that present
 * themselves as the real Claude Code client (`oauthSystemIdentity()` in
 * `anthropic/client.ts`, 0.21.0). A caller that isn't actually Claude Code
 * — e.g. this repository's own antagonistic-review gate, running as a plain
 * Node process — imitating that identity to the raw Messages API was
 * explicitly ruled out as a route: sending a fabricated system block that
 * claims to BE Claude Code, from something that is not, is not a sanctioned
 * way to reach the subscription credential. This adapter instead shells out
 * to the REAL `claude` binary in its own non-interactive print mode
 * (`claude -p`) and lets it authenticate itself, however it does that —
 * this adapter never touches the credential directly.
 *
 * REFUSE, NEVER SUBSTITUTE. "Purchased API credits are for GitHub Actions
 * only" is the hard constraint this adapter is built around, enforced by
 * several independent mechanisms rather than one:
 *   1. Every billed-credential env var THIS CODEBASE CURRENTLY KNOWS ABOUT
 *      is stripped from the CHILD process's environment before it is
 *      spawned — not merely left unset by omission, but deleted from a
 *      COPY of the parent env (see `STRIPPED_ENV_VARS`, `childEnv`). This
 *      list was built by reading what `anthropic/client.ts`, this
 *      package's own sibling adapter for the same provider, already
 *      treats as a live credential vector (`ANTHROPIC_API_KEY`,
 *      `ANTHROPIC_API_KEY_FILE`, `ANTHROPIC_AUTH_TOKEN` — the last of
 *      these was missing until a review caught it), plus two
 *      precautionary strips for enterprise routing the real CLI is
 *      reported, but not independently confirmed here, to support
 *      (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`).
 *      **This list is not provably exhaustive** — it strips every
 *      billed-credential vector this codebase currently knows about, not
 *      every one the `claude` binary might ever read; an undocumented or
 *      future CLI-internal fallback this list does not yet name would
 *      not be caught by it.
 *   2. `route` is reported as the CONSTANT `'subscription-oauth'`. This
 *      reflects the deliberate design — this adapter has no fallback
 *      ladder and exists specifically so a caller can avoid the metered
 *      path — not a proof that (1) closes every path the CLI could take
 *      to reach a billed credential. Its safety is only as strong as
 *      (1)'s completeness, which is stated immediately above as not
 *      provable from this repository alone.
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
 * without losing the subscription route. (The CLI's exact auth
 * behaviour under `--safe-mode` is still relayed, not independently
 * observed — see the PR body for what remains open.)
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
 * `--output-format json`'S SHAPE IS NOW CONFIRMED, AGAINST A REAL
 * INVOCATION — the operator ran `claude -p ... --output-format json` and
 * relayed the raw payload verbatim. Recorded here in detail because an
 * earlier version of this file guessed at the shape, and the guess was
 * wrong in specific, correctable ways:
 *   - The reply text is a FLAT STRING under `result` — not `content`,
 *     not `text`, not nested. This adapter now reads exactly that field.
 *   - `stop_reason` is a real top-level field (`"end_turn"` observed)
 *     and maps directly to `ChatReply.stopReason`.
 *   - `usage` carries the same four token-count field names this file
 *     already expected (`input_tokens`, `output_tokens`,
 *     `cache_read_input_tokens`, `cache_creation_input_tokens`) — that
 *     part of the original guess held up.
 *   - There is NO version field anywhere in the payload. The
 *     speculative `version` / `cli_version` payload check this file
 *     used to carry has been removed entirely — it was a guess and the
 *     guess was wrong. `resolveCliVersion()`'s memoized `claude
 *     --version` spawn (below) is now the ONLY source of
 *     `substrateVersion`, confirmed necessary rather than merely
 *     defensive.
 *   - `is_error: true` CAN APPEAR ALONGSIDE A ZERO EXIT CODE. `chat()`
 *     checks both signals: a non-zero exit still refuses outright
 *     (unchanged), and a zero exit whose parsed payload carries
 *     `is_error: true` now ALSO refuses — exit code alone was not a
 *     sufficient failure signal.
 *
 * A SINGLE CALL CAN INVOKE MORE THAN ONE MODEL. The observed payload's
 * `modelUsage` carried usage for BOTH `claude-haiku-4-5-20251001` (896
 * input tokens) and `claude-opus-5[1m]` (281 input tokens) for one
 * trivial prompt — the CLI evidently does some internal work (routing,
 * title generation, or similar) on a smaller model alongside whichever
 * model actually answers. `TokenUsage.model` is a single field and
 * cannot carry two models, so `determinePrimaryModel()` (below) reports
 * the entry whose token counts match the top-level `usage` block — the
 * model that produced the visible reply. The OTHER model is not
 * silently dropped: whenever `modelUsage` names more than one model,
 * every entry is named in a `console.warn`, with its own token counts
 * and cost, so a second model having run stays visible even though only
 * one can be the reported `model`.
 *
 * COST FIGURES ARE PRESENT (`total_cost_usd`, and per-model
 * `modelUsage[].costUSD`) AND DELIBERATELY NOT SURFACED ONTO
 * `TokenUsage`. The payload does not state whether that number is
 * billed or notional — there is no route-equivalent field in it — so
 * asserting either would be a claim this adapter cannot back up. What
 * this adapter DOES know, independently and for certain: no billed
 * credential was available to spend, because the env vars this adapter
 * knows can carry one (`ANTHROPIC_API_KEY`, `ANTHROPIC_API_KEY_FILE`,
 * `ANTHROPIC_AUTH_TOKEN`) are stripped from the child's environment
 * before the CLI ever runs (see `childEnv()`) — so whatever this
 * number represents, it was not charged to the operator's billed key
 * via any credential this codebase has verified as live. Surfacing it
 * onto `TokenUsage` as a settled billed-vs-notional figure would
 * misrepresent it; that dual-cost design (`decisions/023`, in
 * aigency-governance) is deliberate, separate, out-of-scope work.
 *
 * THIS IS `chat()` ONLY — no `chatWithTools` / `chatWithToolLoop`,
 * matching `google/index.ts`'s own staged-rollout precedent for a first
 * cut of an adapter (its header: "v0.4.0 ships chat() only... follow in
 * a subsequent release"). A tool-calling loop over a subprocess boundary
 * is a materially larger design than this reviewer use case needs, and
 * `--tools ""` makes it moot for this adapter's actual purpose anyway.
 */

import { spawn } from 'node:child_process';
import { fireUsageHook } from '../audit-hook.js';
import type { ChatOptions, ChatReply, CredentialRoute, TokenUsage, TurnContent } from '../index.js';

/** Provider id reported on every {@link TokenUsage} this adapter returns —
 * see the file header for why this must never be `'anthropic'`. */
export const PROVIDER = 'claude-cli';

/** Billed-credential env vars stripped from the child process's environment
 * before every invocation. See the file header's "REFUSE, NEVER SUBSTITUTE" —
 * and its honest caveat that this list is everything this codebase currently
 * knows about, not a proof of completeness. */
const STRIPPED_ENV_VARS = [
  // Verified necessary: `anthropic/client.ts` in this same package already
  // treats these as live billed-credential vectors for the same provider.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY_FILE',
  // Added after a review found this one missing — client.ts's own comment on
  // it ("authToken: null so a stray ANTHROPIC_AUTH_TOKEN can't override an
  // explicit key") is what confirms it is a real vector, not a new claim
  // invented here.
  'ANTHROPIC_AUTH_TOKEN',
  // Precautionary, NOT independently verified — relayed only: the real
  // `claude` CLI is reported to support enterprise routing to AWS Bedrock /
  // Google Vertex, gated by these two toggles. Stripping a variable that
  // turns out not to matter costs nothing; failing to strip one that does is
  // the one violation this file exists to prevent — that asymmetry is the
  // whole justification for stripping these without direct confirmation.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

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

/** Per-model usage entry inside `--output-format json`'s `modelUsage` map —
 * confirmed real, see the file header's "A SINGLE CALL CAN INVOKE MORE
 * THAN ONE MODEL". */
interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Present, and deliberately not surfaced onto TokenUsage — see the
   * file header's "COST FIGURES ARE PRESENT" section. */
  costUSD?: number;
  /** The canonical model id (e.g. `claude-opus-5`), distinct from the
   * `modelUsage` map's own key (e.g. `claude-opus-5[1m]`, which carries a
   * context-window suffix). Preferred over the raw key when present. */
  canonicalModel?: string;
}

/**
 * `--output-format json`'s real, confirmed envelope shape — see the file
 * header for how this was established and what changed from the original
 * guess. Fields not confirmed present in every observed shape stay
 * optional so a shape lacking one still parses without throwing.
 */
interface ClaudeCliJsonResult {
  /** The reply text — a flat string. Confirmed; this is the only text
   * field this adapter reads. */
  result?: string;
  /** True when the CLI itself reports a failure, independent of the
   * process exit code — see the file header's "`is_error: true` CAN
   * APPEAR ALONGSIDE A ZERO EXIT CODE". */
  is_error?: boolean;
  /** Diagnostic context for an `is_error: true` payload, e.g.
   * `"error_max_turns"`. Included in this adapter's thrown error message
   * when present. */
  subtype?: string;
  /** Maps directly to {@link ChatReply.stopReason}. */
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  /** Per-model usage breakdown — see the file header's "A SINGLE CALL CAN
   * INVOKE MORE THAN ONE MODEL". Keyed by the model id as the CLI names
   * it internally (which may carry a suffix like `[1m]`); prefer each
   * entry's own `canonicalModel` field over the key. */
  modelUsage?: Record<string, ModelUsageEntry>;
  /** Present, and deliberately not surfaced onto TokenUsage — see the
   * file header's "COST FIGURES ARE PRESENT" section. */
  total_cost_usd?: number;
}

/** Parses `--output-format json`'s stdout. Returns `null` on anything that
 * isn't valid JSON (e.g. a genuinely unrecognised shape, or a future CLI
 * version changing it) — the caller falls back to raw text in that case,
 * per the file header. */
function parseCliJson(stdout: string): ClaudeCliJsonResult | null {
  try {
    return JSON.parse(stdout) as ClaudeCliJsonResult;
  } catch {
    return null;
  }
}

interface PrimaryModelResult {
  /** The model to report as {@link TokenUsage.model} — the entry whose
   * token counts match the top-level `usage` block, i.e. the model that
   * produced the visible reply. `'unknown'` when `modelUsage` is absent
   * or empty. */
  model: string;
  /** True when `modelUsage` named more than one model — see the file
   * header. The caller warns rather than silently dropping the rest. */
  sawMultipleModels: boolean;
  /** Every `modelUsage` entry, human-readable, for the warning message —
   * empty string when there's nothing to report. */
  breakdown: string;
}

/**
 * Decide which single model to report as {@link TokenUsage.model} when
 * `modelUsage` may name more than one — see the file header's "A SINGLE
 * CALL CAN INVOKE MORE THAN ONE MODEL". Matches the entry whose token
 * counts equal the top-level `usage` block (the model that actually
 * produced the reply text); falls back to the first entry if no exact
 * match is found, since at least one real model id is still better than
 * `'unknown'` in that case.
 */
function determinePrimaryModel(
  usage: ClaudeCliJsonResult['usage'],
  modelUsage: ClaudeCliJsonResult['modelUsage']
): PrimaryModelResult {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) {
    return { model: 'unknown', sawMultipleModels: false, breakdown: '' };
  }
  const breakdown = entries
    .map(
      ([key, u]) =>
        `${u.canonicalModel ?? key}: ${u.inputTokens ?? 0} in / ${u.outputTokens ?? 0} out, $${(u.costUSD ?? 0).toFixed(6)}`
    )
    .join('; ');
  const match = usage
    ? entries.find(
        ([, u]) => u.inputTokens === usage.input_tokens && u.outputTokens === usage.output_tokens
      )
    : undefined;
  const [key, u] = match ?? entries[0];
  return { model: u.canonicalModel ?? key, sawMultipleModels: entries.length > 1, breakdown };
}

// ── Substrate version, memoized for the process's lifetime ───────────────
// See the file header — there is NO version field anywhere in the real
// payload, so this spawn is now the ONLY source of substrateVersion.

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
  model: string,
  substrateVersion: string | undefined
): TokenUsage {
  // Constant, never computed — see the file header's "REFUSE, NEVER
  // SUBSTITUTE" point 2 for why this is safe to assert rather than derive.
  const route: CredentialRoute = 'subscription-oauth';
  return {
    provider: PROVIDER,
    model,
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

  const parsed = parseCliJson(spawned.stdout);

  if (parsed?.is_error) {
    // Confirmed real: the CLI can exit 0 while its own payload says
    // is_error: true — see the file header. Exit code alone is not a
    // sufficient failure signal for this adapter.
    throw new Error(
      `claude -p reported is_error: true (subtype=${parsed.subtype ?? 'unknown'})` +
        (parsed.result ? ` — ${parsed.result}` : '')
    );
  }

  let text: string;
  if (parsed && typeof parsed.result === 'string') {
    text = parsed.result;
  } else {
    text = spawned.stdout;
    console.warn(
      'claudeCli.chat(): --output-format json did not carry a string "result" field — ' +
        'treating stdout as raw text. The real envelope has been observed and "result" is ' +
        'the confirmed field (see the file header); this fallback is for a shape that does ' +
        'not match it, e.g. non-JSON stdout or a future CLI change.'
    );
  }

  const { model, sawMultipleModels, breakdown } = determinePrimaryModel(
    parsed?.usage,
    parsed?.modelUsage
  );
  if (sawMultipleModels) {
    console.warn(
      `claudeCli.chat(): this call invoked more than one model — ${breakdown}. ` +
        `TokenUsage.model reports only "${model}" (the entry matching the reply's own usage ` +
        'figures); the others are named here rather than silently discarded, because ' +
        'TokenUsage has no field for a per-call model breakdown.'
    );
  }

  const substrateVersion = await resolveCliVersion();
  const usageRecord = shapeUsage(parsed?.usage, model, substrateVersion);
  await fireUsageHook(options.onUsage, usageRecord, 'claudeCli.chat');

  return {
    content: text,
    usage: usageRecord,
    stopReason: parsed?.stop_reason ?? 'end_turn',
  };
}

export const claudeCli = { PROVIDER, chat };
