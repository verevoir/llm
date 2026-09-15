import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LLM_CALL_TIMEOUT_MS,
  LLM_TIMEOUT_CODE,
  resolveTimeoutMs,
  makeTimeoutError,
  withTimeoutSignal,
  runWithTimeoutContract,
  TIMEOUT_TEARDOWN_CONFIRMED,
} from './index.js';

// Core primitives behind the cross-route timeout contract (see index.ts's
// own "Timeout contract" section header for the full design). These tests
// exercise the primitives directly; src/anthropic/chat.test.ts covers the
// bespoke, teardown-confirmed route end-to-end (including asserting the
// live SDK call's signal is genuinely aborted — the behavioural test, not
// merely a construction assertion), and src/google/chat.test.ts covers the
// generic-wrap-only boundary on a route with no bespoke teardown yet.

afterEach(() => vi.useRealTimers());

describe('resolveTimeoutMs', () => {
  it('defaults to LLM_CALL_TIMEOUT_MS when the caller supplies nothing', () => {
    expect(resolveTimeoutMs(undefined)).toBe(LLM_CALL_TIMEOUT_MS);
  });

  it('honours a finite, positive override exactly as given — never clamped', () => {
    expect(resolveTimeoutMs(999)).toBe(999);
    expect(resolveTimeoutMs(1)).toBe(1);
    expect(resolveTimeoutMs(24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
  });

  it.each([0, -1, NaN, Infinity])(
    'refuses %s synchronously — an absurd bound is refused, never silently substituted',
    (bad) => {
      expect(() => resolveTimeoutMs(bad)).toThrow(/finite number greater than 0/);
    }
  );
});

describe('makeTimeoutError', () => {
  it('carries code and timeoutMs as own, enumerable fields — a caller matches on the field, never the message', () => {
    const err = makeTimeoutError(1234);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(LLM_TIMEOUT_CODE);
    expect(err.timeoutMs).toBe(1234);
    expect(Object.keys(err)).toEqual(expect.arrayContaining(['code', 'timeoutMs']));
  });
});

describe('withTimeoutSignal — the expensive, per-route half', () => {
  it('fires the combined signal with a LLM_TIMEOUT_CODE-shaped reason once timeoutMs elapses', async () => {
    vi.useFakeTimers();
    const { signal, cleanup } = withTimeoutSignal(50);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(51);
    expect(signal.aborted).toBe(true);
    expect((signal.reason as { code?: string })?.code).toBe(LLM_TIMEOUT_CODE);
    cleanup();
  });

  it('a caller-supplied signal firing first wins, and cleanup prevents the timer from later overriding the reason', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { signal, cleanup } = withTimeoutSignal(1000, controller.signal);
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    cleanup();
    await vi.advanceTimersByTimeAsync(1001);
    expect(signal.reason).toBe(reason); // unchanged — the cleared timer never fired
  });

  it('a signal already aborted at call time aborts the combined signal immediately, with no timer race', () => {
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    const { signal, cleanup } = withTimeoutSignal(1000, controller.signal);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe(reason);
    cleanup();
  });

  it('refuses an absurd timeoutMs synchronously, before any timer is created', () => {
    expect(() => withTimeoutSignal(0)).toThrow(/finite number greater than 0/);
    expect(() => withTimeoutSignal(Infinity)).toThrow(/finite number greater than 0/);
  });
});

describe('runWithTimeoutContract — the cheap, universal half', () => {
  it("resolves with the call's own value when it settles before the bound", async () => {
    const result = await runWithTimeoutContract(1000, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('rejects with the LLM_TIMEOUT_CODE shape when the call hangs past the bound — zero vendor-specific knowledge required', async () => {
    vi.useFakeTimers();
    const pending = runWithTimeoutContract(100, () => new Promise<never>(() => {}));
    const assertion = expect(pending).rejects.toMatchObject({
      code: LLM_TIMEOUT_CODE,
      timeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });

  it("propagates the call's own rejection unchanged when it fails before the bound", async () => {
    const boom = new Error('boom');
    await expect(
      runWithTimeoutContract(1000, async () => {
        throw boom;
      })
    ).rejects.toBe(boom);
  });
});

describe('TIMEOUT_TEARDOWN_CONFIRMED', () => {
  it('is a runtime-checkable set, not merely a compile-time type — exactly the thing a route silently missing from it would otherwise hide', () => {
    expect(TIMEOUT_TEARDOWN_CONFIRMED).toBeInstanceOf(Set);
  });

  it('lists anthropic in this release — the exemplar route with genuine teardown', () => {
    expect(TIMEOUT_TEARDOWN_CONFIRMED.has('anthropic')).toBe(true);
  });

  it("does not yet list the routes that only have the generic wrap's shape, or claude-cli (deliberately untouched this release)", () => {
    for (const notYet of ['openai', 'deepseek', 'google', 'mistral', 'samba', 'claude-cli']) {
      expect(TIMEOUT_TEARDOWN_CONFIRMED.has(notYet)).toBe(false);
    }
  });
});
