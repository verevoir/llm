/**
 * @verevoir/llm/claude-cli — held sessions.
 *
 * See index.ts's file header (SESSION-HOLDING TRANSPORT section) for the
 * why; this header covers the how, and the exact operator verification
 * this mechanism rests on.
 *
 * ONE PROCESS PER HANDLE, KEPT ALIVE ACROSS TURNS. `claude -p
 * --input-format stream-json --output-format stream-json` is spawned
 * once per session and left running; each turn writes one
 * `{"type":"user",...}` JSON line to its stdin and waits for a terminal
 * `{"type":"result",...}` line on stdout, rather than the single-shot
 * path's spawn-per-call. `--tools ""` / `--strict-mcp-config` /
 * `--no-session-persistence` / `--safe-mode` stay on exactly as the
 * single-shot path uses them (see index.ts's own file header for why
 * each is there); `--mcp-config` names this session's own bridge
 * (`mcp-bridge.ts`) when the session has tools, and is omitted entirely
 * for a tool-free session (plain `chat()` with `session` set, held only
 * for prompt-cache warmth).
 *
 * THE SYSTEM PROMPT, MODEL, AND TOOL SET ARE FIXED AT SPAWN. `-p`'s
 * `--system-prompt` and `--model` are startup flags, not something a
 * stream-json turn can change mid-process, and the MCP bridge's tool
 * declarations are baked into its shim script at generation time. A
 * later call reusing the same handle with a DIFFERENT systemPrompt,
 * model, or tool set is refused with a specific error naming the
 * mismatch, rather than either silently keeping the old binding or
 * silently reconfiguring it — the same "declares it rather than
 * pretending" standard this whole adapter holds itself to. Close the
 * session and open a new one to change any of those.
 *
 * DEAD-HANDLE SAFETY. `getOrCreateSession` never distinguishes "this id
 * was never used", "its process already exited", and "it was evicted" —
 * all three simply spawn fresh under the same id. A handle is therefore
 * ALWAYS safe to present: the truth arrives on use, the same shape as a
 * 401, and the caller's own `turns` stay the ground truth regardless of
 * whether the accelerator underneath survived.
 *
 * BOUNDED, SO AN UNRELEASED HANDLE CANNOT ACCUMULATE PROCESSES FOREVER.
 * Two independent bounds, both — a caller that only ever uses
 * `chatWithToolLoop()` without a `session` never hits either, since that
 * path closes its own throwaway session at the end of every call (see
 * index.ts):
 *   - {@link SESSION_IDLE_TIMEOUT_MS}: a session with no turn IN FLIGHT
 *     and none started for this long is killed and evicted.
 *   - {@link SESSION_MAX_HELD}: the process-wide cap on LIVE sessions.
 *     Creating one past the cap evicts the least-recently-used first
 *     (touch order is turn order, not creation order).
 *
 * THE TTL IS A RESOURCE POLICY, NOT A CORRECTNESS MECHANISM — and this is
 * only true because of a property that holds everywhere else in this
 * package too: the session is a CACHE over a stateless truth. The
 * caller's own `turns` remain the ground truth (see index.ts's
 * `ClaudeCliChatOptions` doc comment — a held session only ever adds an
 * accelerator on top of that, the same rehydration guarantee every other
 * adapter in this package gives by resending its full `turns` array
 * every call). So the worst case of a session being reclaimed too early
 * is a cold rebuild — a fresh process, cache cold, tools re-declared —
 * never lost work: `getOrCreateSession`'s dead-handle path (below) makes
 * a reclaimed handle behave exactly like one that was never used. That
 * is what makes {@link SESSION_IDLE_TIMEOUT_MS} safe to tune freely in
 * either direction: get it wrong and someone pays in tokens re-warming a
 * cache, never in correctness.
 *
 * MEASURES IDLE TIME, NOT AGE — and specifically the GAP BETWEEN turns,
 * never the length of one. A session with a turn actively in flight is
 * not idle, however long that one turn takes; a session sitting between
 * turns with no traffic for the full timeout IS idle, and the operator's
 * own view is that a self-paced loop quiet for hours is exactly the case
 * this should reclaim — "those should not be running in that manner".
 * Concretely: {@link SESSION_IDLE_TIMEOUT_MS}'s timer is CANCELLED the
 * moment a turn starts and only rescheduled once it settles (see
 * `runSessionTurn`'s own comment) — so a long single turn is bounded
 * solely by {@link SESSION_TURN_TIMEOUT_MS} below, and never competes
 * with the idle timer for the same turn.
 *
 * A PER-TURN WATCHDOG ({@link SESSION_TURN_TIMEOUT_MS}) kills the held
 * process and refuses the turn's promise if no terminal `result` event
 * arrives in time — the concrete form of "refuse clearly rather than
 * hang" for a wire shape this repository has not independently
 * confirmed (see below).
 *
 * ONE TURN IN FLIGHT PER SESSION. A session serves one `runSessionTurn`
 * call at a time; a second call on the same handle while the first is
 * still pending is refused rather than interleaved (there is exactly
 * one "armed" bridge state and one "pending" stdout listener per
 * session — see `mcp-bridge.ts`'s own doc comment on why that's safe
 * given this constraint). The caller awaits one call before starting
 * the next on the same handle.
 *
 * THE EXACT VERIFICATION THIS MECHANISM NEEDS, RELAYED FROM THE
 * OPERATOR. Everything below is asserted from Claude Code's own
 * documented `--input-format`/`--output-format stream-json` and
 * `--mcp-config` flags plus MCP's own published stdio transport spec —
 * NOT independently observed by this repository the way the single-shot
 * `-p --output-format json` envelope was (CHANGELOG 0.25.0). Run:
 *
 *   1. Write a minimal stdio MCP server (any language) that answers
 *      `initialize`, `tools/list` (one tool, e.g. `echo`), and
 *      `tools/call` (echoes its argument back as `content`), and an
 *      `--mcp-config` JSON naming it.
 *   2. Pipe TWO newline-delimited `{"type":"user","message":{"role":"user","content":"..."}}`
 *      lines into `claude -p --input-format stream-json --output-format
 *      stream-json --verbose --tools "" --strict-mcp-config --mcp-config
 *      <path> --no-session-persistence --safe-mode` — the SECOND message
 *      asking the model to call the `echo` tool — without closing
 *      stdin between them. (`--verbose` is CONFIRMED REQUIRED here, not
 *      relayed: a first probe run omitting it failed immediately with
 *      `Error: When using --print, --output-format=stream-json requires
 *      --verbose`, exit code 1, before any stream-json line was ever
 *      produced — see CHANGELOG. `buildSessionArgs` below already
 *      includes it; this is what confirmed it was necessary.)
 *   3. Relay back, verbatim: every stdout line for BOTH turns (does a
 *      `{"type":"result",...}` line appear once per turn, on the SAME
 *      process, confirming one process serves multiple turns — not one
 *      exit after the first?); whether the `echo` tool was actually
 *      invoked (does the probe server's own stdin receive a
 *      `tools/call` line, i.e. does `--tools ""` leave an MCP-declared
 *      tool reachable, or does it also block MCP tools?); the exit code
 *      and any stderr; and the exact JSON shape of the terminal
 *      `result` line (does it carry `result`/`is_error`/`stop_reason`/
 *      `usage`/`modelUsage`, the same fields the confirmed single-shot
 *      envelope carries?).
 *
 * If that comes back showing `--tools ""` also blocks the MCP tool, or
 * that the process exits after one line regardless of `--input-format`,
 * this mechanism does not hold and needs a different flag or a different
 * design — not a silent downgrade to dropping tool calls.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolDef, ToolExecutor, ToolUse } from '../index.js';
import { allowedEnv } from './env.js';
import { createToolBridge, type ArmedTurnState, type ToolBridge } from './mcp-bridge.js';
import type { BridgeToolResult } from './mcp-bridge.js';

/** An opaque handle to a held `claude` session — see index.ts's file
 * header for the full contract. Carries nothing but an id: every fact
 * about the session it names lives in this module's own internal map,
 * never on the handle itself, so a handle is safe to serialise, log, or
 * hold past the session's own life without leaking anything. */
export interface ClaudeCliSessionHandle {
  readonly id: string;
}

/** How long a session with NO TURN IN FLIGHT is kept alive before being
 * killed and evicted — the gap between turns, never a turn's own
 * length (see the file header's TTL-IS-A-RESOURCE-POLICY /
 * MEASURES-IDLE-TIME paragraphs). Cancelled while a turn is pending;
 * rescheduled once it settles. A resource policy, freely tunable —
 * getting it wrong costs a token-spending cold rebuild, never
 * correctness, because the caller's own turns remain the ground truth. */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** The process-wide cap on LIVE held sessions. Creating one past the cap
 * evicts the least-recently-used first. */
export const SESSION_MAX_HELD = 4;

/** How long a single turn waits for a terminal `result` event before
 * the held process is killed and the turn refuses. See this module's
 * file header for why this exists — a wire shape this repository has
 * not independently confirmed must fail loudly, not hang. */
export const SESSION_TURN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

interface PendingTurn {
  resolve: (envelope: { raw: ClaudeCliStreamResultEnvelope; assistantEventCount: number }) => void;
  reject: (err: unknown) => void;
  assistantEventCount: number;
  watchdog: ReturnType<typeof setTimeout>;
}

interface HeldSession {
  id: string;
  child: ChildProcessWithoutNullStreams;
  bridge: ToolBridge | null;
  toolNames: string[];
  systemPrompt: string;
  model: string | undefined;
  idleTimer: ReturnType<typeof setTimeout>;
  closed: boolean;
  lineBuffer: string;
  pending: PendingTurn | null;
}

/** `--output-format json`'s confirmed envelope shape (index.ts's
 * `ClaudeCliJsonResult`), assumed — RELAYED, NOT CONFIRMED, see this
 * file's own header — to be the same inner shape carried by a
 * stream-json turn's terminal `{"type":"result",...}` line. Declared
 * separately from index.ts's own (private) copy rather than imported:
 * the two parse different FRAMINGS (one JSON document at process exit
 * vs. one line among many in a live stream) even if the inner fields
 * turn out identical, so they are free to diverge without one file's
 * fix silently becoming the other's regression. */
interface ClaudeCliStreamResultEnvelope {
  type?: string;
  result?: string;
  is_error?: boolean;
  subtype?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
      canonicalModel?: string;
    }
  >;
}

const HELD = new Map<string, HeldSession>();

/** A fresh, opaque session handle. Spawns nothing yet — the first
 * `runSessionTurn` call against it is what actually starts `claude`, so
 * creating a handle you never use costs nothing. */
export function createSession(): ClaudeCliSessionHandle {
  return { id: randomUUID() };
}

/** Release a held session explicitly: kill its process (if live), tear
 * down its bridge, and stop its idle timer. Idempotent — closing an
 * unknown or already-closed handle is a no-op, the same dead-handle
 * safety `runSessionTurn` gives a fresh call. */
export async function closeSession(handle: ClaudeCliSessionHandle): Promise<void> {
  const session = HELD.get(handle.id);
  if (!session) return;
  HELD.delete(handle.id);
  await killHeld(session);
}

/** Test-only: kill and clear every held session so a test file starts
 * clean rather than inheriting a process left running by an earlier
 * test — mirrors index.ts's `resetClaudeCliVersionCacheForTests`. Never
 * called from production code. */
export function resetClaudeCliSessionsForTests(): void {
  const sessions = [...HELD.values()];
  HELD.clear();
  for (const session of sessions) void killHeld(session);
}

async function killHeld(session: HeldSession): Promise<void> {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.idleTimer);
  if (session.pending) {
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.watchdog);
    pending.reject(
      new Error(`claude-cli: session ${session.id} was closed/evicted while a turn was in flight`)
    );
  }
  try {
    session.child.kill();
  } catch {
    // Already dead — nothing to do.
  }
  if (session.bridge) await session.bridge.close();
}

function touchLRU(id: string): void {
  const s = HELD.get(id);
  if (!s) return;
  HELD.delete(id);
  HELD.set(id, s); // Map preserves insertion order — re-insert = "most recent".
}

function evictOverCapacity(): void {
  while (HELD.size > SESSION_MAX_HELD) {
    const oldestId = HELD.keys().next().value;
    if (oldestId === undefined) break;
    const oldest = HELD.get(oldestId);
    if (!oldest) break;
    HELD.delete(oldestId);
    void killHeld(oldest);
  }
}

function scheduleIdleEviction(session: HeldSession): void {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    HELD.delete(session.id);
    void killHeld(session);
  }, SESSION_IDLE_TIMEOUT_MS);
  if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function describeCloseLike(code: number | null, signal: NodeJS.Signals | null): string {
  return signal !== null ? `killed by signal ${signal}` : `exited with code ${String(code)}`;
}

/** Flags for a held session's spawn — the streaming counterpart of
 * index.ts's own `buildArgs` for the single-shot path. See this file's
 * header for why each stream-json flag is here, and index.ts's for why
 * `--tools ""` / `--strict-mcp-config` / `--no-session-persistence` /
 * `--safe-mode` are unconditional on every invocation regardless of
 * transport. */
function buildSessionArgs(
  systemPrompt: string,
  model: string | undefined,
  mcpConfigPath: string | undefined
): string[] {
  const args = [
    '-p',
    '--system-prompt',
    systemPrompt,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    // CONFIRMED necessary by a real invocation, not relayed from docs:
    // `-p --output-format stream-json` without this fails immediately
    // with "Error: When using --print, --output-format=stream-json
    // requires --verbose" (exit 1) before producing any stream-json line
    // at all — see this file's header and CHANGELOG.
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
  ];
  if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
  args.push('--no-session-persistence', '--safe-mode');
  if (model) args.push('--model', model);
  return args;
}

/** Parse and dispatch one stdout line from a held session's process.
 * Unrecognised event types (`system`/init, echoed `user` turns, partial
 * `stream_event`s, …) are observed and discarded — only `assistant`
 * (counted, as this transport's proxy for "an iteration happened") and
 * `result` (resolves the pending turn) matter to this adapter's
 * contract. A line that isn't valid JSON is warned about, not treated
 * as fatal on its own — the per-turn watchdog is what catches a genuine
 * hang. */
function handleStreamLine(session: HeldSession, line: string): void {
  let evt: ClaudeCliStreamResultEnvelope;
  try {
    evt = JSON.parse(line);
  } catch {
    console.warn(
      `claude-cli: held session ${session.id} emitted a stream-json line that was not valid ` +
        `JSON — ignoring it: ${line.slice(0, 200)}`
    );
    return;
  }
  if (!session.pending) return; // An event with no turn waiting on it — nothing to feed.
  if (evt.type === 'assistant') {
    session.pending.assistantEventCount += 1;
    return;
  }
  if (evt.type === 'result') {
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.watchdog);
    pending.resolve({ raw: evt, assistantEventCount: pending.assistantEventCount });
  }
}

function wireSessionEvents(session: HeldSession): void {
  session.child.stdout.on('data', (chunk: Buffer) => {
    session.lineBuffer += chunk.toString();
    let idx: number;
    while ((idx = session.lineBuffer.indexOf('\n')) >= 0) {
      const line = session.lineBuffer.slice(0, idx);
      session.lineBuffer = session.lineBuffer.slice(idx + 1);
      if (line.trim()) handleStreamLine(session, line);
    }
  });

  const onGone = (reason: string) => {
    session.closed = true;
    HELD.delete(session.id);
    clearTimeout(session.idleTimer);
    if (session.pending) {
      const pending = session.pending;
      session.pending = null;
      clearTimeout(pending.watchdog);
      pending.reject(
        new Error(
          `claude-cli: session ${session.id}'s process ${reason} mid-turn — the turn's result ` +
            'was never received.'
        )
      );
    }
    if (session.bridge) void session.bridge.close();
  };
  session.child.on('close', (code, signal) => onGone(describeCloseLike(code, signal)));
  session.child.on('error', (err) =>
    onGone(`could not run — ${err instanceof Error ? err.message : String(err)}`)
  );
}

interface SessionBinding {
  tools: ToolDef[];
  systemPrompt: string;
  model: string | undefined;
}

/** Get the live session behind `handle`, spawning one if none exists,
 * the existing one has died/been evicted, or the caller asked for an
 * incompatible binding — see this file's header for the dead-handle and
 * fixed-binding contracts this implements. */
async function getOrCreateSession(
  handle: ClaudeCliSessionHandle,
  binding: SessionBinding
): Promise<HeldSession> {
  const existing = HELD.get(handle.id);
  if (existing && !existing.closed) {
    const compatible =
      sameNames(
        existing.toolNames,
        binding.tools.map((t) => t.name)
      ) &&
      existing.systemPrompt === binding.systemPrompt &&
      existing.model === binding.model;
    if (compatible) {
      // Idle-timer management now lives entirely in runSessionTurn (clear
      // on turn start, reschedule once it settles) — rescheduling here
      // too would restart the countdown before the turn even begins,
      // which is harmless but redundant, so it's left to the one place
      // that actually knows the turn's start/end.
      touchLRU(handle.id);
      return existing;
    }
    throw new Error(
      `claude-cli: session ${handle.id} is already bound to a different systemPrompt/model/tool ` +
        "set — a held session's claude process is fixed at spawn. Close it (closeSession) and " +
        'open a new one to change any of those, rather than silently keeping the old binding or ' +
        'reconfiguring it mid-session.'
    );
  }
  if (existing) {
    // A dead/closed entry left in the map (the process exited between
    // turns, or was evicted) — clean it up before spawning fresh under
    // the same id. THIS is the "presenting a dead handle starts fresh"
    // contract: nothing here distinguishes "never seen this id" from
    // "it died" from "it was evicted".
    HELD.delete(handle.id);
    await killHeld(existing);
  }

  const bridge = binding.tools.length > 0 ? await createToolBridge(binding.tools) : null;
  const args = buildSessionArgs(binding.systemPrompt, binding.model, bridge?.mcpConfigPath);
  const child = spawn('claude', args, {
    env: allowedEnv(process.env),
    cwd: tmpdir(),
  }) as ChildProcessWithoutNullStreams;

  const session: HeldSession = {
    id: handle.id,
    child,
    bridge,
    toolNames: binding.tools.map((t) => t.name),
    systemPrompt: binding.systemPrompt,
    model: binding.model,
    idleTimer: setTimeout(() => {}, 0),
    closed: false,
    lineBuffer: '',
    pending: null,
  };
  clearTimeout(session.idleTimer);
  wireSessionEvents(session);
  HELD.set(handle.id, session);
  scheduleIdleEviction(session);
  evictOverCapacity();
  return session;
}

function abortReasonLocal(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason;
  if (signal.reason !== undefined) return new Error(String(signal.reason));
  return new DOMException('Aborted', 'AbortError');
}

function throwIfAbortedLocal(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortReasonLocal(signal);
}

/** Options for one turn on a held session — see `index.ts`'s `chat`
 * (session branch) / `chatWithToolLoop` for the two callers of this. */
export interface SessionTurnOptions {
  session: ClaudeCliSessionHandle;
  systemPrompt: string;
  /** The flattened text of this round's ONE new message — never the
   * full conversation history (the session already holds that). */
  message: string;
  tools: ToolDef[];
  /** Required when `tools` is non-empty. */
  executor?: ToolExecutor;
  maxToolCalls: number;
  model?: string;
  signal?: AbortSignal;
}

/** Result of one turn on a held session. */
export interface SessionTurnResult {
  text: string;
  stopReason: string;
  usage: ClaudeCliStreamResultEnvelope['usage'];
  modelUsage: ClaudeCliStreamResultEnvelope['modelUsage'];
  toolUses: ToolUse[];
  toolResults: BridgeToolResult[];
  /** Proxy for "how many model iterations happened" — see
   * `chatWithToolLoop`'s own doc comment in index.ts for why this is an
   * observed count of `assistant` stream events, not a count of
   * separate calls this function made (it made exactly one). */
  assistantEventCount: number;
}

/**
 * Run one turn on a held session — spawning or reusing the process
 * behind `options.session`, arming the tool bridge (if `options.tools`
 * is non-empty) for the caller's executor, writing the turn, and
 * resolving once a terminal `result` event arrives (or the per-turn
 * watchdog / an abort fires first).
 */
export async function runSessionTurn(options: SessionTurnOptions): Promise<SessionTurnResult> {
  throwIfAbortedLocal(options.signal);
  if (options.tools.length > 0 && !options.executor) {
    throw new Error('claude-cli: runSessionTurn requires an executor when tools are supplied');
  }

  const session = await getOrCreateSession(options.session, {
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    model: options.model,
  });

  if (session.pending) {
    throw new Error(
      `claude-cli: session ${options.session.id} already has a turn in flight — a held session ` +
        'serves one turn at a time; await the previous call before starting another on the same handle.'
    );
  }

  // A session actively serving a turn is not idle, however long that
  // turn takes — cancel the idle countdown for its duration so it can
  // never compete with SESSION_TURN_TIMEOUT_MS (below) for the same
  // turn. Resumed in the `finally` once the turn settles, one way or
  // another. See the file header's MEASURES-IDLE-TIME paragraph.
  clearTimeout(session.idleTimer);

  let armed: ArmedTurnState | null = null;
  if (session.bridge && options.executor) {
    armed = session.bridge.arm(options.executor, options.maxToolCalls);
  }

  let envelope: { raw: ClaudeCliStreamResultEnvelope; assistantEventCount: number };
  try {
    envelope = await new Promise<{
      raw: ClaudeCliStreamResultEnvelope;
      assistantEventCount: number;
    }>((resolve, reject) => {
      const watchdog = setTimeout(() => {
        session.pending = null;
        void killHeld(session);
        HELD.delete(session.id);
        reject(
          new Error(
            `claude-cli: session ${session.id} timed out after ${SESSION_TURN_TIMEOUT_MS}ms waiting ` +
              'for a terminal stream-json "result" event. The streaming wire shape this adapter ' +
              'assumes is relayed from documentation, not confirmed against a real invocation (see ' +
              "session.ts's own file header) — this may mean the assumption doesn't hold. Refusing " +
              'rather than hanging; the held process has been killed.'
          )
        );
      }, SESSION_TURN_TIMEOUT_MS);
      if (typeof watchdog.unref === 'function') watchdog.unref();

      const onAbort = () => {
        clearTimeout(watchdog);
        session.pending = null;
        void killHeld(session);
        HELD.delete(session.id);
        reject(abortReasonLocal(options.signal!));
      };
      // getOrCreateSession, above, crosses an async boundary (an await,
      // even one that resolves in a single microtask tick) — a signal
      // aborted DURING that gap fires its 'abort' event before this
      // listener exists to hear it, and once fired that event never
      // fires again. Re-checking `.aborted` here, synchronously, before
      // subscribing is what catches that window; the entry-only
      // throwIfAbortedLocal call above only catches an abort that had
      // already happened before runSessionTurn was even called.
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      session.pending = { resolve, reject, assistantEventCount: 0, watchdog };

      const line =
        JSON.stringify({ type: 'user', message: { role: 'user', content: options.message } }) +
        '\n';
      try {
        session.child.stdin.write(line);
      } catch (err) {
        clearTimeout(watchdog);
        session.pending = null;
        options.signal?.removeEventListener('abort', onAbort);
        reject(
          new Error(
            `claude-cli: could not write to held session ${session.id}'s stdin — ` +
              `${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    });
  } finally {
    // The turn has settled, one way or another. Resume the idle
    // countdown from now — but only if the session is still the one
    // registered under this id: the watchdog / abort / process-death
    // paths inside the promise above already killed it and deleted it
    // from HELD, and rescheduling a timer nothing will ever look up
    // again would just leak it.
    if (HELD.get(session.id) === session && !session.closed) {
      scheduleIdleEviction(session);
    }
  }

  const parsed = envelope.raw;
  if (parsed.is_error) {
    throw new Error(
      `claude-cli: session ${session.id} reported is_error: true (subtype=${parsed.subtype ?? 'unknown'})` +
        (parsed.result ? ` — ${parsed.result}` : '')
    );
  }

  return {
    text: typeof parsed.result === 'string' ? parsed.result : '',
    stopReason: parsed.stop_reason ?? 'end_turn',
    usage: parsed.usage,
    modelUsage: parsed.modelUsage,
    toolUses: armed ? armed.toolUses : [],
    toolResults: armed ? armed.toolResults : [],
    assistantEventCount: envelope.assistantEventCount,
  };
}
