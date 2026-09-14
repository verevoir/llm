import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolBridge, type ToolBridge } from './mcp-bridge.js';
import type { ToolDef, ToolUse } from '../index.js';

const ECHO_TOOL: ToolDef = {
  name: 'echo',
  description: 'Echoes back the given text',
  input_schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
};

/** The bridge's own port is not on its public `ToolBridge` shape (only
 * `session.ts` — via the shim it spawns — ever needs it); tests recover
 * it the same way a real shim would, by reading the generated script it
 * wrote and pulling `PORT` back out. */
async function bridgePort(bridge: ToolBridge): Promise<number> {
  const configRaw = await readFile(bridge.mcpConfigPath, 'utf8');
  const config = JSON.parse(configRaw) as {
    mcpServers: Record<string, { args: string[] }>;
  };
  const scriptPath = config.mcpServers['llm-tools'].args[0];
  const script = await readFile(scriptPath, 'utf8');
  const match = script.match(/const PORT = (\d+);/);
  if (!match) throw new Error('test setup: could not recover PORT from the generated shim');
  return Number(match[1]);
}

/** Sends one newline-delimited `{id, name, arguments}` request over a
 * fresh socket to the bridge's port — exactly what the generated shim
 * does on a `tools/call` — and returns the parsed `{id, result}` line
 * back. */
function sendToolCall(
  port: number,
  request: { id: string; name: string; arguments: Record<string, unknown> }
): Promise<{ id: string; result: { content: { type: string; text: string }[]; isError: boolean } }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.write(JSON.stringify(request) + '\n');
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (err) {
          reject(err);
        }
        socket.end();
      }
    });
    socket.on('error', reject);
  });
}

describe('claude-cli mcp-bridge', () => {
  const bridges: ToolBridge[] = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((b) => b.close()));
  });

  async function bridgeFor(tools: ToolDef[]): Promise<ToolBridge> {
    const bridge = await createToolBridge(tools);
    bridges.push(bridge);
    return bridge;
  }

  it('generates a shim + mcp-config naming exactly the supplied tools', async () => {
    const bridge = await bridgeFor([ECHO_TOOL]);
    expect(bridge.toolNames).toEqual(['echo']);
    const configRaw = await readFile(bridge.mcpConfigPath, 'utf8');
    const config = JSON.parse(configRaw);
    expect(Object.keys(config.mcpServers)).toEqual(['llm-tools']);
  });

  it('rejects a tools/call with no turn armed, rather than reaching for an executor that does not exist', async () => {
    const bridge = await bridgeFor([ECHO_TOOL]);
    const port = await bridgePort(bridge);

    const resp = await sendToolCall(port, { id: '1', name: 'echo', arguments: { text: 'hi' } });

    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toContain('no tool call is expected right now');
  });

  it('forwards an armed tools/call to the executor and returns its result', async () => {
    const bridge = await bridgeFor([ECHO_TOOL]);
    const port = await bridgePort(bridge);
    const seen: ToolUse[] = [];
    const state = bridge.arm(async (use) => {
      seen.push(use);
      return `echoed: ${JSON.stringify(use.input)}`;
    }, 5);

    const resp = await sendToolCall(port, {
      id: 'call-1',
      name: 'echo',
      arguments: { text: 'hello' },
    });

    expect(resp.id).toBe('call-1');
    expect(resp.result.isError).toBe(false);
    expect(resp.result.content[0].text).toBe('echoed: {"text":"hello"}');
    expect(seen).toEqual([{ id: 'call-1', name: 'echo', input: { text: 'hello' } }]);
    expect(state.toolUses).toHaveLength(1);
    expect(state.toolResults).toEqual([
      { toolUseId: 'call-1', content: 'echoed: {"text":"hello"}', isError: false },
    ]);
  });

  it('surfaces an executor throw as an is_error tool result rather than crashing the bridge', async () => {
    const bridge = await bridgeFor([ECHO_TOOL]);
    const port = await bridgePort(bridge);
    const state = bridge.arm(async () => {
      throw new Error('boom');
    }, 5);

    const resp = await sendToolCall(port, { id: 'c1', name: 'echo', arguments: {} });

    expect(resp.result.isError).toBe(true);
    expect(resp.result.content[0].text).toBe('boom');
    expect(state.toolResults[0]).toEqual({ toolUseId: 'c1', content: 'boom', isError: true });
  });

  it('re-arming for a new turn starts a fresh accumulator, not carrying over the previous turn', async () => {
    const bridge = await bridgeFor([ECHO_TOOL]);
    const port = await bridgePort(bridge);
    bridge.arm(async () => 'first', 5);
    await sendToolCall(port, { id: 'a', name: 'echo', arguments: {} });

    const second = bridge.arm(async () => 'second', 5);

    expect(second.toolUses).toHaveLength(0);
    expect(second.toolResults).toHaveLength(0);
  });

  it('refuses further tool calls once the per-turn budget is spent, without reaching the executor', async () => {
    const bridge = await bridgeFor([ECHO_TOOL]);
    const port = await bridgePort(bridge);
    let calls = 0;
    const state = bridge.arm(async () => {
      calls += 1;
      return 'ok';
    }, 1);

    await sendToolCall(port, { id: 'a', name: 'echo', arguments: {} });
    const second = await sendToolCall(port, { id: 'b', name: 'echo', arguments: {} });

    expect(calls).toBe(1); // the executor never ran for the second call
    expect(second.result.isError).toBe(true);
    expect(second.result.content[0].text).toContain('budget exhausted');
    expect(state.toolUses).toHaveLength(2); // both calls are still recorded, the second as a refusal
    expect(state.toolResults[1].isError).toBe(true);
  });

  it('close() is safe to call more than once', async () => {
    const bridge = await createToolBridge([ECHO_TOOL]);
    await bridge.close();
    await expect(bridge.close()).resolves.toBeUndefined();
  });
});
