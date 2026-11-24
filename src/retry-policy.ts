/**
 * @verevoir/llm — the retry policy of the adapters that send through the
 * `openai` SDK (`/openai`, `/deepseek`, and every adapter built by the
 * OpenAI-compatible factory). Internal: no subpath exports it.
 *
 * Those adapters build their clients with `maxRetries: 0`, so this policy is
 * the only retry a request gets. It therefore covers what the SDK's own
 * retries covered (`shouldRetry` and the connection-failure branch of
 * `makeRequest` in the SDK's `client.ts`), on this policy's own fixed waits.
 * The one thing of the SDK's it does not do is read `Retry-After`.
 *
 * SDK-free: an error is recognised by what it carries (`status`, `headers`,
 * its class name), never by `instanceof` a class of the SDK.
 */

import type { ChatRetryInfo } from './index.js';

/** The wait before each retry. Its length is the number of retries: a request
 * is sent at most `1 + RETRY_BACKOFFS_MS.length` times. */
export const RETRY_BACKOFFS_MS: readonly number[] = [
  5_000, //   5 sec
  30_000, //  30 sec
  120_000, // 2 min
];

/** The SDK's classes for a request that got no HTTP response, by name: the
 * same test `classifyLlmError` makes (`ERROR_CLASS_KINDS` in `./index.ts`). */
const CONNECTION_FAILURE_REASONS: Readonly<Record<string, string>> = {
  APIConnectionTimeoutError: 'request timed out',
  APIConnectionError: 'connection failed',
};

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
 * 4. An error whose message names a 429, 500, 502 or 503. This is the rule the
 *    policy had before it read anything else, kept as it was.
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

  // `constructor` is absent on a null-prototype object; no row matches then.
  const className = (err as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof className === 'string' && Object.hasOwn(CONNECTION_FAILURE_REASONS, className)) {
    return `${label} ${CONNECTION_FAILURE_REASONS[className]}`;
  }

  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (/\b503\b|service[_ ]unavailable/i.test(message)) return `${label} ${STATUS_REASONS[503]}`;
  if (/\b500\b|internal_server_error/i.test(message)) return `${label} ${STATUS_REASONS[500]}`;
  if (/\b429\b|rate[_ ]limit/i.test(message)) return `${label} ${STATUS_REASONS[429]}`;
  if (/\b502\b|bad[_ ]gateway/i.test(message)) return `${label} ${STATUS_REASONS[502]}`;
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make `call`, and make it again after each wait of
 * {@link RETRY_BACKOFFS_MS} while it fails with an error
 * {@link retriableReason} retries. `onRetry` is told before each wait; what
 * it throws is logged and does not stop the retry. The last error is thrown.
 */
export async function callWithRetries<T>(
  call: () => Promise<T>,
  label: string,
  onRetry?: (info: ChatRetryInfo) => Promise<void>
): Promise<T> {
  for (let i = 0; i <= RETRY_BACKOFFS_MS.length; i++) {
    try {
      return await call();
    } catch (err) {
      const reason = retriableReason(err, label);
      if (!reason) throw err;
      if (i === RETRY_BACKOFFS_MS.length) throw err;
      const delayMs = RETRY_BACKOFFS_MS[i];
      if (onRetry) {
        try {
          await onRetry({
            attempt: i + 1,
            maxAttempts: RETRY_BACKOFFS_MS.length,
            delayMs,
            reason,
          });
        } catch (notifyErr) {
          console.warn('callWithRetries: onRetry callback threw', notifyErr);
        }
      }
      await delay(delayMs);
    }
  }
  throw new Error('callWithRetries: exited loop without return or throw');
}
