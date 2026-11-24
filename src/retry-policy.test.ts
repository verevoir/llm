/**
 * The retry policy on its own: what it reads off an error, held against the
 * real SDK's error classes and against `classifyLlmError`. What it does to the
 * number of requests is counted in `openai-sdk-single-retry.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { classifyLlmError } from './index.js';
import { RETRY_BACKOFFS_MS, retriableReason } from './retry-policy.js';

/** The error the SDK builds for a response of this status and these headers. */
const sdkError = (status: number, headers: Record<string, string> = {}) =>
  APIError.generate(status, { error: { message: 'refused' } }, undefined, new Headers(headers));

describe('the retry policy of the adapters that send through the openai SDK', () => {
  it('waits 5, 30 and 120 seconds: three retries', () => {
    expect(RETRY_BACKOFFS_MS).toEqual([5_000, 30_000, 120_000]);
  });

  it.each([408, 409, 429, 500, 501, 502, 503, 504, 529, 599])('retries a %i', (status) => {
    expect(retriableReason(sdkError(status), 'P')).toMatch(new RegExp(`^P .*\\(${status}\\)$`));
  });

  it.each([400, 401, 403, 404, 422, 499])('does not retry a %i', (status) => {
    expect(retriableReason(sdkError(status), 'P')).toBeNull();
  });

  it('keeps the reasons it gave before for 429, 500, 502 and 503', () => {
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

  it('still retries an error whose message names a 429, 500, 502 or 503, and no other', () => {
    expect(retriableReason(new Error('upstream said 503'), 'P')).toBe(
      'P service unavailable (503)'
    );
    expect(retriableReason(new Error('internal_server_error'), 'P')).toBe('P internal error (500)');
    expect(retriableReason(new Error('rate limit reached'), 'P')).toBe('P rate-limited (429)');
    expect(retriableReason(new Error('bad gateway'), 'P')).toBe('P bad gateway (502)');
    expect(retriableReason(new Error('504 gateway timeout'), 'P')).toBeNull();
  });

  // Older than the wider policy and left as it was: the message is read
  // whatever the status, so a 400 that mentions a retried status is retried.
  it('retries a 400 whose message names a retried status, as it did before', () => {
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
  // agree on every status but 409: retried here, as the SDK did, though
  // `classifyLlmError` calls it `invalid-request`.
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
