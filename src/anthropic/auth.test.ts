import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Anthropic SDK so we can inspect BOTH the constructor options (how the
// client authenticates) and the request payload (the system blocks). Same
// pattern as chat.test.ts, but here the constructor capture is the point.
const mockStream = vi.fn();
const mockClientCtor = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { stream: mockStream };
    constructor(opts: unknown) {
      mockClientCtor(opts);
    }
  },
}));

import { chat, resolveAnthropicAuth, resetAnthropicClientForTests } from './index.js';

function fakeStream() {
  return {
    on: () => {},
    finalMessage: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }),
  };
}

const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

describe('resolveAnthropicAuth — credential precedence', () => {
  it('prefers an explicit per-call apiKey (BYOK) over the environment', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'oat',
      ANTHROPIC_API_KEY: 'sk-env',
    } as NodeJS.ProcessEnv;
    expect(resolveAnthropicAuth('sk-call', env)).toEqual({ kind: 'apiKey', apiKey: 'sk-call' });
  });

  it('prefers the subscription OAuth token over the metered API key', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-xyz',
      ANTHROPIC_API_KEY: 'sk-env',
    } as NodeJS.ProcessEnv;
    expect(resolveAnthropicAuth(null, env)).toEqual({ kind: 'oauth', authToken: 'oat-xyz' });
  });

  it('falls back to ANTHROPIC_API_KEY when no OAuth token is set', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-env' } as NodeJS.ProcessEnv;
    expect(resolveAnthropicAuth(null, env)).toEqual({ kind: 'apiKey', apiKey: 'sk-env' });
  });

  it('returns null when no credential is available', () => {
    expect(resolveAnthropicAuth(null, {} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('ignores blank/whitespace credential values', () => {
    const env = {
      CLAUDE_CODE_OAUTH_TOKEN: '   ',
      ANTHROPIC_API_KEY: 'sk-env',
    } as NodeJS.ProcessEnv;
    expect(resolveAnthropicAuth(null, env)).toEqual({ kind: 'apiKey', apiKey: 'sk-env' });
  });
});

describe('anthropic client — subscription OAuth path', () => {
  const KEYS = [
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_OAUTH_BETA',
    'ANTHROPIC_OAUTH_SYSTEM',
    'ANTHROPIC_BASE_URL',
  ];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
    mockStream.mockReturnValue(fakeStream());
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetAnthropicClientForTests();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetAnthropicClientForTests();
  });

  it('authenticates with the bearer token + oauth beta header, and apiKey:null so the metered key cannot ride along', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-be-used';

    await chat({ systemPrompt: 'do it', turns: [{ role: 'user', content: 'x' }] });

    expect(mockClientCtor).toHaveBeenCalledTimes(1);
    const opts = mockClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.authToken).toBe('oat-secret');
    // The load-bearing assertion: an explicit null blocks the SDK's env auto-read
    // of ANTHROPIC_API_KEY, so no x-api-key rides along and the metered key is
    // never billed on the OAuth path.
    expect(opts.apiKey).toBeNull();
    expect(opts.defaultHeaders).toEqual({ 'anthropic-beta': 'oauth-2025-04-20' });
  });

  it('leads the system prompt with the Claude-Code identity on the OAuth path', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';

    await chat({ systemPrompt: 'REVIEW THIS', turns: [{ role: 'user', content: 'x' }] });

    const request = mockStream.mock.calls[0][0] as { system: { text: string }[] };
    expect(request.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(request.system[1].text).toBe('REVIEW THIS');
  });

  it('honours the ANTHROPIC_OAUTH_BETA / ANTHROPIC_OAUTH_SYSTEM overrides', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';
    process.env.ANTHROPIC_OAUTH_BETA = 'oauth-9999-01-01';
    process.env.ANTHROPIC_OAUTH_SYSTEM = 'Custom identity.';

    await chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }] });

    const opts = mockClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.defaultHeaders).toEqual({ 'anthropic-beta': 'oauth-9999-01-01' });
    const request = mockStream.mock.calls[0][0] as { system: { text: string }[] };
    expect(request.system[0].text).toBe('Custom identity.');
  });

  it('uses the API key with no identity block and no bearer when only ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';

    await chat({ systemPrompt: 'PLAIN', turns: [{ role: 'user', content: 'x' }] });

    const opts = mockClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiKey).toBe('sk-env');
    expect(opts.authToken).toBeNull();
    const request = mockStream.mock.calls[0][0] as { system: { text: string }[] };
    expect(request.system).toHaveLength(1);
    expect(request.system[0].text).toBe('PLAIN');
  });

  it('throws a clear error when no credential is configured at all', async () => {
    await expect(
      chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }] })
    ).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN.*ANTHROPIC_API_KEY|No Anthropic credential/);
  });
});
