#!/usr/bin/env node
'use strict';
/**
 * THROWAWAY PROBE — not part of any reviewed branch, not built with the
 * package's own conventions in mind, exists only to answer one question
 * before real code is written against it. See probe/README.md.
 *
 * A minimal stdio MCP server: one tool ("echo"), answers initialize,
 * tools/list, tools/call. Logs EVERY line it receives on its own stdin —
 * and every line it sends back — to mcp-server-stdin.log next to this
 * script, so "was the tool actually invoked" is answered by evidence in
 * that file, not by inference from claude's own stdout.
 */
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, 'mcp-server-stdin.log');

function log(line) {
  fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
}

function send(obj) {
  const line = JSON.stringify(obj);
  log(`SENT: ${line}`);
  process.stdout.write(line + '\n');
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'llm-probe-echo-server', version: '0.0.0' },
      },
    });
  } else if (msg.method === 'notifications/initialized') {
    // Notification — no response expected.
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the given text back, unmodified.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const args = (msg.params && msg.params.arguments) || {};
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [{ type: 'text', text: `echo-server-received: ${JSON.stringify(args)}` }],
        isError: false,
      },
    });
  } else if (msg.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `unsupported method: ${msg.method}` },
    });
  }
}

log('SERVER STARTED');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    log(`RECEIVED: ${line}`);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`PARSE ERROR: ${e}`);
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => {
  log('STDIN END — exiting');
  process.exit(0);
});
