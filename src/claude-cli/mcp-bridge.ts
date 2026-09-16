/**
 * @verevoir/llm/claude-cli — the embedded MCP tool bridge.
 *
 * `--disallowedTools "*"` (kept, per this adapter's own constraint — see
 * index.ts's file header) removes every BUILT-IN Claude Code tool from
 * context entirely. It says nothing about a tool exposed through an
 * explicit `--mcp-config` entry — those are a different mechanism, and
 * `--strict-mcp-config` (also always passed alongside it) is what
 * already limits the *set* of MCP servers a call can reach to exactly
 * the one named here, never anything from the caller's own
 * machine-wide or project configuration.
 *
 * This module generates, per held session, a tiny stdio MCP SERVER — a
 * throwaway Node script written to a temp file — that `claude` itself
 * spawns as a subprocess once `--mcp-config` names it. That script
 * speaks MCP's own published stdio wire format on its stdin/stdout side
 * (not this adapter's invention) and forwards every `tools/call` it
 * receives over a loopback TCP hop back into THIS process, where the
 * caller's own `ToolExecutor` actually runs. `tools/list` and
 * `initialize` are answered locally by the shim from the tool
 * declarations baked into it at generation time — no round trip needed
 * for those.
 *
 * WHY A SEPARATE PROCESS AT ALL, RATHER THAN AN IN-PROCESS MCP SERVER.
 * `claude` only speaks MCP over a transport it spawns or connects to
 * itself (stdio, or a remote URL) — there is no "hand it a function"
 * form. A subprocess `claude` spawns is the only shape it accepts, so
 * the shim exists to BE that subprocess while staying as thin as
 * possible: every real decision (which tools exist, what a call does)
 * stays in this process, reached over the loopback TCP hop below.
 *
 * WHY TCP, NOT A UNIX DOMAIN SOCKET. A Unix socket would be one file
 * fewer, but Windows doesn't have them in the same shape and this
 * package doesn't get to assume a platform — `claude` itself runs there
 * too. Loopback TCP (`127.0.0.1`, an OS-assigned ephemeral port) is
 * available everywhere.
 *
 * THE SHIM↔BRIDGE WIRE FORMAT (the loopback TCP hop) IS THIS PACKAGE'S
 * OWN — a trivial newline-delimited `{id, name, arguments}` request /
 * `{id, result}` response, invented here because nothing outside this
 * process ever needs to agree with it. Only the shim's STDIO side
 * (talking to `claude`) has to match a spec neither side of this
 * repository controls.
 *
 * CONFIRMED, NOT RELAYED — THE BUILT-IN-TOOL HALF: `--disallowedTools
 * "*"` genuinely removes every built-in tool from a session using this
 * bridge, confirmed by three real, operator-run invocations — see
 * `session.ts`'s own file header for the full account, including a run
 * where the model was explicitly asked to invoke Bash and could not.
 *
 * STILL OPEN — THE MCP HALF: whether an MCP-declared tool exposed by
 * this bridge stays callable once `--disallowedTools "*"`/`--mcp-config`
 * are both in play has NOT been observed on a real invocation that got
 * far enough to test it — every probe run so far shows `mcp_servers`
 * empty before a connection is even attempted, with `--safe-mode` the
 * leading, unconfirmed hypothesis for why. See `session.ts`'s own file
 * header for the full probe history and the isolating probe this points
 * to next.
 *
 * WHAT DEPENDS ON THIS MODULE, AND WHAT DOES NOT — read this before
 * assuming a broader change: this module's only imports are Node
 * built-ins plus a TYPE-ONLY import of `ToolDef`/`ToolExecutor`/`ToolUse`
 * from this package's own top-level `index.ts` (types that already
 * exist wherever this file lands). It imports nothing from
 * `claude-cli/session.ts`, and nothing in `claude-cli/index.ts`'s public
 * surface changes by this file's mere presence. `session.ts` is what
 * imports `createToolBridge` and owns spawning the `claude` process this
 * bridge's `--mcp-config` is handed to — the dependency runs ONE way.
 * So this module can be reviewed, tested, and even merged with no
 * caller yet: nothing on `main` invokes `createToolBridge` until
 * `session.ts` lands on top of it in a later change. That is a
 * deliberate ordering — the security-critical piece settles first, on
 * its own, rather than being reviewed only as a detail buried inside a
 * much larger caller.
 *
 * AUTHENTICATION — THE LOOPBACK PORT REQUIRES A SHARED SECRET; IT IS NOT
 * TRUST-BY-BINDING. Binding to 127.0.0.1 keeps the port unreachable over
 * the network, but loopback TCP is not filesystem-permissioned: ANY
 * process already running on the same machine can open a connection to
 * it, regardless of which user started it. Without a check, that
 * connection could drive the caller's own `ToolExecutor` directly — this
 * was confirmed reachable from an ordinary, unrelated socket via this
 * file's own `mcp-bridge.test.ts` (its `sendToolCall` helper, which never
 * goes through the generated shim at all) before this fix existed: the
 * 'forwards an armed tools/call...' test already drove the executor that
 * way, and passed, with zero authentication.
 *
 * THE FIX: `createToolBridge` generates a random 32-byte token once per
 * bridge and writes it into the generated `--mcp-config`'s own `env`
 * field for the shim's spawn — a channel that never touches the port,
 * set at the moment `claude` spawns the shim rather than read from a
 * file an unrelated process could also read. The shim includes it on
 * every forwarded `tools/call`; `handleRequest` checks it FIRST, before
 * anything else (including whether a turn is even armed), with a
 * constant-time comparison (`tokensMatch`), so an unauthenticated caller
 * learns nothing about internal state either. A mismatch REFUSES rather
 * than drops: logged via `console.warn`, and answered on the socket with
 * an explicit `{ refused: true, reason }` rather than silence — so a
 * caller (or a test) can tell a refusal from a message that was simply
 * never sent, the same distinction this package's `refused`/`unreachable`
 * vocabulary draws everywhere else.
 *
 * THE LOOPBACK BINDING IS DEFENSE IN DEPTH ON TOP OF THIS, NOT THE
 * CONTROL ITSELF — stated plainly rather than implied otherwise: it
 * rules out network reachability entirely, but does not by itself rule
 * out another local process attempting a connection. The token is what
 * actually stops one.
 *
 * RELAYED, NOT CONFIRMED: whether `claude`'s own spawn of an
 * `--mcp-config`-declared server genuinely honours that entry's `env`
 * field is asserted from the MCP server config format's own
 * widely-documented shape (the same one `command`/`args` already rest
 * on), not independently confirmed against a real invocation — the same
 * category of gap as the rest of this file's still-open MCP question.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDef, ToolExecutor, ToolUse } from '../index.js';

/** One recorded tool result — matches {@link ChatWithToolLoopResult.toolResults}'s
 * per-entry shape so `session.ts` can hand these straight through. */
export interface BridgeToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * Per-turn accounting the bridge accumulates while "armed" for one call.
 * `arm()` returns this SAME object; the caller reads `toolUses` /
 * `toolResults` back off it once the turn settles — they mutate in
 * place as `tools/call` requests arrive, rather than being collected
 * separately and reconciled afterwards.
 */
export interface ArmedTurnState {
  readonly executor: ToolExecutor;
  readonly maxToolCalls: number;
  readonly toolUses: ToolUse[];
  readonly toolResults: BridgeToolResult[];
}

/**
 * A long-lived MCP tool bridge, bound to one held session's `claude`
 * process for its whole life — see `session.ts`, which owns spawning
 * the process this bridge's `--mcp-config` is handed to, and tearing the
 * bridge down (`close()`) when that process goes away.
 */
export interface ToolBridge {
  /** Absolute path of the generated `--mcp-config` JSON. */
  readonly mcpConfigPath: string;
  /** The tool NAMES this bridge's shim was generated with — `session.ts`
   * compares this against a later call's tools to detect an incompatible
   * reuse of the same held session (see its own doc comment for why that
   * refuses rather than silently reconfiguring mid-session). */
  readonly toolNames: readonly string[];
  /**
   * Arm the bridge for one turn: which executor answers a `tools/call`,
   * and how many calls it will forward before refusing further ones with
   * a "no more tools, answer now" result — this transport's analogue of
   * the API adapters' iteration cap (see `chatWithToolLoop`'s own doc
   * comment in index.ts). Only one turn should be in flight on a given
   * session at a time (`session.ts` enforces this), so a single mutable
   * "current turn" slot is safe rather than needing per-call routing.
   */
  arm(executor: ToolExecutor, maxToolCalls: number): ArmedTurnState;
  /** Tear the bridge down: close the TCP server and remove its temp
   * directory. Idempotent. */
  close(): Promise<void>;
}

function toolsToMcpDeclarations(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
}

/** Constant-time comparison of a caller-supplied token against the
 * bridge's own — a plain `===` would leak timing information about how
 * many leading bytes matched. Anything other than a same-length string
 * is an immediate mismatch, checked before ever reaching
 * `timingSafeEqual` (which throws on unequal-length buffers, so a bare
 * length check first is required, not optional hardening). */
function tokensMatch(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * The shim script's source, as a template — `toolsJson` / `port` are
 * substituted via `JSON.stringify`/template interpolation of a NUMBER,
 * never raw caller-controlled text, so there is no injection surface
 * into the generated script. A single self-contained CommonJS file with
 * no dependency on this package's own build output, since `claude`
 * spawns it standalone with `node`, outside this repository's own
 * module resolution.
 */
function buildShimScript(tools: ToolDef[], port: number): string {
  const toolsJson = JSON.stringify(toolsToMcpDeclarations(tools));
  return `'use strict';
const net = require('net');
const TOOLS = ${toolsJson};
const PORT = ${port};
// Read from this process's own environment — set by claude at spawn time
// from the --mcp-config entry's "env" field (see index.ts's AUTHENTICATION
// paragraph). Never baked into this script's source: unlike PORT/TOOLS,
// which are fixed for the bridge's whole life and safe to embed, the
// token flows through the one channel that doesn't also touch the port
// this fix exists to protect.
const TOKEN = process.env.LLM_BRIDGE_TOKEN || '';
let buf = '';
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, message) { send({ jsonrpc: '2.0', id, error: { code: -32000, message } }); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'llm-claude-cli-bridge', version: '0.0.0' } });
    } else if (msg.method === 'notifications/initialized') {
      // notification — no response expected
    } else if (msg.method === 'tools/list') {
      reply(msg.id, { tools: TOOLS });
    } else if (msg.method === 'tools/call') {
      const client = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
        client.write(JSON.stringify({ id: String(msg.id), name: msg.params.name, arguments: msg.params.arguments || {}, token: TOKEN }) + '\\n');
      });
      let respBuf = '';
      client.on('data', (d) => {
        respBuf += d.toString();
        const nl = respBuf.indexOf('\\n');
        if (nl >= 0) {
          const respLine = respBuf.slice(0, nl);
          try {
            reply(msg.id, JSON.parse(respLine).result);
          } catch (e) {
            replyError(msg.id, 'bridge response parse error: ' + String(e));
          }
          client.end();
        }
      });
      client.on('error', (err) => {
        replyError(msg.id, 'bridge connection error: ' + String(err && err.message));
      });
    } else if (msg.id !== undefined) {
      replyError(msg.id, 'unsupported method: ' + msg.method);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
}

/**
 * Generate and write the shim script + `--mcp-config` JSON into a fresh
 * temp directory, and start the loopback TCP server the shim's
 * `tools/call` forwarding connects back to. The returned bridge stays
 * live for as long as the session's `claude` process does — `session.ts`
 * owns tearing it down via `close()` when that process exits.
 */
export async function createToolBridge(tools: ToolDef[]): Promise<ToolBridge> {
  // A random, per-bridge shared secret — see this file's header
  // AUTHENTICATION paragraph. Generated fresh for every bridge, never
  // reused across sessions or persisted anywhere beyond this call's
  // closure and the generated --mcp-config's own env field.
  const token = randomBytes(32).toString('hex');
  let current: ArmedTurnState | null = null;

  async function handleRequest(line: string, socket: Socket): Promise<void> {
    let parsed: { id: string; name: string; arguments: Record<string, unknown>; token?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Malformed request — nothing legible to reply to, from the shim or otherwise.
    }

    if (!tokensMatch(token, parsed.token)) {
      // Checked FIRST, before anything else in this function — an
      // unauthenticated caller learns nothing about whether a turn is
      // even armed. REFUSED, not dropped: see this file's header
      // AUTHENTICATION paragraph for why silence is the wrong shape here.
      console.warn(
        'claude-cli mcp-bridge: refused an unauthenticated tools/call attempt from ' +
          `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 'unknown'} — ` +
          'invalid or missing token'
      );
      socket.write(
        JSON.stringify({ id: parsed.id, refused: true, reason: 'invalid or missing token' }) + '\n'
      );
      socket.end();
      return;
    }

    const respond = (result: { content: { type: 'text'; text: string }[]; isError: boolean }) => {
      socket.write(JSON.stringify({ id: parsed.id, result }) + '\n');
    };

    if (!current) {
      respond({
        content: [{ type: 'text', text: 'no tool call is expected right now' }],
        isError: true,
      });
      return;
    }

    const toolUse: ToolUse = { id: parsed.id, name: parsed.name, input: parsed.arguments ?? {} };

    if (current.toolUses.length >= current.maxToolCalls) {
      const content =
        'tool-call budget exhausted for this turn — answer now without further tool calls';
      current.toolUses.push(toolUse);
      current.toolResults.push({ toolUseId: toolUse.id, content, isError: true });
      respond({ content: [{ type: 'text', text: content }], isError: true });
      return;
    }

    current.toolUses.push(toolUse);
    let content: string;
    let isError = false;
    try {
      content = await current.executor(toolUse);
    } catch (err) {
      content = err instanceof Error ? err.message : String(err);
      isError = true;
    }
    current.toolResults.push({ toolUseId: toolUse.id, content, isError });
    respond({ content: [{ type: 'text', text: content }], isError });
  }

  const server: Server = createServer((socket: Socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) void handleRequest(line, socket);
      }
    });
    socket.on('error', () => {
      // A shim connection dropping mid-call surfaces to `claude` as the
      // shim's own MCP-side error reply (it has its own 'error' handler
      // on the client socket) — nothing to do here beyond not crashing
      // the bridge server itself.
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(addr.port);
      else reject(new Error('claude-cli: tool bridge server did not bind a TCP port'));
    });
  });

  const dir = await mkdtemp(join(tmpdir(), 'llm-claude-cli-bridge-'));
  const scriptPath = join(dir, 'shim.cjs');
  const mcpConfigPath = join(dir, 'mcp-config.json');
  await writeFile(scriptPath, buildShimScript(tools, port), 'utf8');
  await writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        'llm-tools': {
          command: process.execPath,
          args: [scriptPath],
          // See this file's header AUTHENTICATION paragraph — the channel
          // the shared secret travels over, distinct from the port and
          // from the script file itself.
          env: { LLM_BRIDGE_TOKEN: token },
        },
      },
    }),
    'utf8'
  );

  return {
    mcpConfigPath,
    toolNames: tools.map((t) => t.name),
    arm(executor, maxToolCalls) {
      current = { executor, maxToolCalls, toolUses: [], toolResults: [] };
      return current;
    },
    async close() {
      current = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup — a failed temp-dir removal isn't worth
        // surfacing to a caller tearing down a session.
      });
    },
  };
}
