/**
 * @verevoir/llm — the retry policy of the adapters that send through the
 * `openai` SDK (`/openai`, `/deepseek`, and every adapter built by the
 * OpenAI-compatible factory). Internal: no subpath exports it.
 *
 * Those adapters build their clients with `maxRetries: 0`, so this policy is
 * the only retry a request gets. It retries what the SDK's own rule retries
 * (`shouldRetry` and the connection-failure branch of `makeRequest` in the
 * SDK's `client.ts`), on this policy's own fixed waits. Unlike the SDK's rule
 * it does not read `Retry-After`.
 *
 * A caller's `AbortSignal` ends the policy: see {@link callWithRetries}.
 *
 * SDK-free: an error is recognised by what it carries (`status`, `headers`,
 * its class name), never by `instanceof` a class of the SDK.
 */

import type { ChatRetryInfo } from './index.js';

/**
 * The wait before each retry. Its length is the number of retries: a request
 * is sent at most `1 + RETRY_BACKOFFS_MS.length` times.
 *
 * **Where the figures come from.** They are inherited, not derived here. The
 * same list stands in `src/anthropic/adapter.ts`, whose comment gives its
 * purpose: to ride out a provider outage while the caller narrates the wait,
 * on a total "comfortably under typical serverless request timeouts".
 * `CHANGELOG.md` 0.16.0 records that the list is the first three steps of a
 * longer one, cut so that the retries stay bounded under a caller that
 * retries too. That is all the repository records: the total (155 seconds)
 * has a stated reason, and no record exists of why the steps are 5, 30 and
 * 120 seconds rather than any others.
 *
 * **What each step does** (a reading of the list as it stands, not a recorded
 * derivation):
 *
 * - 5 s: long enough for a momentary fault (a dropped connection, a restart,
 *   one 5xx) to clear. Shorter, and the retry lands in the same fault and is
 *   spent; longer, and every momentary fault costs the caller that much more.
 * - 30 s: with the first, 35 s into a rate limit or an overload. Shorter, and
 *   all three retries can fall inside one rate-limit window; longer, and a
 *   provider that recovered in seconds is still waited on.
 * - 120 s: the last attempt, 155 s after the first failure. Shorter, and an
 *   outage of a minute or two outlasts the policy; longer, and the total
 *   passes what a caller's own request handler allows, which is the one bound
 *   the record gives.
 *
 * **Not tuned for everything they are applied to.** The list is applied as it
 * stands to every status {@link retriableReason} retries and to connection
 * failures. The record above is about outages; for connection failures and
 * for 408, 409 and the wider 5xx statuses the `openai` SDK's own rule waits
 * between half a second and eight seconds, and these figures have not been
 * tuned for them. A request timeout is retried too, but does not use the
 * list: see {@link TIMEOUT_RETRIES}.
 *
 * **What would say they are wrong.** `onRetry` is given `attempt`, `delayMs`
 * and `reason`. If calls whose reason is "connection failed" nearly always
 * succeed after `attempt` 1, the 5-second first wait is costing seconds where
 * a fraction of one would do. If calls whose reason is "rate-limited (429)"
 * routinely reach `attempt` 3 and still fail, the waits are too short for
 * that provider's window.
 */
export const RETRY_BACKOFFS_MS: readonly number[] = [
  5_000, //   5 sec
  30_000, //  30 sec
  120_000, // 2 min
];

/**
 * How many times a request that timed out (the SDK's
 * `APIConnectionTimeoutError`) is retried, with no wait: the count of the
 * SDK's own rule. A timeout has already spent the SDK's request timeout (10
 * minutes by default) without an answer, so a wait adds nothing, and each
 * retry may spend as long again: three requests, 30 minutes at most.
 */
export const TIMEOUT_RETRIES = 2;

const TIMEOUT_CLASS = 'APIConnectionTimeoutError';

/** The SDK's classes for a request that got no HTTP response, by name: the
 * same test `classifyLlmError` makes (`ERROR_CLASS_KINDS` in `./index.ts`). */
const CONNECTION_FAILURE_REASONS: Readonly<Record<string, string>> = {
  [TIMEOUT_CLASS]: 'request timed out',
  APIConnectionError: 'connection failed',
};

/** The name of the error's class, or `undefined`: a null-prototype object has
 * no `constructor`. */
function classNameOf(err: object): string | undefined {
  const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' ? name : undefined;
}

/** The reason given for each retried status that has a name of its own. */
const STATUS_REASONS: Readonly<Record<number, string>> = {
  408: 'request timeout (408)',
  409: 'conflict (409)',
  429: 'rate-limited (429)',
  500: 'internal error (500)',
  502: 'bad gateway (502)',
  503: 'service unavailable (503)',
  504: 'gateway timeout (504)',
};

/** The response's `x-should-retry` header, if the error carries the response's
 * headers (the SDK's `APIError.headers` is a `Headers`). */
function shouldRetryHeader(err: object): string | null {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers || typeof (headers as Headers).get !== 'function') return null;
  try {
    return (headers as Headers).get('x-should-retry');
  } catch {
    return null;
  }
}

/**
 * Why `err` is retried, or `null` when it is not. `label` is the provider's
 * name as the reason should show it. First match wins:
 *
 * 1. A response with `x-should-retry: false` is never retried, and one with
 *    `x-should-retry: true` always is, whatever its status (the SDK's rule;
 *    any other value of the header is ignored).
 * 2. A numeric `status` of 408, 409, 429, or 500 and above is retried.
 * 3. A connection failure or a request timeout, by the SDK's class name.
 * 4. An error whose message names a 429, 500, 502 or 503, whatever its
 *    status: one of these can be reported in the text of an error that
 *    carries no status, or a different one.
 */
export function retriableReason(err: unknown, label: string): string | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as { status?: unknown; message?: unknown };

  const header = shouldRetryHeader(err);
  if (header === 'false') return null;
  const status = typeof candidate.status === 'number' ? candidate.status : undefined;
  if (status !== undefined) {
    if (Object.hasOwn(STATUS_REASONS, status)) return `${label} ${STATUS_REASONS[status]}`;
    if (status >= 500) return `${label} server error (${status})`;
  }
  if (header === 'true') {
    return `${label} asked for a retry (x-should-retry${status === undefined ? '' : `, ${status}`})`;
  }

  const className = classNameOf(err);
  if (className !== undefined && Object.hasOwn(CONNECTION_FAILURE_REASONS, className)) {
    return `${label} ${CONNECTION_FAILURE_REASONS[className]}`;
  }

  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (/\b503\b|service[_ ]unavailable/i.test(message)) return `${label} ${STATUS_REASONS[503]}`;
  if (/\b500\b|internal_server_error/i.test(message)) return `${label} ${STATUS_REASONS[500]}`;
  if (/\b429\b|rate[_ ]limit/i.test(message)) return `${label} ${STATUS_REASONS[429]}`;
  if (/\b502\b|bad[_ ]gateway/i.test(message)) return `${label} ${STATUS_REASONS[502]}`;
  return null;
}

/**
 * Throw for an aborted `signal`: its `reason` when that is an `Error` (an
 * `AbortController.abort()` with no argument gives a `DOMException` named
 * `AbortError`), an `Error` of the reason's text when it is anything else,
 * and a generic `AbortError` when there is none. Does nothing when there is
 * no signal or it is not aborted. `classifyLlmError` calls each of these
 * `other`, not retryable.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  if (signal.reason !== undefined) throw new Error(String(signal.reason));
  throw new DOMException('Aborted', 'AbortError');
}

/** Wait `ms`, or until `signal` aborts: the wait then ends at once, its timer
 * cleared, and rejects with what {@link throwIfAborted} throws. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      try {
        throwIfAborted(signal);
      } catch (abortErr) {
        reject(abortErr);
      }
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Make `call`, and make it again while it fails with an error
 * {@link retriableReason} retries: after each wait of
 * {@link RETRY_BACKOFFS_MS}, or, for a request timeout, at once and only
 * while fewer than {@link TIMEOUT_RETRIES} retries have been made. `onRetry`
 * is told before each wait, with the retries allowed for that failure as
 * `maxAttempts`; what it throws is logged and does not stop the retry. The
 * last error is thrown.
 *
 * `signal` is the caller's `AbortSignal`. Once it is aborted no request is
 * started: an attempt is not made, a wait in progress ends at once, and a
 * request that fails in a retried way is not retried and `onRetry` is not
 * told. Each of these throws what {@link throwIfAborted} throws. The signal
 * is not handed to `call`: a request already sent runs to its own end, and
 * its result is returned if it succeeds.
 */
export async function callWithRetries<T>(
  call: () => Promise<T>,
  label: string,
  onRetry?: (info: ChatRetryInfo) => Promise<void>,
  signal?: AbortSignal
): Promise<T> {
  for (let i = 0; ; i++) {
    throwIfAborted(signal);
    try {
      return await call();
    } catch (err) {
      const reason = retriableReason(err, label);
      if (!reason) throw err;
      const timedOut = classNameOf(err as object) === TIMEOUT_CLASS;
      const maxAttempts = timedOut ? TIMEOUT_RETRIES : RETRY_BACKOFFS_MS.length;
      if (i >= maxAttempts) throw err;
      throwIfAborted(signal);
      const delayMs = timedOut ? 0 : RETRY_BACKOFFS_MS[i];
      if (onRetry) {
        try {
          await onRetry({ attempt: i + 1, maxAttempts, delayMs, reason });
        } catch (notifyErr) {
          console.warn('callWithRetries: onRetry callback threw', notifyErr);
        }
      }
      await delay(delayMs, signal);
    }
  }
}
