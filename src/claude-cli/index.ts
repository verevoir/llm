/**
 * @verevoir/llm/claude-cli — the Claude Code CLI (`claude -p`) as a
 * Reviewer-shaped provider, for callers that must run on a subscription
 * credential rather than a billed API key.
 *
 * WHY THIS EXISTS, RATHER THAN A SECOND CREDENTIAL ON THE ANTHROPIC
 * ADAPTER. The Anthropic Messages API accepts a subscription OAuth token
 * only for requests that present themselves AS Claude Code (see
 * anthropic/index.ts's `oauthSystemIdentity()`); this adapter instead
 * shells out to the real thing — `claude -p` — and lets it authenticate
 * itself, rather than this library forging that identity.
 *
 * PROVIDER ID IS `'claude-cli'`, DELIBERATELY DISTINCT FROM `'anthropic'`,
 * so `TokenUsage.provider` unambiguously names which substrate served a
 * call. NEVER REGISTERED into the shared model catalog / connection
 * registry (no `registerModelCatalog`, no `registerProviderConnection`) —
 * `resolveModel` / `resolveModelByTerm` must never be able to silently
 * substitute this adapter for the real API one; a caller wanting this
 * substrate imports and calls it directly, chosen deliberately, never
 * resolved by policy.
 *
 * CREDENTIAL CONTRACT. `chat()` refuses rather than substitutes: the
 * child process's environment is built from an ALLOWLIST — see
 * {@link ALLOWED_ENV_VARS} for the exact names permitted through and its
 * own doc-comment for why an allowlist replaced an earlier denylist.
 * `route` on the returned `TokenUsage` is always the constant
 * `'subscription-oauth'` — a declared design choice, not a proof that
 * every billed-credential path is closed (its safety is only as strong as
 * the allowlist's completeness). A non-zero exit throws a plain `Error`
 * and is never retried against a different credential. `chat()` REFUSES a
 * caller-supplied `apiKey` outright rather than silently ignoring it — BYOK
 * has no meaning for a subprocess that authenticates as whatever is
 * already logged in. Flags used: `-p --system-prompt <prompt> --tools ""
 * --output-format json --no-session-persistence --safe-mode` (not
 * `--bare`, whose own `--help` says OAuth/keychain are never read under
 * it). For the full rationale, the rejected alternatives (`--bare`,
 * `--json-schema`), and the correction history behind this contract, see
 * CHANGELOG.md's 0.25.0 entry and this PR's body — not repeated here.
 *
 * PAYLOAD CONTRACT, confirmed against a real invocation (history in
 * CHANGELOG.md, not repeated here). The reply text is a FLAT STRING under
 * `result` — not `content`, not `text`, not nested. `stop_reason` is a
 * real top-level field and maps directly to `ChatReply.stopReason`.
 * `usage` carries `input_tokens` / `output_tokens` /
 * `cache_read_input_tokens` / `cache_creation_input_tokens`. There is NO
 * version field anywhere in the payload — `resolveCliVersion()`'s
 * memoized `claude --version` spawn (below) is the ONLY source of
 * `substrateVersion`. `is_error: true` CAN APPEAR ALONGSIDE A ZERO EXIT
 * CODE; `chat()` checks both signals and refuses on either. A SINGLE
 * CALL CAN INVOKE MORE THAN ONE MODEL — `modelUsage` may name several;
 * `determinePrimaryModel()` (below) reports only the entry matching the
 * top-level `usage` block as `TokenUsage.model`, but every entry is
 * named in a `console.warn` when more than one is present, so a second
 * model having run is never silently dropped.
 *
 * `total_cost_usd` / per-model `modelUsage[].costUSD` ARE PRESENT IN THE
 * PAYLOAD AND DELIBERATELY NOT SURFACED ONTO `TokenUsage` — not recorded
 * elsewhere in this repository, so kept here rather than cut. The
 * payload gives no signal for whether that figure is billed or notional,
 * so asserting either would be an unbacked claim; what this adapter DOES
 * know for certain is that no billed credential was available to spend,
 * because {@link allowedEnv} never lets one reach the child. A settled
 * dual-cost design (billed vs. notional) is deliberate, separate,
 * out-of-scope work (`decisions/023`, aigency-governance).
 *
 * SINGLE-SHOT `chat()` (no `session` passed) still refuses a turn
 * carrying a `tool_use` / `tool_result` block rather than silently
 * flattening it — that path has no tool loop of its own, and `--tools
 * ""` makes one moot for it. Tool calling lives on the SESSION-HOLDING
 * TRANSPORT below.
 *
 * SESSION-HOLDING TRANSPORT (`chatWithToolLoop`, and `chat` given a
 * `session`) — implemented in `session.ts` + `mcp-bridge.ts`, alongside
 * this file; this paragraph is the summary, not the full account.
 *
 * WHY A SECOND TRANSPORT, RATHER THAN WIDENING THE SINGLE-SHOT ONE.
 * `-p --output-format json` spawns one process per call and exits —
 * fine for a stateless review lens, structurally unable to carry a tool
 * exchange (turn N asks for a tool, turn N+1 supplies the result — two
 * different processes can't correlate that) or to warm a prompt cache
 * across turns (nothing survives between spawns to read a cache from).
 * A HELD session is the one mechanism that unlocks both — tools and
 * caching arrive together or not at all on this route, because the same
 * live process is what each of them needs.
 *
 * THE HANDLE. `createSession()` returns an opaque `ClaudeCliSessionHandle`
 * the CALLER holds — this package has no concept of a conversation, so a
 * lifetime keyed on one would be this package making policy it cannot
 * reason about (when to evict, what if the key never returns). A handle
 * presented after its process died, was evicted, or was never used is
 * NOT an error — the next call transparently starts fresh under the same
 * id, the same shape as a 401: the caller's own turns remain the truth,
 * the session is only ever an accelerator that may be absent. Release one
 * explicitly with `closeSession()`; an abandoned one is still bounded —
 * see `session.ts`'s `SESSION_IDLE_TIMEOUT_MS` / `SESSION_MAX_HELD`.
 *
 * MECHANISM. `claude -p --input-format stream-json --output-format
 * stream-json` is kept running for the session's whole life — one
 * user-turn JSON line in, a terminal `{"type":"result",...}` line out
 * per turn — rather than the single-shot path's spawn-per-call. Tools
 * are exposed to it WITHOUT lifting `--tools ""` (kept, per this file's
 * own constraint: the tools offered must be exactly the caller's, never
 * Claude Code's own) — instead an embedded, per-session MCP stdio
 * server (`mcp-bridge.ts`) is named via an explicit `--mcp-config`
 * (`--strict-mcp-config` stays on, so it is the ONLY server reachable).
 * That server forwards every `tools/call` over a loopback TCP hop back
 * into THIS process, where the caller's own `ToolExecutor` actually
 * runs — so `claude`'s own agentic loop calls tools autonomously during
 * one turn, and `chatWithToolLoop` on this transport makes exactly ONE
 * turn request per call rather than manually feeding tool_use/tool_result
 * blocks back and forth the way the API adapters do.
 *
 * WHY `chatWithTools` (single-shot, return-before-execution) REFUSES ON
 * THIS TRANSPORT rather than faking the contract: because tools run
 * through the CLI's own agentic loop via MCP, there is no point in the
 * exchange where a `tool_use` exists without having already been
 * executed for the model to see the result and continue. Interface
 * honesty over interface uniformity — see this function's own doc
 * comment.
 *
 * TWO OF THREE ONCE-RELAYED ASSUMPTIONS ARE NOW CONFIRMED, the third
 * still genuinely open — see `session.ts`'s own file header for the full
 * account of a real, operator-run invocation (which failed on expired
 * OAuth, not on the mechanism itself). CONFIRMED: `--input-format
 * stream-json`/`--output-format stream-json` keeps ONE process alive
 * across MULTIPLE turns (two result lines, one session_id, no exit
 * between them). CONFIRMED: a turn's terminal event genuinely is
 * `{"type":"result",...}` carrying the same inner shape as the
 * confirmed single-shot envelope (result/is_error/subtype/stop_reason/
 * usage/modelUsage all present). STILL OPEN: whether an MCP tool named
 * via `--mcp-config` stays callable under `--tools ""` — the run that
 * confirmed the two points above failed before a model call ever
 * decided whether to invoke one, so this is not settled either way.
 * Every terminal parse in that path throws a specific, legible error
 * rather than hanging or silently dropping a tool call if the real
 * shape doesn't match — per this file's own "declares it rather than
 * pretending" standard — including a per-turn watchdog timeout that
 * kills a held process and refuses rather than waiting forever for an
 * event that never arrives.
 *
 * `abortSignal` IS HONOURED AT ENTRY AND MID-CALL, not just an entry
 * check: aborting while the spawned child is still running kills it
 * (`child.kill()`) and rejects immediately with the signal's own reason,
 * rather than letting the subprocess finish in the background. The
 * memoized `claude --version` lookup is deliberately NOT wired to any
 * one call's signal, since every caller shares it.
 *
 * `onProgress` IS ACCEPTED, NEVER INVOKED. `--tools ""` disables every
 * tool a `report_progress` mechanism would need, and `--output-format
 * json` delivers one envelope at process exit, not a stream — there is
 * no partial signal to narrate from either way. A caller supplying
 * `onProgress` will never see it called; nothing here throws for
 * supplying it.
 *
 * MODEL PINNING. `chat()` accepts `options.model` — an exact model id,
 * passed straight through as `--model <id>` — so a caller that must
 * compare this substrate against the direct API path (or across two
 * calls, e.g. a governance review of the same commit through both
 * transports) can force both to answer with the identical model rather
 * than each one's own default/class resolution silently diverging. See
 * `ChatOptions.model`'s own doc comment in the core for the full
 * rationale. `--model` is documented in Claude Code's own `--help` as
 * accepting either a class alias ("sonnet", "opus") or a full model id
 * ("claude-sonnet-4-20250514") — that documentation is what this flag
 * rests on; unlike the flags confirmed above against a real captured
 * payload, this one has NOT independently been re-verified against a
 * live invocation by this repository, and is stated here as relayed,
 * not confirmed, in the same spirit as the Bedrock/Vertex strips this
 * file used to carry. Omitting `options.model` leaves behaviour exactly
 * as before — the local install's own default, unpinned.
 *
 * `options.maxTokens` IS ACCEPTED, NEVER USED — disclosed rather than
 * silently ignored. There is no confirmed `claude -p` flag for an
 * output-token ceiling (unlike `--model`, nothing in the CLI's own
 * `--help` documents one), so this adapter has nothing to pass it to; a
 * caller relying on `maxTokens` to avoid a truncated reply on this
 * substrate has no lever here and should know that, not discover it by
 * the field quietly doing nothing.
 *
 * ISOLATION FROM PROJECT/LOCAL CONFIGURATION, on top of `--safe-mode`'s
 * own documented disabling of CLAUDE.md/skills/plugins/hooks/MCP
 * servers/custom commands (see the CREDENTIAL CONTRACT paragraph
 * above). Two more, deliberate: `--strict-mcp-config` is passed on
 * every invocation, so even if `--safe-mode`'s MCP suppression turns
 * out narrower in practice than its `--help` states, no MCP server from
 * any configuration source reaches this call — only servers passed via
 * an explicit `--mcp-config` flag would, and this adapter never passes
 * that flag, so the effective set is always empty. And the spawn's
 * `cwd` (see `runClaudeCli`) is set explicitly to the platform temp
 * directory rather than inherited from whatever directory the calling
 * process happens to be running in — a project's `CLAUDE.md` /
 * `.mcp.json` live relative to cwd, and a governance review process's
 * cwd is typically the very repository it is reviewing, which is
 * precisely the content this call must not see. Both are defense-in-
 * depth alongside `--safe-mode`, not a claim that `--safe-mode` alone
 * was proven insufficient — this repository has not independently
 * re-confirmed `--safe-mode`'s own documented MCP/CLAUDE.md suppression
 * by direct observation, so it is not relied on alone.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fireUsageHook } from '../audit-hook.js';
import type {
  ChatOptions,
  ChatReply,
  ChatWithToolLoopOptions,
  ChatWithToolLoopResult,
  ChatWithToolsOptions,
  ChatWithToolsResult,
  CredentialRoute,
  TokenUsage,
  TurnContent,
} from '../index.js';
import { ALLOWED_ENV_VARS, allowedEnv, CLAUDE_CLI_CREDENTIAL_ENV_VAR, PROVIDER } from './env.js';
import {
  closeSession,
  createSession,
  resetClaudeCliSessionsForTests,
  runSessionTurn,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_HELD,
  SESSION_TURN_TIMEOUT_MS,
  type ClaudeCliSessionHandle,
} from './session.js';

// Moved to env.ts (see its own file header for why) — re-exported here so
// nothing importing @verevoir/llm/claude-cli can tell any of these four
// names ever lived in this file.
export { ALLOWED_ENV_VARS, allowedEnv, CLAUDE_CLI_CREDENTIAL_ENV_VAR, PROVIDER };

// The session-holding transport (session.ts + mcp-bridge.ts) — see the file
// header's SESSION-HOLDING TRANSPORT section. Re-exported from this single
// subpath entry point, same as every other name here.
export {
  closeSession,
  createSession,
  resetClaudeCliSessionsForTests,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_HELD,
  SESSION_TURN_TIMEOUT_MS,
  type ClaudeCliSessionHandle,
};

// ALLOWED_ENV_VARS / CLAUDE_CLI_CREDENTIAL_ENV_VAR / allowedEnv now live in
// env.ts, re-exported above — see that module's own doc comments for the
// full allowlist-vs-denylist rationale this block used to carry.

/**
 * {@link ChatOptions}, plus an optional held session — see the file
 * header's SESSION-HOLDING TRANSPORT section. Additive only: a caller
 * that never sets `session` sees `chat()` behave exactly as before this
 * field existed. When `session` IS set, `turns` must carry exactly the
 * ONE new message for this round — the held session already remembers
 * everything before it, unlike this adapter's stateless single-shot
 * path (which re-joins the full `turns` array every call, the same as
 * every other adapter in this package). Resending prior history into a
 * session would duplicate it in the model's own context.
 *
 * THE REHYDRATION GUARANTEE THIS DEPENDS ON: the caller — not this
 * package — is expected to keep its own authoritative `turns` array
 * alongside whichever `session` handle it's using, exactly the state a
 * caller of the STATELESS path already keeps (every adapter in this
 * package resends the full `turns` array every call; the session-holding
 * path only ever adds an accelerator on top of the same discipline). If
 * a handle turns out dead — evicted on its own TTL, the process crashed,
 * anything — the caller can always fall back to `chat()`/`chatWithToolLoop()`
 * WITHOUT a `session`, resending its own full history through the
 * stateless single-shot path. That fallback, always available, is what
 * makes a held session's own TTL (see session.ts's own file header) a
 * resource policy rather than a correctness one: losing one costs a cold
 * rebuild, never lost work, because the caller never depended on this
 * package to be the only place the conversation lived.
 */
export interface ClaudeCliChatOptions extends ChatOptions {
  session?: ClaudeCliSessionHandle;
}

/** {@link ChatWithToolsOptions}, plus the same optional `session` field.
 * See {@link chatWithTools}'s own doc comment for why this function
 * REFUSES on this transport regardless of whether `session` is set —
 * the field exists for type-shape parity with {@link ClaudeCliChatWithToolLoopOptions},
 * not because this function honours it. */
export interface ClaudeCliChatWithToolsOptions extends ChatWithToolsOptions {
  session?: ClaudeCliSessionHandle;
}

/** {@link ChatWithToolLoopOptions}, plus an optional held session. Same
 * `turns`-is-only-the-new-message contract as {@link ClaudeCliChatOptions}
 * when `session` is set. Omitting `session` still works — a throwaway
 * session is created and closed for the one call, so a caller that
 * doesn't want to hold state across calls sees a single, self-contained
 * `chatWithToolLoop()` exactly like every other adapter's. */
export interface ClaudeCliChatWithToolLoopOptions extends ChatWithToolLoopOptions {
  session?: ClaudeCliSessionHandle;
}

/** Flags applied to every invocation. See the file header for why each one
 * is here, and why `--bare` / `--json-schema` are not used instead.
 * `--model` is appended only when `model` is supplied — see the file
 * header's MODEL PINNING paragraph; omitting it leaves the CLI's own
 * default model selection untouched. */
function buildArgs(systemPrompt: string, model: string | undefined): string[] {
  const args = [
    '-p',
    '--system-prompt',
    systemPrompt,
    '--tools',
    '',
    '--strict-mcp-config',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--safe-mode',
  ];
  if (model) {
    args.push('--model', model);
  }
  return args;
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
 * confirmed real, see the file header's PAYLOAD CONTRACT paragraph. */
interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Present, and deliberately not surfaced onto TokenUsage — see the
   * file header's `total_cost_usd` / `costUSD` paragraph. */
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
  /** Per-model usage breakdown — see the file header's PAYLOAD CONTRACT
   * paragraph. Keyed by the model id as the CLI names
   * it internally (which may carry a suffix like `[1m]`); prefer each
   * entry's own `canonicalModel` field over the key. */
  modelUsage?: Record<string, ModelUsageEntry>;
  /** Present, and deliberately not surfaced onto TokenUsage — see the
   * file header's `total_cost_usd` / `costUSD` paragraph. */
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
 * `modelUsage` may name more than one — see the file header's PAYLOAD
 * CONTRACT paragraph. Matches the entry whose token
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
  // Constant, never computed — see the file header's CREDENTIAL CONTRACT
  // paragraph for why this is safe to assert rather than derive.
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

/**
 * Recovers the REAL failure reason on a non-zero exit from `claude -p`'s
 * own `--output-format json` envelope on stdout, rather than reporting
 * only the bare exit code (and possibly stderr) as before this existed.
 *
 * THE ESCAPED DEFECT THIS EXISTS TO FIX. `claude -p`'s commonest real
 * failure — not logged in — exits 1 with EMPTY stderr; the actual reason
 * ("Not logged in · Please run /login") lives only in stdout's own JSON
 * envelope, in `result`, typically alongside `is_error: true`. Before
 * this function existed, the non-zero-exit branch never read stdout at
 * all, so this surfaced as the content-free "claude -p exited with code
 * 1" and the real reason was silently dropped.
 *
 * RECOVERY ORDER: stdout is parsed as the JSON envelope; its `result`
 * field wins when present and non-empty. Otherwise this falls back to
 * stdout's raw text (stdout that isn't valid JSON, or JSON with no
 * usable `result`). `stderr` is appended ONLY when it says something the
 * recovered text doesn't already say, so a `stderr` that merely repeats
 * the same message is never duplicated into it.
 *
 * DELIBERATELY NOT USED ON THE SPAWN-FAILURE PATH (`could not run the
 * claude CLI — …`, thrown from `chat()`'s own catch block above when the
 * `claude` process never starts at all, e.g. ENOENT). That message's
 * prefix is matched verbatim by `aigency-harness` #99 to split
 * `unreachable` from `refused` — this function only ever runs once the
 * process HAS exited with a code, a case that message is never attached
 * to, so the two do not collide. That prefix is untouched by this change.
 */
function describeNonZeroExitReason(spawned: Pick<SpawnResult, 'stdout' | 'stderr'>): string {
  const parsed = parseCliJson(spawned.stdout);
  const fromResult = parsed && typeof parsed.result === 'string' ? parsed.result.trim() : '';
  const rawStdout = spawned.stdout.trim();
  const reason = fromResult !== '' ? fromResult : rawStdout;
  const stderrTrimmed = spawned.stderr.trim();

  if (reason === '') {
    // Nothing recoverable from stdout at all — stderr is all there is,
    // the same shape this adapter reported before this fix existed.
    return stderrTrimmed ? `: ${stderrTrimmed}` : '';
  }

  const stderrAddsNewInfo = stderrTrimmed !== '' && !reason.includes(stderrTrimmed);
  return `: ${reason}${stderrAddsNewInfo ? ` (stderr: ${stderrTrimmed})` : ''}`;
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
 * header's `abortSignal` paragraph for why a shared, memoized lookup
 * must not be cancellable by any one caller's abort).
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

    // cwd is set explicitly to the platform temp directory, never
    // inherited from the caller's own working directory — see the file
    // header's ISOLATION paragraph: a project CLAUDE.md/.mcp.json live
    // relative to cwd, and the caller's cwd is often the very repository
    // this call must not see into.
    const child = spawn('claude', args, { env: allowedEnv(process.env), cwd: tmpdir() });
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
 * Single-shot call through `claude -p`, OR — when `options.session` is
 * set — one turn on a held session (see the file header's
 * SESSION-HOLDING TRANSPORT section). See the file header for every
 * flag's justification and every refuse-rather-than-substitute mechanism
 * on the single-shot path.
 */
export async function chat(options: ClaudeCliChatOptions): Promise<ChatReply> {
  if (options.session) {
    return chatOnSession(options.session, options);
  }
  if (options.turns.length === 0) {
    throw new Error('claudeCli.chat() requires at least one turn');
  }
  throwIfAborted(options.abortSignal);
  if (options.apiKey != null) {
    // Refused, not silently ignored — see the file header's CREDENTIAL
    // CONTRACT paragraph.
    throw new Error(
      "claudeCli.chat() does not accept apiKey — it always uses the CLI's own logged-in " +
        'subscription session, never a supplied credential.'
    );
  }

  const args = buildArgs(options.systemPrompt, options.model);
  const input = joinTurns(options.turns);
  // options.onProgress is accepted per the shared ChatOptions contract but
  // never invoked — see the file header's `onProgress` paragraph for why
  // this is a disclosed limitation, not a gap. options.maxTokens is
  // likewise accepted and never used — see the file header's MODEL
  // PINNING / maxTokens paragraph.

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
    // file header's CREDENTIAL CONTRACT paragraph.
    throw new Error(
      `claudeCli.chat(): could not run the claude CLI — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (spawned.exitCode !== 0) {
    // No fallback here either — a non-zero exit refuses, it never retries
    // against a different credential path. describeExit tells a
    // signal-terminated close apart from a bare null exit code — see
    // SpawnResult. describeNonZeroExitReason recovers the REAL failure
    // reason from stdout's own JSON envelope (its `result` field) rather
    // than reporting only the bare exit code — see its own doc comment
    // for why stdout, not just stderr, has to be read here, and for why
    // the separate spawn-failure message above is untouched by this.
    throw new Error(`${describeExit('claude -p', spawned)}${describeNonZeroExitReason(spawned)}`);
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

/**
 * `chat()`'s session branch — one turn on a held session rather than a
 * fresh spawn. See the file header's SESSION-HOLDING TRANSPORT section
 * for the mechanism; this function is deliberately small, reusing the
 * single-shot path's own `contentToText` / `determinePrimaryModel` /
 * `shapeUsage` / `resolveCliVersion` so the two paths report usage
 * identically.
 */
async function chatOnSession(
  session: ClaudeCliSessionHandle,
  options: ClaudeCliChatOptions
): Promise<ChatReply> {
  if (options.turns.length === 0) {
    throw new Error('claudeCli.chat() requires at least one turn');
  }
  if (options.turns.length > 1) {
    // See ClaudeCliChatOptions's own doc comment: a held session already
    // remembers everything before this call, unlike the stateless
    // single-shot path this adapter otherwise uses.
    throw new Error(
      'claudeCli.chat(): when session is set, turns must carry exactly the ONE new message ' +
        'for this round — the held session already remembers everything before it. Resending ' +
        "prior history would duplicate it in the model's own context."
    );
  }
  throwIfAborted(options.abortSignal);
  if (options.apiKey != null) {
    throw new Error(
      "claudeCli.chat() does not accept apiKey — it always uses the CLI's own logged-in " +
        'subscription session, never a supplied credential.'
    );
  }

  const turn = await runSessionTurn({
    session,
    systemPrompt: options.systemPrompt,
    message: contentToText(options.turns[0].content),
    tools: [],
    maxToolCalls: 0,
    model: options.model,
    signal: options.abortSignal,
  });

  const substrateVersion = await resolveCliVersion();
  const { model, sawMultipleModels, breakdown } = determinePrimaryModel(
    turn.usage,
    turn.modelUsage
  );
  if (sawMultipleModels) {
    console.warn(
      `claudeCli.chat(): this call invoked more than one model — ${breakdown}. ` +
        `TokenUsage.model reports only "${model}".`
    );
  }
  const usageRecord = shapeUsage(turn.usage, model, substrateVersion);
  await fireUsageHook(options.onUsage, usageRecord, 'claudeCli.chat');

  return { content: turn.text, usage: usageRecord, stopReason: turn.stopReason };
}

/**
 * NOT SUPPORTED ON THIS TRANSPORT — throws, naming precisely why, rather
 * than silently no-opping or faking the shared contract. See the file
 * header's SESSION-HOLDING TRANSPORT section: tool calls on this adapter
 * run through an embedded MCP server that `claude` itself invokes as
 * part of ITS OWN agentic turn (the bridge needs an executor to answer
 * a `tools/call` synchronously, so it always runs the caller's
 * `ToolExecutor` directly rather than pausing mid-turn to hand control
 * back). By the time this function could return a `tool_use` for a
 * caller to execute separately — this contract's whole point — it has
 * already been executed. There is no point in the exchange this
 * function's return-before-execution shape could occupy on this
 * transport, so it refuses rather than silently degrading into
 * `chatWithToolLoop`'s behaviour under a different name.
 * {@link chatWithToolLoop} is the shape this transport CAN honestly
 * support: supply your executor up front, in `options.executor`.
 */
export async function chatWithTools(
  _options: ClaudeCliChatWithToolsOptions
): Promise<ChatWithToolsResult> {
  throw new Error(
    'claudeCli.chatWithTools() is not supported on this transport — tool calls run through an ' +
      'embedded MCP server that claude itself invokes as part of its own turn, so there is no ' +
      'point where a tool_use exists without already having been executed for a caller to run ' +
      'separately. Use claudeCli.chatWithToolLoop() instead, with your executor supplied up front.'
  );
}

/**
 * Multi-turn tool-using chat — the shape this transport CAN honestly
 * support. See the file header's SESSION-HOLDING TRANSPORT section for
 * the mechanism (an embedded MCP bridge + a kept-alive `claude`
 * process); `--tools ""` stays on, per this file's own constraint — the
 * only tools reachable are the ones named in `options.tools`, offered
 * via an explicit `--mcp-config` naming solely this call's own bridge.
 *
 * Unlike the API adapters, this function makes exactly ONE model-turn
 * request per call — `claude`'s own agentic loop calls tools
 * autonomously within that turn, forwarding each `tools/call` to
 * `options.executor` via the bridge, so there is no manual
 * tool_use/tool_result round trip for this function to drive. `iterations`
 * on the returned result is therefore a PROXY — the number of assistant
 * message events observed in the stream for this turn — not a count of
 * separate model calls this function made (it made one). `maxIterations`
 * is enforced as a tool-CALL budget inside the bridge: once it's spent,
 * further `tools/call` requests get a "budget exhausted, answer now"
 * result rather than reaching the executor, this transport's analogue of
 * the API adapters' no-tools finalise call.
 *
 * `options.session` omitted: a throwaway session is opened and closed
 * for this one call, so the result is self-contained like every other
 * adapter's `chatWithToolLoop`. `options.session` supplied: the turn runs
 * on that held session, and prompt-cache warmth + tool availability
 * persist to the NEXT call on the same handle — see
 * `ClaudeCliChatWithToolLoopOptions`'s own doc comment for the
 * turns-is-only-the-new-message contract that comes with it.
 */
export async function chatWithToolLoop(
  options: ClaudeCliChatWithToolLoopOptions
): Promise<ChatWithToolLoopResult> {
  if (options.turns.length === 0) {
    throw new Error('claudeCli.chatWithToolLoop() requires at least one turn');
  }
  if (options.tools.length === 0) {
    throw new Error('claudeCli.chatWithToolLoop() requires at least one tool');
  }
  if (options.turns.length > 1) {
    throw new Error(
      'claudeCli.chatWithToolLoop(): turns must carry exactly the ONE new message for this ' +
        'round — a held session already remembers everything before it (and a throwaway one, ' +
        'created when options.session is omitted, has nothing before it to need more than one ' +
        'for). See ClaudeCliChatWithToolLoopOptions.'
    );
  }
  throwIfAborted(options.abortSignal);
  if (options.apiKey != null) {
    throw new Error(
      "claudeCli.chatWithToolLoop() does not accept apiKey — it always uses the CLI's own " +
        'logged-in subscription session, never a supplied credential.'
    );
  }

  const ownSession = !options.session;
  const session = options.session ?? createSession();
  const maxToolCalls = Math.max(1, options.maxIterations ?? 5);

  try {
    const turn = await runSessionTurn({
      session,
      systemPrompt: options.systemPrompt,
      message: contentToText(options.turns[0].content),
      tools: options.tools,
      executor: options.executor,
      maxToolCalls,
      model: options.model,
      signal: options.abortSignal,
    });

    const iterations = Math.max(1, turn.assistantEventCount);
    if (options.onIteration) {
      try {
        await options.onIteration({
          iteration: iterations,
          toolUses: turn.toolUses,
          stopReason: turn.stopReason,
        });
      } catch (err) {
        console.warn('claudeCli.chatWithToolLoop: onIteration callback threw', err);
      }
    }

    const substrateVersion = await resolveCliVersion();
    const { model, sawMultipleModels, breakdown } = determinePrimaryModel(
      turn.usage,
      turn.modelUsage
    );
    if (sawMultipleModels) {
      console.warn(
        `claudeCli.chatWithToolLoop(): this call invoked more than one model — ${breakdown}. ` +
          `TokenUsage.model reports only "${model}".`
      );
    }
    const usageRecord = shapeUsage(turn.usage, model, substrateVersion);
    await fireUsageHook(options.onUsage, usageRecord, 'claudeCli.chatWithToolLoop');

    return {
      text: turn.text,
      toolUses: turn.toolUses,
      toolResults: turn.toolResults,
      iterations,
      usage: usageRecord,
    };
  } finally {
    if (ownSession) {
      // A caller that never asked to hold state gets a fully self-contained
      // call — nothing left registered for SESSION_IDLE_TIMEOUT_MS to clean
      // up later. Best-effort: a close failure here must not mask whatever
      // the turn itself returned or threw.
      await closeSession(session).catch(() => {});
    }
  }
}

export const claudeCli = {
  PROVIDER,
  chat,
  chatWithTools,
  chatWithToolLoop,
  createSession,
  closeSession,
};
