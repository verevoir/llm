/**
 * @verevoir/llm/claude-cli — the embedded MCP tool bridge.
 *
 * `--tools ""` (kept, per this adapter's own constraint — see index.ts's
 * file header) disables every BUILT-IN Claude Code tool. It says nothing
 * about a tool exposed through an explicit `--mcp-config` entry — those
 * are a different mechanism, and `--strict-mcp-config` (also always
 * passed alongside it) is what already limits the *set* of MCP servers a
 * call can reach to exactly the one named here, never anything from the
 * caller's own machine-wide or project configuration.
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
 * RELAYED, NOT CONFIRMED: whether `claude -p --tools "" --mcp-config …`
 * genuinely leaves an MCP-declared tool callable while every built-in
 * tool stays off is asserted here from MCP's own published stdio
 * transport spec and Claude Code's documented `--mcp-config` flag — this
 * repository has not independently observed it against a real
 * invocation. See `session.ts`'s own file header for the precise
 * verification this rests on being asked for.
 */

import { createServer, type Server, type Socket } from 'node:net';
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
        client.write(JSON.stringify({ id: String(msg.id), name: msg.params.name, arguments: msg.params.arguments || {} }) + '\\n');
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
  let current: ArmedTurnState | null = null;

  async function handleRequest(line: string, socket: Socket): Promise<void> {
    let parsed: { id: string; name: string; arguments: Record<string, unknown> };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // Malformed request from the shim — nothing legible to reply to.
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
      mcpServers: { 'llm-tools': { command: process.execPath, args: [scriptPath] } },
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
