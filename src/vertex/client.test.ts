/**
 * The Vertex route with ANTHROPIC_VERTEX_BASE_URL and
 * ANTHROPIC_VERTEX_ACCESS_TOKEN set, through the real `AnthropicVertex` and a
 * fake `fetch`. Google Cloud's credential lookup starts in `GoogleAuth`'s
 * `getClient`, which the Vertex SDK calls as it is constructed when it is given
 * no `authClient` (`this._authClientPromise = this._auth.getClient();`); here
 * that method throws, so a lookup on the token path fails the test.
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { GoogleAuth } from 'google-auth-library';
import { chat } from './index.js';
import { resetClientForTests } from './client.js';
import { setModelSpanSink, type ModelSpan } from '../index.js';
import { fetchMock, isolateEnv, json } from '../test-support/fetch-driver.js';

const SENTINEL = 'sentinel-token-3f9c1a7e';

const BASE = {
  systemPrompt: 'sys',
  turns: [{ role: 'user' as const, content: 'hello' }],
  model: 'claude-test',
};

isolateEnv([
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_ACCESS_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(() => {
  vi.stubGlobal('fetch', fetchMock);
  trace.setGlobalTracerProvider(tracerProvider);
});
afterAll(async () => {
  vi.unstubAllGlobals();
  trace.disable();
  await tracerProvider.shutdown();
});

beforeEach(() => {
  fetchMock.mockReset();
  exporter.reset();
  resetClientForTests();
  vi.spyOn(GoogleAuth.prototype, 'getClient').mockImplementation(() => {
    throw new Error('a Google Cloud credential was looked for');
  });
  Object.assign(process.env, {
    ANTHROPIC_VERTEX_PROJECT_ID: 'proj',
    CLOUD_ML_REGION: 'region',
    ANTHROPIC_VERTEX_BASE_URL: 'http://stand-in.local:8080/v1',
    ANTHROPIC_VERTEX_ACCESS_TOKEN: SENTINEL,
  });
});
afterEach(() => {
  setModelSpanSink(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('@verevoir/llm/vertex — a fixed token at a given address, through the real client', () => {
  it('sends to the given address with exactly the bearer header, and looks for no cloud credential', async () => {
    fetchMock.mockImplementation(async () =>
      json({ type: 'error', error: { type: 'invalid_request_error', message: 'no' } }, 400)
    );

    await chat(BASE).catch(() => undefined);

    expect(GoogleAuth.prototype.getClient).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      'http://stand-in.local:8080/v1/projects/proj/locations/region/publishers/anthropic/models/claude-test:streamRawPredict'
    );
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${SENTINEL}`);
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('the token appears in no thrown value, log line, model span or span attribute', async () => {
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }
    const modelSpans: ModelSpan[] = [];
    setModelSpanSink((span) => void modelSpans.push(span));
    fetchMock.mockImplementation(async () =>
      json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, 401)
    );

    vi.useFakeTimers();
    const pending = chat(BASE).then(
      () => null,
      (e: unknown) => e
    );
    await vi.runAllTimersAsync();
    const err = (await pending) as Error & { cause?: unknown };

    expect(err).toBeInstanceOf(Error);
    const thrown = [err.message, String(err), err.stack, JSON.stringify(err), String(err.cause)];
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const seen = [
      ...thrown,
      ...written,
      JSON.stringify(modelSpans),
      JSON.stringify(spans.map((s) => [s.attributes, s.events, s.status])),
    ].join('\n');
    expect(seen).not.toContain(SENTINEL);
    expect((err as { status?: number }).status).toBe(401);
  });
});
