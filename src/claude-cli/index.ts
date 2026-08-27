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
 * only" is not negotiable, so multiple independent mechanisms enforce it —
 * one failing must not silently open the others. **None of the claims below
 * is an absolute guarantee; each names what is actually defended against and
 * what is relayed rather than independently verified — corrected after a
 * review found the first version of this section overstating both (it
 * claimed the stripped list left the CLI "nothing to fall back to" and that
 * there was "no other route this call could have taken"; neither survived
 * the review finding `ANTHROPIC_AUTH_TOKEN` unstripped).**
 *   1. Every billed-credential env var THIS CODEBASE CURRENTLY KNOWS ABOUT
 *      is stripped from the CHILD process's environment before it is
 *      spawned — not merely left unset by omission, but deleted from a
 *      COPY of the parent env (see `STRIPPED_ENV_VARS`, `childEnv`).
 *      `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped on
 *      CONFIRMED evidence: `anthropic/client.ts`, this package's own
 *      sibling adapter for the same provider, is read to treat both as
 *      live credential vectors (the second was missing until a review
 *      caught it). `ANTHROPIC_API_KEY_FILE` is stripped DEFENSIVELY, on
 *      no such evidence — an earlier version of this file claimed
 *      client.ts verified it too, which a later review found false. What
 *      this file has checked directly: that env var appears nowhere in
 *      `client.ts` and nowhere else in this repository. Its absence from
 *      the `@anthropic-ai/sdk` dependency is reported by that same
 *      review, not independently re-checked here — relayed, not
 *      confirmed. It stays in the list regardless of either fact — a
 *      plausible billed-credential name is worth stripping whether or
 *      not anything in reach references it, the same asymmetry that
 *      justifies the two precautionary strips below
 *      (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`), reported
 *      but not independently confirmed here, for enterprise routing the
 *      real CLI is said to support.
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
 *
 * `ABORTSIGNAL` IS HONOURED, BOTH AT ENTRY AND MID-CALL — NOT JUST THE
 * ENTRY CHECK ALONE. Every other `chat()` in this package (`anthropic`,
 * `google`, `openai`, the OpenAI-compatible factory, `deepseek`) calls a
 * local `throwIfAborted(options.abortSignal)` at entry, honouring the
 * shared `ChatOptions.abortSignal` contract (see `index.ts`'s own doc
 * comment — aborting on an exceeded budget is its canonical use case).
 * This adapter does the same — but an entry-only check would satisfy the
 * letter of that contract while leaving the real failure in place: this
 * call spawns a subprocess that can run for the full duration of a
 * `claude -p` invocation, and an entry check alone does nothing once
 * that process is already running. So `runClaudeCli` also takes the
 * signal directly: if it aborts while the child is still alive, the
 * child is killed (`child.kill()`) and the call rejects immediately with
 * the signal's own reason — the same reason `throwIfAborted` would have
 * thrown, so a caller sees identical behaviour whether the abort landed
 * before the spawn or during it. The one-shot `claude --version` spawn
 * `resolveCliVersion()` makes is deliberately NOT wired to any signal: it
 * is memoized once per process and shared by every caller, so aborting
 * one caller's `chat()` call must not cancel a lookup every other caller
 * is also waiting on.
 *
 * `ONPROGRESS` IS ACCEPTED, NEVER INVOKED — A DISCLOSED LIMITATION, NOT
 * A SILENT ONE. `ChatOptions.onProgress` is part of the shared contract
 * every adapter's options type carries, and `anthropic/index.ts`
 * implements it by auto-injecting a `report_progress` tool the model can
 * call mid-turn. That mechanism cannot exist here without contradicting
 * this file's own design: `--tools ""` disables every tool for this
 * adapter, deliberately (see "`--tools ""` IS A POSITIVE DECLARATION"
 * above) — there is no tool a model could call to narrate progress
 * through. Independently, `--output-format json` (confirmed against a
 * real invocation, above) delivers ONE envelope at process exit, not an
 * incremental stream, so there is no partial signal to narrate from even
 * if a tool mechanism existed. Both of those are structural to the
 * design this adapter ships today, not gaps left for a later release —
 * so a caller supplying `onProgress` will never see it called, and
 * nothing here throws for supplying it. That is stated here, plainly,
 * rather than left for a reader to discover by noticing the callback
 * never fires.
 */

import { spawn } from 'node:child_process';
import { fireUsageHook } from '../audit-hook.js';
import type { ChatOptions, ChatReply, CredentialRoute, TokenUsage, TurnContent } from '../index.js';

/** Provider id reported on every {@link TokenUsage} this adapter returns —
 * see the file header for why this must never be `'anthropic'`. */
export const PROVIDER = 'claude-cli';

/**
 * The base environment names every invocation gets, regardless of what
 * else is permitted. Mirrors `aigency-governance`'s own
 * `src/review/claudeCli.ts` `BASE_ENV_NAMES` exactly — that composition
 * built an independent parallel copy of this file's design and converged
 * on the same three names for the same reasons: `PATH` so the `claude`
 * binary can be found at all, `HOME` because per-user configuration and
 * cache (and, on macOS, the Keychain entry an interactively-logged-in CLI
 * reads its session from) key off it, `TMPDIR` because the CLI writes
 * scratch files and the platform fallback isn't writable everywhere. This
 * list stays boring on purpose — anything added to it is handed to
 * `claude` on every invocation forever.
 */
const BASE_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR'] as const;

/**
 * The one credential this adapter names explicitly — a subscription OAuth
 * token, never the billed `ANTHROPIC_API_KEY` this file exists to avoid
 * spending.
 *
 * WHY HARDCODE ONE CREDENTIAL NAME INTO A PUBLISHED LIBRARY, RATHER THAN
 * LEAVING THE ALLOWLIST CALLER-EXTENSIBLE. This package has many callers
 * and they may legitimately authenticate the tooling THEY drive
 * differently — real elsewhere in this codebase (every adapter's
 * `<PROVIDER>_BASE_URL` override exists precisely because one caller's
 * endpoint isn't another's). It does not carry over to this constant,
 * because this adapter isn't wrapping "any subprocess" that a caller
 * configures — it is built around exactly one credential mechanism: this
 * file already asserts `route` as the constant `'subscription-oauth'`
 * (see the file header, REFUSE-NEVER-SUBSTITUTE point 2), specifically so
 * a caller can use a Claude subscription rather than a billed key.
 * `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is the CLI's own
 * documented non-interactive mechanism for that credential — the same
 * token `anthropic/index.ts` in this package already prefers over
 * `ANTHROPIC_API_KEY` for the identical reason. A caller running the CLI
 * interactively, already logged in via Keychain (reachable because `HOME`
 * is passed through above), needs no env var at all: this name is simply
 * absent from their environment, and `allowedEnv` below omits whatever
 * isn't set rather than inventing it. A caller needing some OTHER
 * non-billed auth mechanism for the `claude` binary is not a case this
 * file has evidence for — naming a second credential without a confirmed
 * need would be guessing at a shape nobody has asked for, the same
 * standard the file header holds itself to everywhere else ("relayed, not
 * confirmed"). If that need arises, widening this is a one-line,
 * deliberate change, not a reason to leave the surface wide by default
 * now.
 */
export const CLAUDE_CLI_CREDENTIAL_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Every environment variable name the `claude` child process is permitted
 * to see — an ALLOWLIST, built from {@link BASE_ENV_NAMES} plus
 * {@link CLAUDE_CLI_CREDENTIAL_ENV_VAR}, never independently.
 *
 * REPLACES an earlier `STRIPPED_ENV_VARS` / `childEnv` DENYLIST that
 * deleted five named Anthropic/Bedrock/Vertex variables and passed
 * everything else in the caller's environment through to the child
 * unchanged — other cloud credentials, other API tokens, `SSH_AUTH_SOCK`,
 * `GITHUB_TOKEN`, all of it, handed to a third-party CLI subprocess this
 * codebase does not control. A denylist can only ever be as complete as
 * the list of things its author thought to name — this file's own
 * honesty that `STRIPPED_ENV_VARS` was never "provably exhaustive" was
 * itself the admission that the wrong primitive was in use. An allowlist
 * doesn't need to be exhaustive about threats to be complete about
 * permissions: nothing outside {@link ALLOWED_ENV_VARS} reaches the
 * child, full stop, regardless of what it's called or whether this file
 * has ever heard of it.
 */
export const ALLOWED_ENV_VARS = [...BASE_ENV_NAMES, CLAUDE_CLI_CREDENTIAL_ENV_VAR] as const;

/**
 * The environment to hand the `claude` child process: every name in
 * {@link ALLOWED_ENV_VARS} that `env` actually carries, and nothing else —
 * never the original object, and never anything not on the allowlist, no
 * matter what the caller's own shell exports. A name on the allowlist
 * that `env` does not have is simply absent from the result, not an
 * error here: a missing `CLAUDE_CODE_OAUTH_TOKEN` is `claude` itself
 * refusing to authenticate, reported through the normal failure path
 * below, not a concern of building the environment.
 */
export function allowedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENV_VARS) {
    const value = env[name];
    if (value !== undefined) {
      child[name] = value;
    }
  }
  return child;
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
 *
 * `usage` below uses snake_case field names while `modelUsage`'s entries
 * (`ModelUsageEntry`) use camelCase — a real inconsistency in the payload,
 * not a naming slip in this file: the operator's relayed real invocation
 * showed exactly this mix (snake_case `usage.input_tokens` alongside
 * camelCase `modelUsage[key].inputTokens`), so both conventions are kept
 * as observed rather than normalised to one.
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

// ── Substrate version, memoized for the process's lifetime ──────────────
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
  /**
   * The signal that terminated the process, or `null` when it exited
   * under its own steam. Node's `child_process` guarantees exactly one of
   * `exitCode` / `signal` is non-null on `'close'` — `exitCode` is `null`
   * PRECISELY WHEN the child was terminated by a signal (SIGTERM from a
   * timeout, SIGKILL from an OOM killer, this file's own `child.kill()`
   * on an aborted call, anything else that sends one), not as some other,
   * unrelated shape of "no exit code". Carried through so a signal-
   * terminated run is reported distinguishably from a bare "exited with
   * code null" instead of the two collapsing into the same message — see
   * `describeExit` below.
   */
  signal: NodeJS.Signals | null;
}

/**
 * How the process ended, described for a human reading a failure message.
 * Checks `signal` FIRST, unconditionally — Node never sets both
 * `exitCode` and `signal` on the same close, so there is no case where
 * checking `signal` first hides a real exit code. Before this existed, a
 * signal-terminated run and a bare `exitCode: null` carrying no signal
 * were reported identically, both as "exited with code null" — the
 * distinguishing fact was available in the `close` event's own second
 * argument and was being discarded on the way out.
 */
function describeExit(
  command: string,
  invocation: Pick<SpawnResult, 'exitCode' | 'signal'>
): string {
  if (invocation.signal !== null) {
    return `${command} was killed by signal ${invocation.signal}`;
  }
  return `${command} exited with code ${String(invocation.exitCode)}`;
}

/** What an aborted `AbortSignal` should be reported as: its own `reason`
 * when that's an `Error`, a string-wrapped `reason` otherwise, or a
 * generic `AbortError` when no reason was given. Shared by
 * `throwIfAborted` (the entry check) and `runClaudeCli` (the mid-call
 * kill-and-reject), so an abort reports identically regardless of when
 * it happened. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  if (signal.reason !== undefined) return new Error(String(signal.reason));
  return new DOMException('Aborted', 'AbortError');
}

/** Throw the AbortSignal's reason (or a generic AbortError) when the
 * signal is aborted. No-op when no signal is provided or the signal has
 * not been aborted. Matches every sibling adapter's own `throwIfAborted`
 * (`anthropic/index.ts`, `google/index.ts`, `openai/index.ts`,
 * `openai-compat.ts`, `deepseek/index.ts`) so an abort reports
 * identically no matter which substrate served the call. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReason(signal);
}

/** Runs the CLI once, writing `input` to its stdin and collecting stdout /
 * stderr / exit code. Separated from `chat()` so tests can mock exactly
 * this seam without reimplementing stream plumbing per test. Also used by
 * `resolveCliVersion()` for the (memoized, at most once per process)
 * `--version` invocation — which never passes `signal` (see the file
 * header's "ABORTSIGNAL IS HONOURED" section for why a shared, memoized
 * lookup must not be cancellable by any one caller's abort).
 *
 * When `signal` aborts — whether before this function is even called, or
 * while the spawned child is still running — the child is killed
 * (`child.kill()`, when one has been spawned) and the returned promise
 * rejects immediately with the signal's own reason (see `abortReason`),
 * rather than either waiting for the process to exit on its own or
 * reporting the abort as an ordinary spawn failure. */
function runClaudeCli(args: string[], input: string, signal?: AbortSignal): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const child = spawn('claude', args, { env: allowedEnv(process.env) });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      // Terminate the still-running subprocess — an abort must not leave
      // it running to completion in the background after the caller has
      // already been told the call failed. This is the half an
      // entry-only check cannot do.
      child.kill();
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // e.g. ENOENT — claude is not on PATH at all. A spawn-level failure,
    // distinct from a non-zero exit; both end up refusing (see chat()).
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (exitCode, signal) =>
      finish(() => resolve({ stdout, stderr, exitCode, signal }))
    );
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
  throwIfAborted(options.abortSignal);
  if (options.apiKey != null) {
    // Refused, not silently ignored — see the file header, point 4.
    throw new Error(
      "claudeCli.chat() does not accept apiKey — it always uses the CLI's own logged-in " +
        'subscription session, never a supplied credential.'
    );
  }

  const args = buildArgs(options.systemPrompt);
  const input = joinTurns(options.turns);
  // options.onProgress is accepted per the shared ChatOptions contract but
  // never invoked — see the file header's "ONPROGRESS IS ACCEPTED, NEVER
  // INVOKED" section for why this is a disclosed limitation, not a gap.

  let spawned: SpawnResult;
  try {
    spawned = await runClaudeCli(args, input, options.abortSignal);
  } catch (err) {
    if (options.abortSignal?.aborted) {
      // Killed and rejected by runClaudeCli's abort wiring — rethrow the
      // signal's own reason as-is (matching throwIfAborted's contract)
      // rather than reporting an aborted call as an ordinary spawn
      // failure.
      throw err;
    }
    // Spawn-level failure (e.g. claude not on PATH). No fallback — see the
    // file header's "REFUSE, NEVER SUBSTITUTE".
    throw new Error(
      `claudeCli.chat(): could not run the claude CLI — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (spawned.exitCode !== 0) {
    // No fallback here either — a non-zero exit refuses, it never retries
    // against a different credential path. describeExit tells a
    // signal-terminated close apart from a bare null exit code — see
    // SpawnResult.
    throw new Error(
      `${describeExit('claude -p', spawned)}${spawned.stderr ? `: ${spawned.stderr.trim()}` : ''}`
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
