import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The credentials library is mocked at the constructor: these tests hold when
 * the route builds the object, with which scope, and how often it asks for a
 * token. The real `openai` SDK sends through a fake `fetch`: no network.
 * The mocks are hoisted with the mock, so that a module which built the object
 * while this file's imports load reaches a test's assertion and does not fail
 * the file's load.
 */
const { authCtor, getAccessToken } = vi.hoisted(() => ({
  authCtor: vi.fn(),
  getAccessToken: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: class GoogleAuth {
    getAccessToken = getAccessToken;
    constructor(opts: unknown) {
      authCtor(opts);
    }
  },
}));

import { chat } from './index.js';
import { setTransportForTests } from './client.js';
import type { ChatOptions } from '../index.js';

const BASE: ChatOptions = {
  systemPrompt: 'sys',
  turns: [{ role: 'user', content: 'hello' }],
  model: 'google/gemini-3.5-flash',
};

const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

const sentTokens = () =>
  fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'));

let savedProject: string | undefined;

beforeEach(() => {
  authCtor.mockReset();
  getAccessToken.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  );
  savedProject = process.env.GOOGLE_CLOUD_PROJECT;
  process.env.GOOGLE_CLOUD_PROJECT = 'proj-a';
  // Only `fetch` is replaced: the token source is the route's own.
  setTransportForTests({ fetch: fetchMock });
});

afterEach(() => {
  if (savedProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
  else process.env.GOOGLE_CLOUD_PROJECT = savedProject;
  setTransportForTests();
});

describe('@verevoir/llm/vertex-openai — the Google Cloud token source', () => {
  it('builds no credentials object on import, nor for a call refused before any request', async () => {
    const built = vi.fn();
    const asked = vi.fn(async () => 'tok');
    const counts = () => ({ built: built.mock.calls.length, asked: asked.mock.calls.length });
    vi.resetModules();
    vi.doMock('google-auth-library', () => ({
      GoogleAuth: class GoogleAuth {
        getAccessToken = asked;
        constructor(opts: unknown) {
          built(opts);
        }
      },
    }));

    // A first evaluation of the module, with nothing reset after it.
    const fresh = await import('./index.js');

    expect(counts()).toEqual({ built: 0, asked: 0 });

    await expect(fresh.chat({ ...BASE, model: undefined })).rejects.toThrow('No model');

    expect(counts()).toEqual({ built: 0, asked: 0 });
  });

  it('builds one credentials object, for the cloud-platform scope, and asks it before every call', async () => {
    getAccessToken.mockResolvedValueOnce('tok-1').mockResolvedValueOnce('tok-2');

    await chat(BASE);
    await chat(BASE);

    expect(authCtor.mock.calls).toEqual([
      [{ scopes: 'https://www.googleapis.com/auth/cloud-platform' }],
    ]);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(sentTokens()).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });
});
