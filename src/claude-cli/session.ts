/**
 * @verevoir/llm/claude-cli — held sessions: lifecycle (wave 2a of 5).
 *
 * This is HALF of what was originally proposed as one file in the
 * withdrawn #57 (itself wave 2/4 of the split replacing the withdrawn
 * omnibus #55). #57 was REJECTED by review on
 * `pull-requests-carry-what-why-tests` — 1,799 changed lines, and the
 * file's own header, plus its own test file's `describe` blocks,
 * already showed an unexercised seam: lifecycle (this file) vs. turn
 * execution (`runSessionTurn`, its watchdog, its abort handling, tool
 * arming — landing on top of this as wave 2b). See CHANGELOG's 0.26.8
 * entry for the full account.
 *
 * See index.ts's file header (SESSION-HOLDING TRANSPORT section,
 * landing in wave 3 of this overall split) for the why; this header
 * covers the how. This file has no caller yet (nothing on `main`
 * imports it) — the same leaf-first pattern the embedded MCP bridge
 * landed in at 0.26.6 — its own test file exercises it directly by
 * calling `getOrCreateSession` (exported for exactly this reason; see
 * its own doc comment below).
 *
 * ONE PROCESS PER HANDLE, KEPT ALIVE ACROSS TURNS. `claude -p
 * --input-format stream-json --output-format stream-json` is spawned
 * once per session and left running, rather than the single-shot
 * path's spawn-per-call. `--disallowedTools "*"` / `--strict-mcp-config`
 * / `--no-session-persistence` / `--safe-mode` stay on exactly as the
 * single-shot path uses them (see index.ts's own file header for why
 * each is there, and its SECURITY CORRECTION paragraph for why this is
 * `--disallowedTools "*"` and not the old `--tools ""`); `--mcp-config`
 * names this session's own bridge (`mcp-bridge.ts`) when the session has
 * tools, and is omitted entirely for a tool-free session (plain `chat()`
 * with `session` set, held only for prompt-cache warmth).
 *
 * THE SYSTEM PROMPT, MODEL, AND TOOL SET ARE FIXED AT SPAWN. `-p`'s
 * `--system-prompt` and `--model` are startup flags, not something a
 * stream-json turn can change mid-process, and the MCP bridge's tool
 * declarations are baked into its shim script at generation time. A
 * later call reusing the same handle with a DIFFERENT systemPrompt,
 * model, or tool set is refused with a specific error naming the
 * mismatch (`requireCompatible`, below), rather than either silently
 * keeping the old binding or silently reconfiguring it — the same
 * "declares it rather than pretending" standard this whole adapter
 * holds itself to. Close the session and open a new one to change any
 * of those.
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
 * index.ts, wave 3):
 *   - {@link SESSION_IDLE_TIMEOUT_MS}: a session with no turn IN FLIGHT
 *     and none started for this long is killed and evicted. (The
 *     "no turn in flight" half of this is a wave-2b concept — see that
 *     wave's own header addition — but the eviction MECHANISM itself
 *     lives entirely here.)
 *   - {@link SESSION_MAX_HELD}: the process-wide cap on LIVE sessions.
 *     Creating one past the cap evicts the least-recently-used first
 *     (touch order is turn order, not creation order).
 *
 * THE TTL IS A RESOURCE POLICY, NOT A CORRECTNESS MECHANISM — and this is
 * only true because of a property that holds everywhere else in this
 * package too: the session is a CACHE over a stateless truth. The
 * caller's own `turns` remain the ground truth (see index.ts's, wave 3,
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
 * ══════════════════════════════════════════════════════════════════
 * SECURITY CORRECTION — `--tools ""` NEVER DISABLED BUILT-IN TOOLS.
 * ══════════════════════════════════════════════════════════════════
 * Confirmed directly against the CLI: `--tools` is a space-separated
 * ALLOWLIST, and an empty string reads as NOT SET, not as an empty
 * list — every session this file spawned fell through to the CLI's own
 * default built-in tool set the entire time. See index.ts's own SECURITY
 * CORRECTION paragraph for the full account (it applies here identically).
 *
 * THE FIX HERE IS NOT "ZERO TOOLS", UNLIKE THE SINGLE-SHOT PATH — the
 * operator's own framing: "it is unlikely there will ever be no tools
 * for a conversation". The requirement on THIS path is the caller's own
 * tools and NOTHING ELSE: built-ins denied, the MCP-declared ones (via
 * the embedded bridge) reachable. `buildSessionArgs` (below) passes
 * `--disallowedTools "*"` — and THIS RELIES, DELIBERATELY, ON A
 * CONFIRMED CLI BUG: the operator confirmed `--disallowedTools` has "a
 * known issue not filtering MCP server tools". For a session with NO
 * tools (bridge is `null`, no `--mcp-config` passed) that bug is
 * irrelevant — there is no MCP tool for it to fail to filter. For a
 * session WITH tools, that bug is exactly the mechanism this adapter
 * depends on: the deny-by-name rule reaches every built-in but never
 * reaches the caller's own MCP-declared tools. AN UPSTREAM FIX TO THAT
 * CLI BUG WOULD BREAK THIS ADAPTER'S TOOL-BEARING SESSIONS SILENTLY —
 * this dependency is recorded here, at the flag-building site, and in
 * CHANGELOG.md, precisely so that a future CLI upgrade regressing this
 * doesn't read as unrelated.
 *
 * GETTING A FLAG RIGHT ONCE IS NOT THE FIX — index.ts's `chat()` (wave 3)
 * verifies `--disallowedTools "*"` against the CLI's own `init` event
 * `tools` array on every call (see its own file header's TOOL-SAFETY
 * VERIFICATION paragraph) rather than trusting the flag by construction,
 * which is exactly the standard that would have caught the original
 * `--tools ""` defect on day one. THIS FILE DOES NOT YET DO THE SAME —
 * stated plainly, not left for a reader to discover by its silence; see
 * wave 2b's own header addition for the current state of that gap.
 *
 * Wire-shape verification history (three real operator-run probes
 * confirming multi-turn-on-one-process, `--disallowedTools "*"`
 * genuinely removing built-ins, and the terminal envelope's shape) is
 * recorded in full in wave 2b's header addition, next to
 * `runSessionTurn` and `ClaudeCliStreamResultEnvelope` — the pieces that
 * actually consume that confirmation. Nothing in THIS file depends on
 * the streaming wire shape being right; it only spawns and tracks
 * processes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ToolDef } from '../index.js';
import { allowedEnv } from './env.js';
import { createToolBridge, type ToolBridge } from './mcp-bridge.js';

/** An opaque handle to a held `claude` session — see index.ts's file
 * header (wave 3) for the full contract. Carries nothing but an id:
 * every fact about the session it names lives in this module's own
 * internal map, never on the handle itself, so a handle is safe to
 * serialise, log, or hold past the session's own life without leaking
 * anything. */
export interface ClaudeCliSessionHandle {
  readonly id: string;
}

/** How long a session with NO TURN IN FLIGHT is kept alive before being
 * killed and evicted — the gap between turns, never a turn's own
 * length. Cancelled while a turn is pending; rescheduled once it
 * settles (both of those are wave 2b's `runSessionTurn`, since "a turn
 * is in flight" is a concept only it can observe). A resource policy,
 * freely tunable — getting it wrong costs a token-spending cold
 * rebuild, never correctness, because the caller's own turns remain the
 * ground truth. */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** The process-wide cap on LIVE held sessions. Creating one past the cap
 * evicts the least-recently-used first. */
export const SESSION_MAX_HELD = 4;

/** One turn's pending state, shared with wave 2b's `runSessionTurn`
 * (which is the only thing that ever CREATES one — see that wave's
 * header) but read here too: `killHeld` must reject an in-flight turn
 * rather than leaving its promise to hang forever if the session dies
 * or is evicted mid-turn, and `handleStreamLine` (below) is what
 * resolves one when a terminal `result` event arrives. */
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

/** The stream-json turn's terminal `{"type":"result",...}` line — see
 * wave 2b's header addition for the real-invocation confirmation this
 * shape rests on. Declared here (not in wave 2b) because `PendingTurn`,
 * above, needs it for `resolve`'s parameter type, and `handleStreamLine`
 * (below) is what actually parses a raw line into one. */
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
  /** See wave 2b's `PermissionDenial` doc comment — present on every
   * real envelope this repo has captured so far, always empty; its
   * shape when POPULATED is unconfirmed. Declared here only as a field
   * on the envelope; extraction into a typed `PermissionDenial[]` is
   * wave 2b's own concern, since only `runSessionTurn` reads it. */
  permission_denials?: unknown[];
}

const HELD = new Map<string, HeldSession>();

/** Sessions currently being spawned — one promise per handle id, held
 * synchronously from the moment a fresh (or dead/evicted) handle is
 * first claimed until spawn + bridge setup finishes, one way or the
 * other.
 *
 * FIXES A REAL DEFECT A REVIEW CAUGHT, not a hypothetical one. Without
 * this, the async work spawning a session does — killing a dead
 * predecessor, `createToolBridge`'s own mkdtemp/writeFile/TCP-listen —
 * ran between "is anything held under this id" and `HELD.set` landing.
 * Two `getOrCreateSession` calls issued back-to-back on the SAME fresh
 * (or dead/evicted) handle both read `HELD` as empty, both spawned a
 * full `claude` process + tool bridge, and the second `HELD.set`
 * silently overwrote the first — orphaning its process, its bridge's
 * listening socket, and its temp directory, none of which any cleanup
 * path (`closeSession`, idle eviction, LRU eviction) could ever reach
 * again.
 *
 * Reserving the slot HERE, synchronously — before ANY `await` in
 * `getOrCreateSession`, including the dead-session cleanup path, not
 * just bridge creation — closes the window: a second call on the same
 * handle sees the reservation and awaits the SAME spawn rather than
 * starting its own. See `requireCompatible` for what it gets back. */
const INITIALIZING = new Map<string, Promise<HeldSession>>();

/** A fresh, opaque session handle. Spawns nothing yet — the first
 * `getOrCreateSession` call against it (via wave 2b's
 * `runSessionTurn`) is what actually starts `claude`, so creating a
 * handle you never use costs nothing. */
export function createSession(): ClaudeCliSessionHandle {
  return { id: randomUUID() };
}

/** Release a held session explicitly: kill its process (if live), tear
 * down its bridge, and stop its idle timer. Idempotent — closing an
 * unknown or already-closed handle is a no-op, the same dead-handle
 * safety `getOrCreateSession` gives a fresh call. */
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

/** Exported so wave 2b's `runSessionTurn` can call it once a turn
 * settles — idle eviction is scheduled here (at spawn) and rescheduled
 * there (after each turn), but the scheduling mechanism itself belongs
 * with the rest of this file's bounds machinery. */
export function scheduleIdleEviction(session: HeldSession): void {
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
 * `--strict-mcp-config` / `--no-session-persistence` / `--safe-mode` are
 * unconditional on every invocation regardless of transport. */
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
    // at all — see wave 2b's header for the invocation history.
    '--verbose',
    // CONFIRMED (three real invocations — see wave 2b's header) to
    // remove every built-in tool from context entirely. Relies,
    // deliberately, on a confirmed CLI bug — see this file's SECURITY
    // CORRECTION section for why that dependency is safe to state, not
    // hide.
    '--disallowedTools',
    '*',
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
 * as fatal on its own — wave 2b's per-turn watchdog is what catches a
 * genuine hang. */
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

/** Shared compatibility check used by every path that hands back an
 * existing OR just-finished-initializing session — see the file
 * header's THE SYSTEM PROMPT, MODEL, AND TOOL SET ARE FIXED AT SPAWN
 * paragraph. Extracted so a call that arrives while another is still
 * spawning (see `INITIALIZING` above) enforces the identical rule a
 * synchronous existing-session hit does, rather than silently handing
 * back a session bound to whichever caller's binding won the race. */
function requireCompatible(session: HeldSession, id: string, binding: SessionBinding): HeldSession {
  const compatible =
    sameNames(
      session.toolNames,
      binding.tools.map((t) => t.name)
    ) &&
    session.systemPrompt === binding.systemPrompt &&
    session.model === binding.model;
  if (!compatible) {
    throw new Error(
      `claude-cli: session ${id} is already bound to a different systemPrompt/model/tool ` +
        "set — a held session's claude process is fixed at spawn. Close it (closeSession) and " +
        'open a new one to change any of those, rather than silently keeping the old binding or ' +
        'reconfiguring it mid-session.'
    );
  }
  return session;
}

/** Get the live session behind `handle`, spawning one if none exists,
 * the existing one has died/been evicted, or the caller asked for an
 * incompatible binding — see this file's header for the dead-handle and
 * fixed-binding contracts this implements, and `INITIALIZING`'s own doc
 * comment for the concurrent-first-use race this function closes.
 *
 * EXPORTED — not merely internal — specifically so this PR's own test
 * file can exercise spawn/reuse/dead-handle/eviction directly, since
 * this file has no other caller yet (wave 2b's `runSessionTurn`, the
 * eventual production caller, is the next PR in this split). The same
 * "confirmed leaf, tested standalone" pattern the embedded MCP bridge
 * (0.26.6) shipped in. */
export async function getOrCreateSession(
  handle: ClaudeCliSessionHandle,
  binding: SessionBinding
): Promise<HeldSession> {
  // A concurrent call already claimed this handle and is still
  // spawning — wait for THAT spawn rather than racing a second one.
  // Checked first: this map is exactly where the reservation lives for
  // the whole window between claiming the slot and HELD.set landing.
  const inFlight = INITIALIZING.get(handle.id);
  if (inFlight) {
    return requireCompatible(await inFlight, handle.id, binding);
  }

  const existing = HELD.get(handle.id);
  if (existing && !existing.closed) {
    const session = requireCompatible(existing, handle.id, binding);
    // Idle-timer management lives entirely in wave 2b's runSessionTurn
    // (clear on turn start, reschedule once it settles) — rescheduling
    // here too would restart the countdown before the turn even begins,
    // which is harmless but redundant, so it's left to the one place
    // that actually knows the turn's start/end.
    touchLRU(handle.id);
    return session;
  }

  // Either nothing is held under this id, or what's held is dead/closed
  // (existing.closed === true — the only way execution reaches here
  // past the branch above) and needs cleaning up before a fresh spawn.
  // Reserve the slot SYNCHRONOUSLY, before ANY await below — including
  // the dead-session cleanup, not just createToolBridge — so a
  // concurrent call arriving anywhere in this window sees the
  // reservation instead of racing a second spawn past it.
  const initPromise = (async (): Promise<HeldSession> => {
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
  })();
  INITIALIZING.set(handle.id, initPromise);
  try {
    return await initPromise;
  } finally {
    INITIALIZING.delete(handle.id);
  }
}
