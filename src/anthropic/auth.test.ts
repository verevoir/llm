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

import { chat, chatWithTools, chatWithToolLoop } from './index.js';
import { resetClientStateForTests } from './client.js';

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

// Credential precedence (per-call apiKey > CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY)
// is covered THROUGH the public `chat` / `chatWithTools` / `chatWithToolLoop` entry
// points below — resolveAnthropicAuth is an internal helper, exercised as a black box
// via its observable effect on the constructed client + request (test-through-the-public-interface).

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
    resetClientStateForTests();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetClientStateForTests();
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

  it('prefers an explicit per-call apiKey (BYOK) over the ambient OAuth token', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    await chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }], apiKey: 'sk-byok' });
    const opts = mockClientCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.apiKey).toBe('sk-byok');
    expect(opts.authToken).toBeNull();
    const request = mockStream.mock.calls[0][0] as { system: unknown[] };
    expect(request.system).toHaveLength(1); // key path — no identity block
  });

  it('leads the identity on the OAuth path through chatWithTools too', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';
    await chatWithTools({
      systemPrompt: 'REVIEW',
      turns: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
    });
    const request = mockStream.mock.calls[0][0] as { system: { text: string }[] };
    expect(request.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(request.system[1].text).toBe('REVIEW');
  });

  it('leads the identity on the OAuth path through chatWithToolLoop too', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';
    await chatWithToolLoop({
      systemPrompt: 'REVIEW',
      turns: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'noop', description: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
      executor: async () => 'x',
    });
    const request = mockStream.mock.calls[0][0] as { system: { text: string }[] };
    expect(request.system[0].text).toBe(CLAUDE_CODE_IDENTITY);
    expect(request.system[1].text).toBe('REVIEW');
  });
});

describe('anthropic client — 401 OAuth→API-key fallback (loud, once)', () => {
  const KEYS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'];
  const saved: Record<string, string | undefined> = {};
  let errSpy: ReturnType<typeof vi.spyOn>;

  function failStream(status: number) {
    return {
      on: () => {},
      finalMessage: async () => {
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      },
    };
  }

  beforeEach(() => {
    mockStream.mockReset();
    mockClientCtor.mockReset();
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetClientStateForTests();
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetClientStateForTests();
    errSpy.mockRestore();
  });

  it('falls back from a rejected OAuth token to the metered key, rebuilding the request WITHOUT the identity, and warns loudly', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-bad';
    process.env.ANTHROPIC_API_KEY = 'sk-fallback';
    mockStream.mockReturnValueOnce(failStream(401)); // OAuth attempt rejected
    mockStream.mockReturnValueOnce(fakeStream()); // metered-key retry succeeds

    const reply = await chat({ systemPrompt: 'REVIEW', turns: [{ role: 'user', content: 'x' }] });
    expect(reply.content).toBe('ok');

    // Two clients built: first OAuth (bearer), then the metered key.
    expect(mockClientCtor).toHaveBeenCalledTimes(2);
    expect((mockClientCtor.mock.calls[0][0] as Record<string, unknown>).authToken).toBe('oat-bad');
    expect((mockClientCtor.mock.calls[1][0] as Record<string, unknown>).apiKey).toBe('sk-fallback');
    expect((mockClientCtor.mock.calls[1][0] as Record<string, unknown>).authToken).toBeNull();

    // The fallback request is rebuilt for the KEY path — no Claude-Code identity block.
    const oauthReq = mockStream.mock.calls[0][0] as { system: unknown[] };
    const keyReq = mockStream.mock.calls[1][0] as { system: unknown[] };
    expect(oauthReq.system).toHaveLength(2); // identity + prompt
    expect(keyReq.system).toHaveLength(1); // prompt only

    // Loud, once.
    const warned = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(warned).toContain('CLAUDE_CODE_OAUTH_TOKEN was rejected');
    expect(warned).toContain('BILLS YOUR API KEY');
  });

  it('does NOT fall back when there is no metered key — the 401 propagates', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-bad';
    mockStream.mockReturnValue(failStream(401));
    await expect(
      chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ status: 401 });
    expect(mockClientCtor).toHaveBeenCalledTimes(1); // OAuth only, no fallback client
  });

  it('does NOT fall back for a per-call (BYOK) key — only ambient OAuth falls back', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';
    process.env.ANTHROPIC_API_KEY = 'sk-fallback';
    mockStream.mockReturnValue(failStream(401));
    await expect(
      chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }], apiKey: 'sk-byok' })
    ).rejects.toMatchObject({ status: 401 });
  });

  it('does NOT fall back on a 403 (authorization, not a bad token) — the error propagates', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat';
    process.env.ANTHROPIC_API_KEY = 'sk-fallback';
    mockStream.mockReturnValue(failStream(403));
    await expect(
      chat({ systemPrompt: 's', turns: [{ role: 'user', content: 'x' }] })
    ).rejects.toMatchObject({ status: 403 });
    expect(mockClientCtor).toHaveBeenCalledTimes(1); // OAuth only — no fallback client built
  });

  it('latches: after one fallback, later calls go straight to the key (no repeat OAuth attempt or warning)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-bad';
    process.env.ANTHROPIC_API_KEY = 'sk-fallback';
    mockStream.mockReturnValueOnce(failStream(401));
    mockStream.mockReturnValue(fakeStream()); // all subsequent calls succeed

    await chat({ systemPrompt: 'a', turns: [{ role: 'user', content: 'x' }] }); // triggers fallback
    const ctorsAfterFirst = mockClientCtor.mock.calls.length;
    const warnsAfterFirst = errSpy.mock.calls.length;

    await chat({ systemPrompt: 'b', turns: [{ role: 'user', content: 'y' }] }); // should use key directly

    // No new client built (cached key client reused), no second warning.
    expect(mockClientCtor.mock.calls.length).toBe(ctorsAfterFirst);
    expect(errSpy.mock.calls.length).toBe(warnsAfterFirst);
    // The second call's request used the key path (no identity block).
    const lastReq = mockStream.mock.calls[mockStream.mock.calls.length - 1][0] as {
      system: unknown[];
    };
    expect(lastReq.system).toHaveLength(1);
  });

  it('after a latch, a later call fails clearly if the metered key is now gone (no silent OAuth re-attempt)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oat-bad';
    process.env.ANTHROPIC_API_KEY = 'sk-fallback';
    mockStream.mockReturnValueOnce(failStream(401)); // first OAuth attempt → latch
    mockStream.mockReturnValue(fakeStream()); // fallback succeeds
    await chat({ systemPrompt: 'a', turns: [{ role: 'user', content: 'x' }] }); // latched
    delete process.env.ANTHROPIC_API_KEY; // metered key removed after the latch
    await expect(
      chat({ systemPrompt: 'b', turns: [{ role: 'user', content: 'y' }] })
    ).rejects.toThrow(/rejected earlier this session|no ANTHROPIC_API_KEY/i);
  });
});
