/**
 * The fetch driver of the single-retry suites: a fake `fetch` that the real
 * SDK clients send through, the failures it produces, and the rows the suites
 * run. Each row counts the requests that reach `fetch`, so a retry the SDK
 * made on its own would be counted too. No network; every wait, the SDK's
 * request timeout included, runs on fake timers.
 *
 * There are two sets of rows. `pathRows` holds every failure the policy tells
 * apart, and runs once per SDK path: each SDK builds every error it throws in
 * one place, whichever client or call shape the request came from. `siteRows`
 * holds the rows that catch what one client-building site or call shape can
 * get wrong on its own: the SDK's retries left on (the 503 row), the policy
 * left out (the 429 row), its own request timeout (the timeout row), and the
 * caller's signal left out (the two abort rows).
 *
 * The build leaves this directory out (`tsconfig.build.json`), so nothing here
 * is published.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ChatRetryInfo } from '../index.js';
import { RETRY_BACKOFFS_MS, TIMEOUT_RETRIES } from '../retry-policy.js';

export const fetchMock =
  vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>();

export const json = (
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** `fetch` rejects, as it does when no connection can be made. */
export function failToConnect(): void {
  fetchMock.mockImplementation(async () => {
    throw new TypeError('fetch failed');
  });
}

/** `fetch` never answers. It rejects only when the SDK aborts the request,
 * which the SDK does when its own request timeout runs out. */
export function neverAnswer(): void {
  fetchMock.mockImplementation(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      })
  );
}

/** A client takes the global `fetch` when it is built, and a module may keep
 * its client for the life of the file: the fake is in place for the whole
 * file, and each test starts with no answers arranged and on fake timers. */
export function useFakeFetch(): void {
  beforeAll(() => {
    vi.stubGlobal('fetch', fetchMock);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    fetchMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

/** Each test starts with these environment variables unset, and gets back
 * what they held after it. */
export function isolateEnv(names: readonly string[]): void {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of names) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of names) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

export type Extra = {
  apiKey?: string;
  onRetry?: (info: ChatRetryInfo) => Promise<void>;
  abortSignal?: AbortSignal;
};

/** Make a call of one shape, and give back the text it answered with. */
export type Call = (extra: Extra) => Promise<string>;

export interface Outcome {
  resolved: boolean;
  text?: string;
  error?: unknown;
  retries: ChatRetryInfo[];
}

/** Make the call, run every wait it starts on the fake clock, and say how it
 * ended and what `onRetry` was told. */
export async function run(call: Call, key: Extra): Promise<Outcome> {
  const retries: ChatRetryInfo[] = [];
  let outcome: Outcome | undefined;
  void call({
    ...key,
    onRetry: async (info) => {
      retries.push(info);
    },
  }).then(
    (text) => (outcome = { resolved: true, text, retries }),
    (error: unknown) => (outcome = { resolved: false, error, retries })
  );
  do {
    await vi.runAllTimersAsync();
  } while (!outcome);
  return outcome;
}

export const statusOf = (error: unknown) => (error as { status?: number }).status;
export const classOf = (error: unknown) => (error as Error).constructor.name;

/** The retries the policy allows, from its own list of waits. */
export const RETRIES = RETRY_BACKOFFS_MS.length;

export type Row = [name: string, arrange: () => void, thrown: (error: unknown) => void];

/** One call shape on one client, and how its SDK's API answers. */
export interface Site {
  call: Call;
  /** The credential every call of this site carries. */
  key: Extra;
  /** A refusal of this status, in the shape this API sends one. */
  refusal: (status: number, headers?: Record<string, string>) => Response;
  /** A whole answer, fresh for each request. */
  answer: () => Response;
  /** The text the call gives back for `answer`. */
  text: string;
  /** The SDK's own request timeout. */
  timeoutMs: number;
}

/** Answer every request with a refusal of this status. */
const refuse = (site: Site, status: number, headers?: Record<string, string>) => () =>
  fetchMock.mockImplementation(async () => site.refusal(status, headers));

const refused = (site: Site, status: number, headers?: Record<string, string>): Row => [
  headers ? `a ${status} with x-should-retry: ${headers['x-should-retry']}` : `a ${status}`,
  refuse(site, status, headers),
  (error) => expect(statusOf(error)).toBe(status),
];

const CONNECTION_FAILURE: Row = [
  'a connection failure (fetch rejects)',
  failToConnect,
  (error) => expect(classOf(error)).toBe('APIConnectionError'),
];

function itRetries(site: Site, rows: Row[]): void {
  it.each(rows)(
    'sends %s answered every time once, then once per retry the policy allows, telling onRetry of each',
    async (_name, arrange, thrown) => {
      arrange();

      const { resolved, error, retries } = await run(site.call, site.key);

      expect(resolved).toBe(false);
      thrown(error);
      expect(fetchMock).toHaveBeenCalledTimes(1 + RETRIES);
      expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
        RETRY_BACKOFFS_MS.map((delayMs, i) => [i + 1, RETRIES, delayMs])
      );
    }
  );
}

function itSendsOnce(site: Site, rows: Row[]): void {
  it.each(rows)('sends %s once, and onRetry is not called', async (_name, arrange, thrown) => {
    arrange();

    const { resolved, error, retries } = await run(site.call, site.key);

    expect(resolved).toBe(false);
    thrown(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
  });
}

function itRecovers(site: Site, firstAnswers: [name: string, answer: () => Response][]): void {
  it.each(firstAnswers)(
    'sends a request that meets %s and then succeeds twice, and delivers one answer',
    async (_name, firstAnswer) => {
      fetchMock.mockImplementation(async () => site.answer());
      fetchMock.mockImplementationOnce(async () => firstAnswer());

      const { resolved, text, retries } = await run(site.call, site.key);

      expect(resolved).toBe(true);
      expect(text).toBe(site.text);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(retries.map((r) => r.attempt)).toEqual([1]);
    }
  );
}

function itTimesOut(site: Site): void {
  it("sends a request never answered once, then TIMEOUT_RETRIES times more with no wait: the SDK's request timeout each time, and nothing between", async () => {
    neverAnswer();
    const began = Date.now();

    const { resolved, error, retries } = await run(site.call, site.key);

    expect(resolved).toBe(false);
    expect(classOf(error)).toBe('APIConnectionTimeoutError');
    expect(fetchMock).toHaveBeenCalledTimes(1 + TIMEOUT_RETRIES);
    expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
      Array.from({ length: TIMEOUT_RETRIES }, (_, i) => [i + 1, RETRIES, 0])
    );
    expect(Date.now() - began).toBe((1 + TIMEOUT_RETRIES) * site.timeoutMs);
  });
}

/** `waits` are indices into the policy's list of waits. */
function itEndsOnAbort(site: Site, waits: number[]): void {
  it.each(waits.map((i) => [i + 1, RETRY_BACKOFFS_MS[i] / 1000, i] as const))(
    "an abort of the caller's signal during wait %i (%i s) ends the call at once with the signal's reason, and no further request is sent",
    async (_n, _seconds, i) => {
      refuse(site, 503)();
      const controller = new AbortController();
      const reason = new Error('the caller gave up');
      let ended: { error: unknown } | undefined;
      void site.call({ ...site.key, abortSignal: controller.signal }).then(
        () => (ended = { error: undefined }),
        (error: unknown) => (ended = { error })
      );

      // To the middle of this wait: every wait before it has run out.
      const waited = RETRY_BACKOFFS_MS.slice(0, i).reduce((a, b) => a + b, 0);
      await vi.advanceTimersByTimeAsync(waited + RETRY_BACKOFFS_MS[i] / 2);
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      expect(ended).toBeUndefined();

      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(0);

      expect(ended).toEqual({ error: reason });
      expect(ended?.error).toBe(reason);
      await vi.runAllTimersAsync();
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
    }
  );
}

function itSendsNothingWhenAborted(site: Site): void {
  it("sends nothing when the caller's signal is aborted before the call", async () => {
    fetchMock.mockImplementation(async () => site.answer());
    const controller = new AbortController();
    const reason = new Error('the caller gave up');
    controller.abort(reason);

    const { resolved, error, retries } = await run(site.call, {
      ...site.key,
      abortSignal: controller.signal,
    });

    expect(resolved).toBe(false);
    expect(error).toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(retries).toEqual([]);
  });
}

/** Every failure the policy tells apart, for the one site that stands for an
 * SDK path. `more` adds the failures only that path can meet. */
export function pathRows(
  site: Site,
  more: { retried?: Row[]; notRetried?: Row[]; recoversFrom?: number[] } = {}
): void {
  itRetries(site, [
    ...[408, 409, 429, 500, 502, 503, 504, 529].map((status) => refused(site, status)),
    CONNECTION_FAILURE,
    refused(site, 400, { 'x-should-retry': 'true' }),
    ...(more.retried ?? []),
  ]);
  itSendsOnce(site, [
    ...[400, 401, 403, 404, 422].map((status) => refused(site, status)),
    ...[429, 503].map((status) => refused(site, status, { 'x-should-retry': 'false' })),
    ...(more.notRetried ?? []),
  ]);
  itRecovers(site, [
    ...[429, ...(more.recoversFrom ?? [])].map((status): [string, () => Response] => [
      `a ${status}`,
      () => site.refusal(status),
    ]),
    [
      'a connection failure',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ]);
  itTimesOut(site);
  itEndsOnAbort(
    site,
    RETRY_BACKOFFS_MS.map((_, i) => i)
  );
  itSendsNothingWhenAborted(site);
}

/** The rows that catch what one site can get wrong on its own. */
export function siteRows(site: Site): void {
  itRetries(site, [refused(site, 503)]);
  itRecovers(site, [['a 429', () => site.refusal(429)]]);
  itTimesOut(site);
  itEndsOnAbort(site, [0]);
  itSendsNothingWhenAborted(site);
}
