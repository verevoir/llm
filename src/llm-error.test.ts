import { describe, it, expect } from 'vitest';
// The real SDKs, unmocked: the classifier is only worth anything if it
// reads the shapes they actually throw. (Tests may import an SDK; the core
// under test does not.)
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError as GoogleApiError } from '@google/genai';
import { EmptyResponseError, classifyLlmError, type LlmErrorKind } from './index.js';
import {
  CLAUDE_CLI_IDLE_TIMEOUT_CODE,
  CLAUDE_CLI_SESSION_TURN_TIMEOUT_CODE,
} from './claude-cli/index.js';

/** An error shaped like the ones every SDK here throws for an HTTP failure. */
function withStatus(status: unknown): Error {
  return Object.assign(new Error('provider said something'), { status });
}

/** Just the kind, for the tables below that pin one recognition rule each. */
function kindOf(err: unknown): LlmErrorKind {
  return classifyLlmError(err).kind;
}

describe('classifyLlmError — what it returns', () => {
  // One row per kind, each reached through an error that classifies as it,
  // with whether a later attempt may succeed. Spelled out rather than
  // derived, so a change to either is a deliberate edit here too.
  const rows: [LlmErrorKind, unknown, boolean][] = [
    ['authentication', withStatus(401), false],
    ['permission', withStatus(403), false],
    ['rate-limited', withStatus(429), true],
    ['overloaded', withStatus(529), true],
    ['unavailable', withStatus(500), true],
    ['invalid-request', withStatus(400), false],
    ['timeout', withStatus(408), true],
    ['empty-response', new EmptyResponseError('x.chat: response had no text content'), false],
    ['other', new Error('boom'), false],
  ];

  it.each(rows)('%s is returned as exactly { kind, retryable }', (kind, err, retryable) => {
    expect(classifyLlmError(err)).toEqual({ kind, retryable });
  });

  it('returns a plain object, not an Error', () => {
    const failure = classifyLlmError(withStatus(429));
    expect(failure).not.toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(failure)).toBe(Object.prototype);
  });

  it('only reads the error: it comes back the same object, with the same fields', () => {
    const err = withStatus(429);
    const before = { ...err, message: err.message, name: err.name, stack: err.stack };
    classifyLlmError(err);
    expect({ ...err, message: err.message, name: err.name, stack: err.stack }).toEqual(before);
    expect('cause' in err).toBe(false);
  });
});

describe('EmptyResponseError', () => {
  it('is an Error that reads exactly as the plain Error it replaces', () => {
    const err = new EmptyResponseError('p.chat: response had no text content (finishReason=x)');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('p.chat: response had no text content (finishReason=x)');
    expect(err.name).toBe('Error');
    expect(String(err)).toBe('Error: p.chat: response had no text content (finishReason=x)');
    expect(Object.keys(err)).toEqual([]);
  });

  it('is classified by its class, not its message: any message, even an empty one', () => {
    expect(classifyLlmError(new EmptyResponseError(''))).toEqual({
      kind: 'empty-response',
      retryable: false,
    });
  });

  it('a plain Error with the very same message is not empty-response', () => {
    expect(kindOf(new Error('openai.chat: response had no text content (status=incomplete)'))).toBe(
      'other'
    );
  });
});

describe('classifyLlmError — the claude-cli timeouts, by their code', () => {
  it('the idle timeout code is timeout, retryable', () => {
    const err = Object.assign(new Error('claude CLI produced no output for 150ms'), {
      code: CLAUDE_CLI_IDLE_TIMEOUT_CODE,
      timeoutMs: 150,
    });
    expect(classifyLlmError(err)).toEqual({ kind: 'timeout', retryable: true });
  });

  it('the held-session turn timeout code is timeout, retryable', () => {
    const err = Object.assign(new Error('x'), { code: CLAUDE_CLI_SESSION_TURN_TIMEOUT_CODE });
    expect(classifyLlmError(err)).toEqual({ kind: 'timeout', retryable: true });
  });

  it('the codes are the strings the adapter documents', () => {
    expect(CLAUDE_CLI_IDLE_TIMEOUT_CODE).toBe('CLAUDE_CLI_IDLE_TIMEOUT');
    expect(CLAUDE_CLI_SESSION_TURN_TIMEOUT_CODE).toBe('CLAUDE_CLI_SESSION_TURN_TIMEOUT');
  });

  it.each([
    ['any other code', 'ENOENT'],
    ['a code that merely contains one', 'CLAUDE_CLI_IDLE_TIMEOUT_X'],
    ['a non-string code', 408],
    ['an object that stringifies to one', { toString: () => 'CLAUDE_CLI_IDLE_TIMEOUT' }],
  ])('%s is other', (_label, code) => {
    expect(kindOf(Object.assign(new Error('x'), { code }))).toBe('other');
  });

  it('every other claude-cli failure — free text and nothing else — is other', () => {
    expect(
      kindOf(new Error('claude -p exited with code 1: Not logged in · Please run /login'))
    ).toBe('other');
    expect(kindOf(new Error('claude-cli: session abc timed out after 600000ms waiting'))).toBe(
      'other'
    );
  });
});

describe('classifyLlmError — by HTTP status', () => {
  // Every named status, and the numbers either side of each, plus both
  // ends of the two ranges and the numbers just outside them.
  const rows: [number, LlmErrorKind][] = [
    [399, 'other'],
    [400, 'invalid-request'],
    [401, 'authentication'],
    [402, 'invalid-request'],
    [403, 'permission'],
    [404, 'invalid-request'],
    [407, 'invalid-request'],
    [408, 'timeout'],
    [409, 'invalid-request'],
    [422, 'invalid-request'],
    [428, 'invalid-request'],
    [429, 'rate-limited'],
    [430, 'invalid-request'],
    [499, 'invalid-request'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [504, 'unavailable'],
    [528, 'unavailable'],
    [529, 'overloaded'],
    [530, 'unavailable'],
    [599, 'unavailable'],
    [600, 'other'],
  ];
  it.each(rows)('status %i is %s', (status, kind) => {
    expect(kindOf(withStatus(status))).toBe(kind);
  });

  it.each([200, 302, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'a numeric status that is no HTTP failure (%s) identifies nothing: other',
    (status) => {
      expect(kindOf(withStatus(status))).toBe('other');
    }
  );

  it.each([
    ['a numeric string', '429'],
    ['a status name', 'RESOURCE_EXHAUSTED'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { code: 429 }],
    ['a boolean', true],
  ])('a non-numeric status (%s) is never coerced: other', (_label, status) => {
    expect(kindOf(withStatus(status))).toBe('other');
  });

  it('reads the status of a plain object, not only of an Error', () => {
    expect(kindOf({ status: 429 })).toBe('rate-limited');
  });
});

describe('classifyLlmError — by provider error type, when there is no usable status', () => {
  const rows: [string, LlmErrorKind][] = [
    ['overloaded_error', 'overloaded'],
    ['rate_limit_error', 'rate-limited'],
    ['api_error', 'unavailable'],
    ['timeout_error', 'timeout'],
  ];
  it.each(rows)('type %s is %s', (type, kind) => {
    expect(kindOf(Object.assign(new Error('x'), { status: undefined, type }))).toBe(kind);
  });

  it('an unknown type is other', () => {
    expect(kindOf(Object.assign(new Error('x'), { type: 'brand_new_error' }))).toBe('other');
  });

  it('a type that merely names an Object.prototype member is other, not that member', () => {
    expect(kindOf(Object.assign(new Error('x'), { type: 'toString' }))).toBe('other');
  });

  it('a non-string type is never coerced: other', () => {
    expect(kindOf(Object.assign(new Error('x'), { type: 529 }))).toBe('other');
    const stringifiesToAKnownType = { toString: () => 'overloaded_error' };
    expect(kindOf(Object.assign(new Error('x'), { type: stringifiesToAKnownType }))).toBe('other');
  });

  it('a failing status wins over the type', () => {
    expect(kindOf(Object.assign(new Error('x'), { status: 400, type: 'overloaded_error' }))).toBe(
      'invalid-request'
    );
  });

  it('the type is still read when the status is a number that identifies nothing', () => {
    expect(kindOf(Object.assign(new Error('x'), { status: 200, type: 'overloaded_error' }))).toBe(
      'overloaded'
    );
  });
});

describe('classifyLlmError — by class name, for a failure that never got a response', () => {
  it('APIConnectionTimeoutError is timeout', () => {
    class APIConnectionTimeoutError extends Error {}
    expect(kindOf(new APIConnectionTimeoutError('Request timed out.'))).toBe('timeout');
  });

  it('APIConnectionError is unavailable', () => {
    class APIConnectionError extends Error {}
    expect(kindOf(new APIConnectionError('Connection error.'))).toBe('unavailable');
  });

  it('any other class is other', () => {
    class SomethingElseError extends Error {}
    expect(kindOf(new SomethingElseError('x'))).toBe('other');
  });

  it('a class that merely shares a name with an Object.prototype member is other', () => {
    class hasOwnProperty extends Error {}
    expect(kindOf(new hasOwnProperty('x'))).toBe('other');
  });

  it('an object with no constructor at all is other', () => {
    expect(kindOf(Object.create(null))).toBe('other');
  });
});

describe('classifyLlmError — unknown shapes are other', () => {
  it.each([
    ['a plain Error', new Error('boom')],
    ['a TypeError (what a failed fetch throws)', new TypeError('fetch failed')],
    ['a string', 'boom'],
    ['a number', 503],
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('%s', (_label, thrown) => {
    expect(classifyLlmError(thrown)).toEqual({ kind: 'other', retryable: false });
  });

  it('never reads the message: a message that looks like a status, an error type or a code is still other', () => {
    expect(
      kindOf(new Error('429 rate_limit_error overloaded_error 529 CLAUDE_CLI_IDLE_TIMEOUT'))
    ).toBe('other');
  });
});

describe('classifyLlmError — the errors the real SDKs construct', () => {
  const headers = new Headers();

  it.each([
    [400, 'invalid-request'],
    [401, 'authentication'],
    [403, 'permission'],
    [404, 'invalid-request'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
    [529, 'overloaded'],
  ] as [number, LlmErrorKind][])('Anthropic APIError.generate(%i) is %s', (status, kind) => {
    const err = Anthropic.APIError.generate(status, { type: 'error' }, 'msg', headers);
    expect(kindOf(err)).toBe(kind);
  });

  it('an Anthropic mid-stream error event (no status, a type) is recognised by its type', () => {
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    // Exactly how the SDK's stream reader constructs it.
    const err = new Anthropic.APIError(undefined, body, undefined, headers, 'overloaded_error');
    expect(err.status).toBeUndefined();
    expect(kindOf(err)).toBe('overloaded');
  });

  it('Anthropic connection failures are recognised by class name', () => {
    expect(kindOf(new Anthropic.APIConnectionTimeoutError())).toBe('timeout');
    expect(kindOf(new Anthropic.APIConnectionError({ message: 'x' }))).toBe('unavailable');
  });

  it.each([
    [400, 'invalid-request'],
    [401, 'authentication'],
    [403, 'permission'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
  ] as [number, LlmErrorKind][])('OpenAI APIError.generate(%i) is %s', (status, kind) => {
    const err = OpenAI.APIError.generate(status, { message: 'msg' }, 'msg', headers);
    expect(kindOf(err)).toBe(kind);
  });

  it('OpenAI connection failures are recognised by class name', () => {
    expect(kindOf(new OpenAI.APIConnectionTimeoutError())).toBe('timeout');
    expect(kindOf(new OpenAI.APIConnectionError({ message: 'x' }))).toBe('unavailable');
  });

  it.each([
    [400, 'invalid-request'],
    [401, 'authentication'],
    [403, 'permission'],
    [429, 'rate-limited'],
    [503, 'unavailable'],
  ] as [number, LlmErrorKind][])('Google ApiError with status %i is %s', (status, kind) => {
    expect(kindOf(new GoogleApiError({ message: 'msg', status }))).toBe(kind);
  });
});
