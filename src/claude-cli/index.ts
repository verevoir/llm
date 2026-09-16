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
 * ══════════════════════════════════════════════════════════════════════
 * SECURITY CORRECTION (0.26.3) — READ THIS BEFORE TOUCHING THE FLAG LIST.
 * ══════════════════════════════════════════════════════════════════════
 * Every published version from 0.25.0 through 0.26.2 passed `--tools ""`
 * and this file's own header claimed that "disabl[ed] tool use
 * substrate-wide". That was never true. Confirmed directly against the
 * CLI (the operator ran it and relayed the answer, the same discipline
 * every other confirmed fact in this file rests on): `--tools` takes a
 * SPACE-SEPARATED ALLOWLIST of tool names; an empty string is read as
 * NOT SET, not as an empty allowlist, so the flag silently did nothing
 * and every call fell through to the CLI's own default built-in tool
 * set the entire time this adapter has been published. This is the
 * exact property the "no-bypass" architecture depends on — the reason a
 * model must go through the caller's own tool belt rather than reading
 * files directly — and the published package never had it.
 *
 * THE FIX: `--disallowedTools "*"`. Confirmed (not relayed) to remove a
 * tool from context ENTIRELY when named bare (as opposed to a scoped
 * rule like `Bash(rm *)`, which leaves the tool advertised and denies
 * only matching calls) — "absent", the same failure shape this codebase
 * uses everywhere else, not "refused". `EndConversation` is documented
 * as deliberately exempt from deny rules while any other tool remains;
 * expect to see it survive and do not read that as the fix failing.
 *
 * `--allowedTools` WAS CONSIDERED AND REJECTED — it is CONFIRMED
 * ADDITIVE on top of the CLI's own default safe-list ("these run
 * without prompting"), not a restriction, and removes nothing. Using it
 * expecting an allowlist would have been a second, identically-shaped
 * silent fail-open. Grepped: not used anywhere in this codebase.
 *
 * GETTING A FLAG RIGHT ONCE IS NOT THE FIX — this is also why `chat()`
 * now speaks `stream-json` on BOTH stdin and stdout (see TOOL-SAFETY
 * VERIFICATION below) rather than trusting `--disallowedTools "*"` by
 * construction the way `--tools ""` was trusted. The CLI's own
 * `{"type":"system","subtype":"init",...}` event carries a `tools`
 * array — the only authoritative, checkable answer to what a run
 * actually has. A flag is an intention; the init event is the
 * observable. `chat()` asserts against it on every call, and refuses
 * rather than proceeding on a mismatch — the exact mechanism that would
 * have caught the `--tools ""` defect on day one instead of it shipping
 * silently for three minor versions.
 *
 * DELIBERATELY NOT TOUCHED HERE: whether `--safe-mode` actually
 * suppresses MCP-server loading is a SEPARATE, still-unconfirmed
 * question (see the ISOLATION paragraph below) — conflating that fix
 * with this one is exactly how the `--tools ""` defect nearly escaped a
 * second time layered under a different, harder-to-isolate change. This
 * adapter never passes `--mcp-config` at all (see ISOLATION), so the
 * question does not even arise for `chat()`'s own single-shot path.
 *
 * TOOL-SAFETY VERIFICATION — THE MECHANISM. `chat()` builds its stdin as
 * ONE `{"type":"user","message":{"role":"user","content":"..."}}` line
 * (the flattened turn text, unchanged) under `--input-format stream-json
 * --output-format stream-json --verbose` (the last is CONFIRMED
 * required by a real invocation: `-p --output-format stream-json`
 * without it fails immediately with "Error: When using --print,
 * --output-format=stream-json requires --verbose", exit 1, before
 * producing any stream-json line at all). On a successful exit, the
 * stdout stream is split into JSON-per-line events; the
 * `{"type":"system","subtype":"init"}` event's `tools` array MUST be
 * empty, matching `--disallowedTools "*"`'s promise of zero built-in
 * tools reachable. A NON-EMPTY array, or NO init event found in the
 * stream at all (parsing failed, the shape changed, anything this
 * adapter cannot make sense of), THROWS rather than returning a reply
 * that may have used capabilities this call never declared — refusing
 * to proceed on an unverifiable safety property, not merely an
 * incorrect one.
 *
 * PAYLOAD CONTRACT for the terminal `{"type":"result",...}` event,
 * confirmed against real invocations (history in CHANGELOG.md, not
 * repeated here). Field-for-field IDENTICAL to the previous
 * `--output-format json` envelope this file used to parse directly —
 * only the FRAMING changed (one line among several in a stream, not the
 * sole stdout payload). The reply text is a FLAT STRING under `result`
 * — not `content`, not `text`, not nested. `stop_reason` is a real
 * top-level field and maps directly to `ChatReply.stopReason`. `usage`
 * carries `input_tokens` / `output_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens`. There is NO version field anywhere in
 * the payload — `resolveCliVersion()`'s memoized `claude --version`
 * spawn (below) is the ONLY source of `substrateVersion`. `is_error:
 * true` CAN APPEAR ALONGSIDE A ZERO EXIT CODE, and — confirmed by a real
 * invocation — CAN APPEAR ALONGSIDE `subtype: "success"`: `subtype`
 * describes how the request/response cycle ended, not whether the
 * content is a failure, so `chat()` reads only `is_error`, never
 * `subtype`, as the failure signal. A SINGLE CALL CAN INVOKE MORE THAN
 * ONE MODEL — `modelUsage` may name several; `determinePrimaryModel()`
 * (below) reports only the entry matching the top-level `usage` block as
 * `TokenUsage.model`, but every entry is named in a `console.warn` when
 * more than one is present, so a second model having run is never
 * silently dropped.
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
 * `chat()` ONLY in this first cut — no `chatWithTools` /
 * `chatWithToolLoop`. `/google` shipped the same way at its own v0.4.0
 * release (chat() only), then added chatWithTools/chatWithToolLoop in
 * 0.13.0 — cited here as HISTORICAL precedent for a first cut, not as
 * `/google`'s current state, which already has both. `--disallowedTools
 * "*"` (always passed) makes a tool loop moot for THIS adapter's single-
 * shot purpose anyway, so a turn carrying a `tool_use` / `tool_result`
 * block is refused rather than silently flattened.
 *
 * `abortSignal` IS HONOURED AT ENTRY AND MID-CALL, not just an entry
 * check: aborting while the spawned child is still running kills it
 * (`child.kill()`) and rejects immediately with the signal's own reason,
 * rather than letting the subprocess finish in the background. The
 * memoized `claude --version` lookup is deliberately NOT wired to any
 * one call's signal, since every caller shares it.
 *
 * `onProgress` IS ACCEPTED, NEVER INVOKED. `--disallowedTools "*"`
 * disables every built-in tool a `report_progress` mechanism would
 * need, and the terminal `result` event still delivers the full reply
 * only once, not incrementally — there is no partial signal to narrate
 * from either way. A caller supplying `onProgress` will never see it
 * called; nothing here throws for supplying it.
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
 * servers/custom commands. Two more, deliberate: `--strict-mcp-config`
 * is passed on every invocation, so even if `--safe-mode`'s MCP
 * suppression turns out narrower in practice than its `--help` states,
 * no MCP server from any configuration source reaches this call — only
 * servers passed via an explicit `--mcp-config` flag would, and this
 * adapter never passes that flag, so the effective set is always empty.
 * And the spawn's `cwd` (see `runClaudeCli`) is set explicitly to the
 * platform temp directory rather than inherited from whatever directory
 * the calling process happens to be running in — a project's
 * `CLAUDE.md` / `.mcp.json` live relative to cwd, and a governance
 * review process's cwd is typically the very repository it is
 * reviewing, which is precisely the content this call must not see.
 * Both are defense-in-depth alongside `--safe-mode`, not a claim that
 * `--safe-mode` alone was proven insufficient — this repository has not
 * independently re-confirmed `--safe-mode`'s own documented MCP/
 * CLAUDE.md suppression by direct observation, so it is not relied on
 * alone, and whether it actually holds remains a SEPARATE, open
 * question this change does not touch (see the SECURITY CORRECTION
 * paragraph above).
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
  type PermissionDenial,
} from './session.js';

// PROVIDER and the env allowlist (ALLOWED_ENV_VARS / allowedEnv /
// CLAUDE_CLI_CREDENTIAL_ENV_VAR) moved to env.ts — see that file's own
// header for why (the session-holding transport below needs to build
// the identical child environment without importing back into this
// file). Re-exported here under the exact same names, so nothing
// importing @verevoir/llm/claude-cli can tell they ever moved.
export { ALLOWED_ENV_VARS, allowedEnv, CLAUDE_CLI_CREDENTIAL_ENV_VAR, PROVIDER };

// The session-holding transport (session.ts, wave 2 of this split, plus
// mcp-bridge.ts, 0.26.6) — re-exported from this single subpath entry
// point, same as every other name here. See this file's SESSION-HOLDING
// TRANSPORT paragraph below and session.ts's own header for the full
// mechanism and verification history.
export {
  closeSession,
  createSession,
  resetClaudeCliSessionsForTests,
  SESSION_IDLE_TIMEOUT_MS,
  SESSION_MAX_HELD,
  SESSION_TURN_TIMEOUT_MS,
  type ClaudeCliSessionHandle,
  type PermissionDenial,
};

/**
 * SESSION-HOLDING TRANSPORT (wave 3 of the split that replaced the
 * withdrawn omnibus #55; the mechanism itself was scoped and built as
 * one whole, then divided for review afterward — see CHANGELOG's
 * 0.26.7-0.27.1 entries for the full account of why and how it splits).
 *
 * feature parity on the keyless route was the bar: `chat()`'s single
 * spawn-per-call process meant a tool exchange (ask → execute →
 * continue) had structurally nowhere to live — turn N and turn N+1 were
 * two different processes with nothing in common. The operator's
 * decision: hold a session across a whole CONVERSATION, not one call,
 * and expose it as a handle the CALLER owns — this package has no
 * concept of a conversation, so a lifetime keyed on one would be policy
 * this package cannot reason about. `createSession()`/`closeSession()`
 * and the mechanism itself live in `session.ts`; this file wires three
 * entry points against it: `chat()` gains an optional `session` for
 * prompt-cache warmth without tools; `chatWithToolLoop()` runs the
 * caller's own tools through the embedded MCP bridge (`mcp-bridge.ts`,
 * 0.26.6) without lifting the built-in-tool denial; `chatWithTools()`
 * (single-shot, return-before-execution) REFUSES on this transport,
 * naming precisely why — tools run through `claude`'s own agentic loop
 * via MCP, so there is never a point where a `tool_use` exists without
 * already having been executed for a caller to run separately.
 *
 * RELAYED, NOT CONFIRMED, the same standard this adapter already holds
 * `--model` to: whether `--input-format`/`--output-format stream-json`
 * keeps one process alive across multiple turns, and whether an
 * MCP-declared tool stays reachable under `--disallowedTools "*"`, are
 * both asserted from Claude Code's own documented flags and MCP's own
 * published stdio transport spec — not fully independently observed by
 * this repository (see session.ts's own header for the full,
 * three-real-invocation verification history, and what remains open).
 */

/** Flags applied to every invocation. See the file header's SECURITY
 * CORRECTION and TOOL-SAFETY VERIFICATION paragraphs for why this is
 * `--disallowedTools "*"` plus the stream-json input/output pair, not
 * `--tools ""` plus `--output-format json` as before 0.26.3 — and why
 * `--bare` / `--json-schema` / `--allowedTools` are not used instead.
 * `--model` is appended only when `model` is supplied — see the file
 * header's MODEL PINNING paragraph; omitting it leaves the CLI's own
 * default model selection untouched. */
function buildArgs(systemPrompt: string, model: string | undefined): string[] {
  const args = [
    '-p',
    '--system-prompt',
    systemPrompt,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // CONFIRMED required by a real invocation, not relayed: `-p
    // --output-format stream-json` without this fails immediately with
    // "Error: When using --print, --output-format=stream-json requires
    // --verbose" (exit 1) before producing any stream-json line at all.
    '--verbose',
    // CONFIRMED to remove every built-in tool from context entirely when
    // named bare, unlike --tools "" — see the file header's SECURITY
    // CORRECTION paragraph. This adapter never passes --mcp-config, so
    // there is no MCP tool for --disallowedTools's own documented
    // MCP-filtering quirk to matter for on this path.
    '--disallowedTools',
    '*',
    '--strict-mcp-config',
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
 * adapter has no tool loop (`--disallowedTools "*"` disables every
 * built-in tool) — so a turn carrying one is refused rather than
 * silently flattened away.
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
        'has no tool loop (--disallowedTools "*" disables every built-in tool), so a ' +
        'tool_use/tool_result block would be silently dropped rather than acted on. Use plain ' +
        'text turns.'
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

/** Wraps the flattened turn text as ONE `stream-json` input line — the
 * shape a real invocation confirmed works for a single-shot exchange
 * (see the file header's TOOL-SAFETY VERIFICATION paragraph). Still
 * exactly one message, still exactly one reply; only the wire framing
 * changed from a raw text blob to this envelope. */
function buildStreamInputLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

/** Per-model usage entry inside the terminal `result` event's `modelUsage`
 * map — confirmed real, see the file header's PAYLOAD CONTRACT
 * paragraph. */
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
 * The terminal `{"type":"result",...}` stream-json event's shape —
 * confirmed real, field-for-field identical to the previous
 * `--output-format json` envelope (see the file header's PAYLOAD
 * CONTRACT paragraph for how this was established). Fields not
 * confirmed present in every observed shape stay optional so a shape
 * lacking one still parses without throwing.
 *
 * `usage` below uses snake_case field names while `modelUsage`'s entries
 * (`ModelUsageEntry`) use camelCase — a real inconsistency in the payload,
 * not a naming slip in this file: the operator's relayed real invocation
 * showed exactly this mix (snake_case `usage.input_tokens` alongside
 * camelCase `modelUsage[key].inputTokens`), so both conventions are kept
 * as observed rather than normalised to one.
 */
interface ClaudeCliResultEvent {
  type?: string;
  /** The reply text — a flat string. Confirmed; this is the only text
   * field this adapter reads. */
  result?: string;
  /** True when the CLI itself reports a failure, independent of the
   * process exit code AND independent of `subtype` — see the file
   * header's PAYLOAD CONTRACT paragraph: a real envelope carried
   * `subtype: "success"` alongside `is_error: true`. Only `is_error` is
   * ever read as the failure signal below. */
  is_error?: boolean;
  /** Diagnostic context for an `is_error: true` payload, e.g.
   * `"error_max_turns"` — included in this adapter's thrown error
   * message when present, but NEVER read as a second success/failure
   * signal. */
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

/** The `{"type":"system","subtype":"init",...}` stream-json event's shape
 * — specifically the ONE field this adapter reads from it: `tools`, the
 * only authoritative, checkable answer to what built-in tools a run
 * actually has. See the file header's TOOL-SAFETY VERIFICATION
 * paragraph. Every other field the CLI puts on this event (model,
 * permissionMode, slash_commands, session_id, …) is real but irrelevant
 * to this adapter and deliberately not modelled. */
interface ClaudeCliInitEvent {
  type?: string;
  subtype?: string;
  tools?: string[];
}

/** Parses `claude`'s `stream-json` stdout into one JSON object per
 * non-empty line. A line that is not valid JSON is silently skipped
 * here, not treated as fatal on its own — if the events this adapter
 * actually needs (the init event, the result event) are never found
 * among what DID parse, the caller-side checks below refuse explicitly
 * rather than guessing from a partial or malformed stream. */
function parseStreamEvents(stdout: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON line — ignored; see this function's own doc comment.
    }
  }
  return events;
}

function findResultEvent(events: Array<Record<string, unknown>>): ClaudeCliResultEvent | null {
  const found = events.find((e) => e.type === 'result');
  return found ? (found as ClaudeCliResultEvent) : null;
}

function findInitEvent(events: Array<Record<string, unknown>>): ClaudeCliInitEvent | null {
  const found = events.find((e) => e.type === 'system' && e.subtype === 'init');
  return found ? (found as ClaudeCliInitEvent) : null;
}

/**
 * THE VERIFICATION ITSELF — see the file header's TOOL-SAFETY
 * VERIFICATION paragraph for the full reasoning. Checks the CLI's own
 * `init` event's `tools` array — never trusts `--disallowedTools "*"`
 * by construction the way `--tools ""` used to be trusted. Throws,
 * naming exactly what was found, on either failure mode: a non-empty
 * array (the flag did not do what it was supposed to), or no init event
 * at all (the property cannot be verified, so this refuses rather than
 * silently proceeding as if it had been).
 */
function assertNoBuiltinToolsReachable(events: Array<Record<string, unknown>>): void {
  const init = findInitEvent(events);
  if (!init) {
    throw new Error(
      'claudeCli.chat(): could not verify the promised zero-built-in-tools property — no ' +
        '{"type":"system","subtype":"init"} event was found in the stream-json output to check ' +
        'its own "tools" array against. Refusing rather than silently proceeding as if ' +
        '--disallowedTools "*" had been honoured unseen.'
    );
  }
  const tools = Array.isArray(init.tools) ? init.tools : [];
  if (tools.length > 0) {
    throw new Error(
      'claudeCli.chat(): expected zero built-in tools reachable (per --disallowedTools "*"), ' +
        `but the CLI's own init event reported ${tools.length}: ${tools.join(', ')}. Refusing to ` +
        'return a reply that may have used tools this call never declared — this is the exact ' +
        'class of defect --tools "" silently had in every 0.25.0-0.26.2 release (see the file ' +
        "header's SECURITY CORRECTION paragraph)."
    );
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
  usage: ClaudeCliResultEvent['usage'],
  modelUsage: ClaudeCliResultEvent['modelUsage']
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
  usage: ClaudeCliResultEvent['usage'],
  model: string,
  substrateVersion: string | undefined
): TokenUsage {
  // Constant, never computed — see the file header's PAYLOAD CONTRACT
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
 * Recovers the REAL failure reason on a non-zero exit from the terminal
 * `{"type":"result",...}` stream-json event on stdout, rather than
 * reporting only the bare exit code (and possibly stderr).
 *
 * THE ESCAPED DEFECT THIS EXISTS TO FIX. `claude -p`'s commonest real
 * failure — not logged in — exits 1 with EMPTY stderr; the actual reason
 * ("Not logged in · Please run /login") lives only in stdout's own
 * result event, in `result`, typically alongside `is_error: true`.
 *
 * RECOVERY ORDER: stdout is parsed as stream-json events; the result
 * event's `result` field wins when present and non-empty. Otherwise this
 * falls back to stdout's raw text (stdout that isn't valid JSON at all,
 * or carries no result event with a usable `result`). `stderr` is
 * appended ONLY when it says something the recovered text doesn't
 * already say, so a `stderr` that merely repeats the same message is
 * never duplicated into it.
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
  const events = parseStreamEvents(spawned.stdout);
  const resultEvent = findResultEvent(events);
  const fromResult =
    resultEvent && typeof resultEvent.result === 'string' ? resultEvent.result.trim() : '';
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
 * Single-shot call through `claude -p`. See the file header for every
 * flag's justification and every refuse-rather-than-substitute mechanism.
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
    // Refused, not silently ignored — see the file header's PAYLOAD
    // CONTRACT paragraph.
    throw new Error(
      "claudeCli.chat() does not accept apiKey — it always uses the CLI's own logged-in " +
        'subscription session, never a supplied credential.'
    );
  }

  const args = buildArgs(options.systemPrompt, options.model);
  const input = buildStreamInputLine(joinTurns(options.turns));
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
    // file header's PAYLOAD CONTRACT paragraph.
    throw new Error(
      `claudeCli.chat(): could not run the claude CLI — ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (spawned.exitCode !== 0) {
    // No fallback here either — a non-zero exit refuses, it never retries
    // against a different credential path. describeExit tells a
    // signal-terminated close apart from a bare null exit code — see
    // SpawnResult. describeNonZeroExitReason recovers the REAL failure
    // reason from stdout's own result event rather than reporting only
    // the bare exit code — see its own doc comment for why stdout, not
    // just stderr, has to be read here, and for why the separate
    // spawn-failure message above is untouched by this.
    throw new Error(`${describeExit('claude -p', spawned)}${describeNonZeroExitReason(spawned)}`);
  }

  const events = parseStreamEvents(spawned.stdout);

  // THE TOOL-SAFETY VERIFICATION — see the file header. Runs before
  // anything else on a successful exit, unconditionally: the promise
  // this call makes about tool reachability is checked against the
  // CLI's own observable, not assumed from the flag alone.
  assertNoBuiltinToolsReachable(events);

  const parsed = findResultEvent(events);

  if (parsed?.is_error) {
    // Confirmed real: the CLI can exit 0 while its own payload says
    // is_error: true — see the file header. Exit code alone is not a
    // sufficient failure signal for this adapter. subtype is included
    // for diagnostic context only, never read as a second signal — a
    // confirmed real envelope carried subtype: "success" alongside
    // is_error: true.
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
      'claudeCli.chat(): the stream-json output did not carry a {"type":"result",...} event ' +
        'with a string "result" field — treating the raw stdout as text. The real envelope has ' +
        'been observed and this shape is confirmed (see the file header); this fallback is for ' +
        'a shape that does not match it, e.g. a malformed stream or a future CLI change.'
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
 * {@link ChatOptions}, plus an optional held session — see the file
 * header's SESSION-HOLDING TRANSPORT section. Additive only: a caller
 * that never sets `session` sees exactly today's stateless single-shot
 * `chat()`, unchanged in every respect. When `session` IS set, `turns`
 * must carry exactly the ONE new message for this round — the held
 * session already remembers everything before it (see
 * `chatOnSession`'s own check). Nothing about this field forces
 * anything — the caller can always fall back to `chat()`/
 * `chatWithToolLoop()` WITHOUT a `session`, resending its own full
 * history through the stateless single-shot path. That fallback, always
 * available, is what makes a held session's own TTL (see session.ts's
 * own file header) a resource policy rather than a correctness one:
 * losing one costs a cold rebuild, never lost work, because the caller
 * never depended on this package to be the only place the conversation
 * lived.
 */
export interface ClaudeCliChatOptions extends ChatOptions {
  session?: ClaudeCliSessionHandle;
}

/** {@link ChatWithToolsOptions}, plus the same optional `session` field.
 * See {@link chatWithTools}'s own doc comment for why this function
 * REFUSES on this transport regardless of whether `session` is set —
 * the field exists for type-shape parity with
 * {@link ClaudeCliChatWithToolLoopOptions}, not because this function
 * honours it. */
export interface ClaudeCliChatWithToolsOptions extends ChatWithToolsOptions {
  session?: ClaudeCliSessionHandle;
}

/**
 * Single-shot, return-before-execution tool calling — UNSUPPORTED on
 * this transport, and refuses rather than faking the contract. Tools on
 * this adapter run through `claude`'s own agentic loop via the embedded
 * MCP bridge (`mcp-bridge.ts`): the bridge answers a `tools/call` by
 * running the caller's executor IMMEDIATELY and SYNCHRONOUSLY, inside
 * `claude`'s own turn. By the time this function could hand a `tool_use`
 * back to a caller to execute separately — this contract's whole point
 * — it has already been executed. There is no point in the exchange
 * this function's return-before-execution shape could occupy on this
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

/** {@link ChatWithToolLoopOptions}, plus an optional held session. Same
 * `turns`-is-only-the-new-message contract as {@link ClaudeCliChatOptions}
 * when `session` is set. Omitting `session` still works — a throwaway
 * session is created and closed for the one call, so a caller that
 * doesn't want to hold state across calls sees a single, self-contained
 * `chatWithToolLoop()` exactly like every other adapter's. */
export interface ClaudeCliChatWithToolLoopOptions extends ChatWithToolLoopOptions {
  session?: ClaudeCliSessionHandle;
}

/**
 * {@link ChatWithToolLoopResult}, plus this transport's own
 * `permissionDenials` signal — see {@link PermissionDenial}'s own doc
 * comment (in session.ts) for what it means and, just as importantly,
 * what an EMPTY one does and does not tell a caller (read it alongside
 * `toolUses`, never alone). Additive only — every base field is
 * unchanged.
 */
export interface ClaudeCliChatWithToolLoopResult extends ChatWithToolLoopResult {
  permissionDenials: PermissionDenial[];
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
        "for this round — the held session already remembers everything before it. Resending " +
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
 * Multi-turn tool loop on this transport — runs the caller's own tools
 * through the embedded MCP bridge inside `claude`'s own agentic loop,
 * rather than this function manually feeding `tool_use`/`tool_result`
 * blocks back and forth the way the API adapters' `chatWithToolLoop`
 * does. `maxIterations` is enforced as a tool-CALL budget inside the
 * bridge — once spent, further calls get a "budget exhausted, answer
 * now" result rather than reaching the executor, this transport's
 * analogue of the API adapters' no-tools finalise call.
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
): Promise<ClaudeCliChatWithToolLoopResult> {
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
      permissionDenials: turn.permissionDenials,
      iterations: turn.assistantEventCount,
      usage: usageRecord,
    };
  } finally {
    if (ownSession) {
      // A throwaway session opened just for this call — nothing left
      // registered for SESSION_IDLE_TIMEOUT_MS to clean up later.
      // Best-effort: a close failure here must not mask whatever the
      // turn itself returned or threw.
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
