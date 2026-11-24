/**
 * The retry policy on its own: what it reads off an error, held against the
 * real SDK's error classes and against `classifyLlmError`; what a caller's
 * abort does to it; and the figures the README states, computed from its
 * constants. What it does to the number of requests an adapter sends is
 * counted in `openai-sdk-single-retry.test.ts`.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import { classifyLlmError, type ChatRetryInfo } from './index.js';
import {
  RETRY_BACKOFFS_MS,
  TIMEOUT_RETRIES,
  callWithRetries,
  retriableReason,
} from './retry-policy.js';

/** The error the SDK builds for a response of this status and these headers. */
const sdkError = (status: number, headers: Record<string, string> = {}) =>
  APIError.generate(status, { error: { message: 'refused' } }, undefined, new Headers(headers));

describe('the retry policy of the adapters that send through the openai SDK', () => {
  it('waits 5, 30 and 120 seconds: three retries', () => {
    expect(RETRY_BACKOFFS_MS).toEqual([5_000, 30_000, 120_000]);
  });

  it('retries a request timeout twice', () => {
    expect(TIMEOUT_RETRIES).toBe(2);
  });

  it.each([408, 409, 429, 500, 501, 502, 503, 504, 529, 599])('retries a %i', (status) => {
    expect(retriableReason(sdkError(status), 'P')).toMatch(new RegExp(`^P .*\\(${status}\\)$`));
  });

  it.each([400, 401, 403, 404, 422, 499])('does not retry a %i', (status) => {
    expect(retriableReason(sdkError(status), 'P')).toBeNull();
  });

  it('names 429, 500, 502 and 503 in the reason it gives for each', () => {
    expect([429, 500, 502, 503].map((s) => retriableReason(sdkError(s), 'P'))).toEqual([
      'P rate-limited (429)',
      'P internal error (500)',
      'P bad gateway (502)',
      'P service unavailable (503)',
    ]);
  });

  it('retries a connection failure and a request timeout, and not a caller abort', () => {
    expect(retriableReason(new APIConnectionError({ message: 'x' }), 'P')).toBe(
      'P connection failed'
    );
    expect(retriableReason(new APIConnectionTimeoutError(), 'P')).toBe('P request timed out');
    expect(retriableReason(new APIUserAbortError(), 'P')).toBeNull();
  });

  it.each([400, 404, 422])('retries a %i whose x-should-retry header is true', (status) => {
    expect(retriableReason(sdkError(status, { 'x-should-retry': 'true' }), 'P')).toBe(
      `P asked for a retry (x-should-retry, ${status})`
    );
  });

  it.each([408, 409, 429, 500, 503, 529])(
    'does not retry a %i whose x-should-retry header is false',
    (status) => {
      expect(retriableReason(sdkError(status, { 'x-should-retry': 'false' }), 'P')).toBeNull();
    }
  );

  it('ignores any other value of the header, as the SDK does', () => {
    expect(retriableReason(sdkError(400, { 'x-should-retry': 'TRUE' }), 'P')).toBeNull();
    expect(retriableReason(sdkError(429, { 'x-should-retry': 'no' }), 'P')).not.toBeNull();
  });

  it('x-should-retry: false also stops the message rule', () => {
    const err = Object.assign(new Error('429 rate limit'), {
      headers: new Headers({ 'x-should-retry': 'false' }),
    });
    expect(retriableReason(err, 'P')).toBeNull();
  });

  it('retries an error whose message names a 429, 500, 502 or 503, and no other', () => {
    expect(retriableReason(new Error('upstream said 503'), 'P')).toBe(
      'P service unavailable (503)'
    );
    expect(retriableReason(new Error('internal_server_error'), 'P')).toBe('P internal error (500)');
    expect(retriableReason(new Error('rate limit reached'), 'P')).toBe('P rate-limited (429)');
    expect(retriableReason(new Error('bad gateway'), 'P')).toBe('P bad gateway (502)');
    expect(retriableReason(new Error('504 gateway timeout'), 'P')).toBeNull();
  });

  // The message is read whatever the status, so a 400 that mentions a retried
  // status is retried: the cost of reading messages at all.
  it('retries a 400 whose message names a retried status', () => {
    const err = APIError.generate(
      400,
      { error: { message: 'at most 500' } },
      undefined,
      new Headers()
    );
    expect(err.message).toBe('400 at most 500');
    expect(retriableReason(err, 'P')).toBe('P internal error (500)');
  });

  it.each([[null], [undefined], ['503'], [503], [Object.create(null)], [{ status: '503' }]])(
    'does not retry %j',
    (err) => {
      expect(retriableReason(err, 'P')).toBeNull();
    }
  );

  // The two recognise a failure with no response by the same class names, and
  // agree on every status but 409: retried here, as the SDK's own rule
  // retries it, though `classifyLlmError` calls it `invalid-request`.
  it('retries every SDK error classifyLlmError calls retryable, and 409 besides', () => {
    const errors: unknown[] = [
      ...Array.from({ length: 200 }, (_, i) => sdkError(400 + i)),
      new APIConnectionError({ message: 'x' }),
      new APIConnectionTimeoutError(),
      new APIUserAbortError(),
    ];
    const disagreements = errors
      .filter((e) => classifyLlmError(e).retryable !== (retriableReason(e, 'P') !== null))
      .map((e) => (e as APIError).status);
    expect(disagreements).toEqual([409]);
  });
});

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

/** How a call started by {@link start} ended, once it has. */
interface Ending {
  settled: boolean;
  value?: unknown;
  error?: unknown;
}

/** Start `callWithRetries` over `call`, and keep how it ends and what
 * `onRetry` is told. Nothing is awaited: the test moves the fake clock. */
function start(call: () => Promise<unknown>, signal?: AbortSignal) {
  const calls = vi.fn(call);
  const retries: ChatRetryInfo[] = [];
  const ending: Ending = { settled: false };
  const onRetry = async (info: ChatRetryInfo) => {
    retries.push(info);
  };
  const made = signal
    ? callWithRetries(calls, 'P', onRetry, signal)
    : callWithRetries(calls, 'P', onRetry);
  made.then(
    (value) => Object.assign(ending, { settled: true, value }),
    (error: unknown) => Object.assign(ending, { settled: true, error })
  );
  return { calls, retries, ending };
}

/** Let everything that is due now happen, without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const fail = (err: unknown) => async () => {
  throw err;
};

/** A `call` that fails with each of `errors` in turn, then with the last. */
function failInTurn(errors: unknown[]): () => Promise<never> {
  let n = 0;
  return async () => {
    throw errors[Math.min(n++, errors.length - 1)];
  };
}

describe('callWithRetries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('with no signal', () => {
    it('makes a call that fails with a 503 every time once per wait and once more, over all the waits', async () => {
      const began = Date.now();
      const { calls, retries, ending } = start(fail(sdkError(503)));

      await vi.runAllTimersAsync();

      expect((ending.error as APIError).status).toBe(503);
      expect(calls).toHaveBeenCalledTimes(1 + RETRY_BACKOFFS_MS.length);
      expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
        RETRY_BACKOFFS_MS.map((ms, i) => [i + 1, RETRY_BACKOFFS_MS.length, ms])
      );
      expect(Date.now() - began).toBe(sum(RETRY_BACKOFFS_MS));
    });

    it('returns what the call returns', async () => {
      const { calls, ending } = start(async () => 'reply');
      await settle();
      expect(ending).toEqual({ settled: true, value: 'reply' });
      expect(calls).toHaveBeenCalledTimes(1);
    });
  });

  describe('a request timeout', () => {
    it('is retried at once, TIMEOUT_RETRIES times, with no wait', async () => {
      const began = Date.now();
      const { calls, retries, ending } = start(fail(new APIConnectionTimeoutError()));

      await vi.runAllTimersAsync();

      expect(ending.error).toBeInstanceOf(APIConnectionTimeoutError);
      expect(calls).toHaveBeenCalledTimes(1 + TIMEOUT_RETRIES);
      expect(retries.map((r) => [r.attempt, r.maxAttempts, r.delayMs])).toEqual(
        Array.from({ length: TIMEOUT_RETRIES }, (_, i) => [i + 1, RETRY_BACKOFFS_MS.length, 0])
      );
      expect(Date.now() - began).toBe(0);
    });

    it('after a failure of another kind is still retried at once, and the failure after it takes the next unused wait', async () => {
      const { retries, ending } = start(
        failInTurn([sdkError(503), new APIConnectionTimeoutError(), sdkError(503), sdkError(503)])
      );

      await vi.runAllTimersAsync();

      expect((ending.error as APIError).status).toBe(503);
      expect(retries.map((r) => r.delayMs)).toEqual([
        RETRY_BACKOFFS_MS[0],
        0,
        RETRY_BACKOFFS_MS[1],
      ]);
    });
  });

  describe('over every sequence of failures', () => {
    const KINDS = {
      status: () => sdkError(503),
      connection: () => new APIConnectionError({ message: 'x' }),
      timeout: () => new APIConnectionTimeoutError(),
    };
    type Kind = keyof typeof KINDS;

    /** A call's failures in turn, then how it goes on: a success, or the last
     * failure again for as long as it is asked. */
    interface Script {
      failures: Kind[];
      then: 'success' | 'failure';
      name: string;
    }

    /** Every sequence of up to `longest` failures, each ending both ways. */
    function scripts(longest: number): Script[] {
      let sequences: Kind[][] = [[]];
      const all: Script[] = [];
      for (let length = 0; length <= longest; length++) {
        for (const failures of sequences) {
          const name = failures.join(', ');
          all.push({ failures, then: 'success', name: `${name || 'no failure'}, then a success` });
          if (length > 0) all.push({ failures, then: 'failure', name: `${name}, for ever` });
        }
        sequences = sequences.flatMap((s) => (Object.keys(KINDS) as Kind[]).map((k) => [...s, k]));
      }
      return all;
    }

    /** Run one script to its end: the failure each request met, the time
     * that passed after it before the next request, and what `onRetry` got. */
    async function run({ failures, then }: Script) {
      const met: Kind[] = [];
      const sentAt: number[] = [];
      const { retries, ending } = start(async () => {
        sentAt.push(Date.now());
        const kind = failures[sentAt.length - 1] ?? (then === 'failure' ? failures.at(-1) : null);
        if (!kind) return 'reply';
        met.push(kind);
        throw KINDS[kind]();
      });
      await vi.runAllTimersAsync();
      const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]);
      return { met, requests: sentAt.length, gaps, retries, ending };
    }

    const MOST_REQUESTS = 1 + RETRY_BACKOFFS_MS.length;
    const MOST_WAITING = sum(RETRY_BACKOFFS_MS);
    const MOST_TIMEOUTS = 1 + TIMEOUT_RETRIES;

    it('holds the four rules and the three bounds, and reaches each bound', async () => {
      const most = {
        requests: { value: -1, by: '' },
        waiting: { value: -1, by: '' },
        timeouts: { value: -1, by: '' },
      };
      const all = scripts(1 + MOST_REQUESTS);
      expect(all).toHaveLength(3 ** (2 + MOST_REQUESTS) - 2);

      for (const script of all) {
        const { met, requests, gaps, retries, ending } = await run(script);
        const of = (what: string) => `${what}, in: ${script.name}`;
        const figures = {
          requests,
          waiting: sum(gaps),
          timeouts: met.filter((k) => k === 'timeout').length,
        };

        expect(ending.settled, of('the call ends')).toBe(true);
        expect(figures.requests, of('requests')).toBeLessThanOrEqual(MOST_REQUESTS);
        expect(figures.waiting, of('waiting')).toBeLessThanOrEqual(MOST_WAITING);
        expect(figures.timeouts, of('timeouts')).toBeLessThanOrEqual(MOST_TIMEOUTS);

        // Rule by rule. Each gap is the time between a failure and its retry.
        const afterTimeout = gaps.filter((_, i) => met[i] === 'timeout');
        const afterOther = gaps.filter((_, i) => met[i] !== 'timeout');
        expect(afterTimeout, of('no wait follows a timeout')).toEqual(afterTimeout.map(() => 0));
        expect(afterTimeout.length, of('retries after a timeout')).toBeLessThanOrEqual(
          TIMEOUT_RETRIES
        );
        expect(afterOther, of('the waits are the first of the list, in order')).toEqual(
          RETRY_BACKOFFS_MS.slice(0, afterOther.length)
        );
        expect(retries, of('onRetry is told once per retry, of that retry')).toEqual(
          gaps.map((delayMs, i) => ({
            attempt: i + 1,
            maxAttempts: RETRY_BACKOFFS_MS.length,
            delayMs,
            reason: expect.any(String),
          }))
        );

        // A call stops retrying only where a rule says so.
        if ('error' in ending) {
          const outOfRequests = requests === MOST_REQUESTS;
          const outOfTimeoutRetries =
            met.at(-1) === 'timeout' && afterTimeout.length === TIMEOUT_RETRIES;
          expect(outOfRequests || outOfTimeoutRetries, of('gave up by a rule')).toBe(true);
        } else {
          expect(requests, of('requests to the success')).toBe(script.failures.length + 1);
        }

        for (const key of ['requests', 'waiting', 'timeouts'] as const) {
          if (figures[key] > most[key].value) most[key] = { value: figures[key], by: script.name };
        }
      }

      expect(most.requests.value, `most requests, reached by: ${most.requests.by}`).toBe(
        MOST_REQUESTS
      );
      expect(most.waiting.value, `most waiting, reached by: ${most.waiting.by}`).toBe(MOST_WAITING);
      expect(most.timeouts.value, `most timeouts, reached by: ${most.timeouts.by}`).toBe(
        MOST_TIMEOUTS
      );
    });
  });

  describe("with the caller's signal", () => {
    it.each(RETRY_BACKOFFS_MS.map((ms, i) => [i + 1, ms / 1000, i] as const))(
      'an abort during wait %i (%i s) ends the call at once, and no further call is made',
      async (_n, _seconds, i) => {
        const controller = new AbortController();
        const reason = new Error('the caller gave up');
        const { calls, retries, ending } = start(fail(sdkError(503)), controller.signal);

        // To the middle of this wait: every wait before it has run out.
        await vi.advanceTimersByTimeAsync(
          sum(RETRY_BACKOFFS_MS.slice(0, i)) + RETRY_BACKOFFS_MS[i] / 2
        );
        expect(calls).toHaveBeenCalledTimes(i + 1);
        expect(ending.settled).toBe(false);

        controller.abort(reason);
        await settle();

        expect(ending.settled).toBe(true);
        expect(ending.error).toBe(reason);
        expect(vi.getTimerCount()).toBe(0);

        await vi.runAllTimersAsync();
        expect(calls).toHaveBeenCalledTimes(i + 1);
        expect(retries.map((r) => r.attempt)).toEqual(
          Array.from({ length: i + 1 }, (_, k) => k + 1)
        );
      }
    );

    it.each([
      [
        'an Error reason: the reason itself',
        (c: AbortController) => c.abort(new RangeError('budget spent')),
        (e: unknown) => {
          expect(e).toBeInstanceOf(RangeError);
          expect((e as Error).message).toBe('budget spent');
        },
      ],
      [
        'a reason that is not an Error: an Error of its text',
        (c: AbortController) => c.abort('budget spent'),
        (e: unknown) => {
          expect(e).toBeInstanceOf(Error);
          expect((e as Error).message).toBe('budget spent');
        },
      ],
      [
        "no reason given: the platform's AbortError",
        (c: AbortController) => c.abort(),
        (e: unknown) => expect((e as Error).name).toBe('AbortError'),
      ],
    ])(
      'an abort before the first attempt makes no call, and throws for %s',
      async (_name, abort, thrown) => {
        const controller = new AbortController();
        abort(controller);
        const { calls, retries, ending } = start(async () => 'reply', controller.signal);

        await vi.runAllTimersAsync();

        expect(ending.settled).toBe(true);
        thrown(ending.error);
        expect(classifyLlmError(ending.error)).toEqual({ kind: 'other', retryable: false });
        expect(calls).not.toHaveBeenCalled();
        expect(retries).toEqual([]);
      }
    );

    it('an abort while a call is in flight that then fails with a 503: no retry, and onRetry is not told', async () => {
      const controller = new AbortController();
      const reason = new Error('the caller gave up');
      const { calls, retries, ending } = start(async () => {
        controller.abort(reason);
        throw sdkError(503);
      }, controller.signal);

      await vi.runAllTimersAsync();

      expect(ending.error).toBe(reason);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(retries).toEqual([]);
    });

    it('an abort while a call is in flight that then succeeds: its result is returned', async () => {
      const controller = new AbortController();
      const { ending } = start(async () => {
        controller.abort();
        return 'reply';
      }, controller.signal);

      await vi.runAllTimersAsync();

      expect(ending).toEqual({ settled: true, value: 'reply' });
    });

    it('an abort while a call is in flight that then fails with a 400: the 400 is thrown', async () => {
      const controller = new AbortController();
      const { ending } = start(async () => {
        controller.abort();
        throw sdkError(400);
      }, controller.signal);

      await vi.runAllTimersAsync();

      expect((ending.error as APIError).status).toBe(400);
    });

    it('an abort made by onRetry itself starts no wait and no further call', async () => {
      const controller = new AbortController();
      const reason = new Error('budget spent');
      const calls = vi.fn(fail(sdkError(503)));
      const made = callWithRetries(
        calls,
        'P',
        async () => controller.abort(reason),
        controller.signal
      );
      const caught = made.catch((error: unknown) => error);

      await settle();

      expect(vi.getTimerCount()).toBe(0);
      expect(await caught).toBe(reason);
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it('a signal that is never aborted changes nothing: every wait runs, every retry is made', async () => {
      const began = Date.now();
      const { calls, ending } = start(fail(sdkError(503)), new AbortController().signal);

      await vi.runAllTimersAsync();

      expect((ending.error as APIError).status).toBe(503);
      expect(calls).toHaveBeenCalledTimes(1 + RETRY_BACKOFFS_MS.length);
      expect(Date.now() - began).toBe(sum(RETRY_BACKOFFS_MS));
    });
  });
});

/** The README, with every run of white space as one space: its lines wrap. */
const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');

/** Fails with the sentence looked for, not with the whole README. */
const expectReadmeToState = (sentence: string) =>
  expect(README.includes(sentence), `the README states: ${sentence}`).toBe(true);

describe('the figures the README states are those of the constants', () => {
  const requests = 1 + RETRY_BACKOFFS_MS.length;
  const waited = sum(RETRY_BACKOFFS_MS) / 1000;
  const timeoutRequests = 1 + TIMEOUT_RETRIES;
  const sdkTimeoutMinutes = OpenAI.DEFAULT_TIMEOUT / 60_000;

  it('each wait', () => {
    const waits = RETRY_BACKOFFS_MS.map((ms, i) => `${ms / 1000}${i === 0 ? ' seconds' : ''}`);
    expectReadmeToState(`unused wait, in order: ${waits.join(', then ')}.`);
  });

  it('the requests and the total wait before a status or a connection failure is given up', () => {
    expectReadmeToState(
      `is given up after ${requests} requests and ${waited} seconds of waiting, plus`
    );
    expectReadmeToState(
      `up to ${RETRY_BACKOFFS_MS.length} times more: ${requests} requests at most`
    );
    expect(README.match(new RegExp(`\\| up to ${requests} times \\|`, 'g'))).toHaveLength(5);
  });

  it('the requests and the total time before a request never answered is given up', () => {
    expectReadmeToState(`request timeout, ${sdkTimeoutMinutes} minutes by default`);
    expectReadmeToState(`at most ${TIMEOUT_RETRIES} of a call's retries follow a timeout`);
    expectReadmeToState(
      `is given up after ${timeoutRequests} requests and ` +
        `${timeoutRequests * sdkTimeoutMinutes} minutes, with no waiting between them`
    );
    expect(README.match(new RegExp(`\\| up to ${timeoutRequests} times \\|`, 'g'))).toHaveLength(1);
  });

  // The bounds the enumeration above holds every call to, and reaches.
  it('the bounds of every call, whatever mix of failures it meets', () => {
    expectReadmeToState(
      `makes at most ${requests} requests, waits at most ${waited} seconds in all ` +
        `(${Math.floor(waited / 60)} minutes ${waited % 60} seconds), and meets at most ` +
        `${timeoutRequests} request timeouts`
    );
  });

  it('what onRetry is told is allowed', () => {
    expectReadmeToState(
      `\`maxAttempts\` (the most retries a call makes: ${RETRY_BACKOFFS_MS.length})`
    );
  });
});
