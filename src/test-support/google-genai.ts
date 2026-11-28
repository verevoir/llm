/**
 * A fake of `@google/genai` for tests that mock the module:
 *
 *   vi.mock('@google/genai', () => import('../test-support/google-genai.js'));
 *
 * The fake client records its constructor options in `genaiCtor`, answers
 * `models.generateContent` with `generateContent`, and reports the `vertexai`
 * that `genaiClient.vertexai` holds when it is built (false unless a test sets
 * it), as the SDK decides it from its options and environment. Vitest gives
 * each test file its own copy of this module.
 *
 * The build leaves this directory out (`tsconfig.build.json`), so nothing here
 * is published.
 */

import { vi } from 'vitest';

export const generateContent = vi.fn();
export const genaiCtor = vi.fn();
export const genaiClient = { vertexai: false };

export class GoogleGenAI {
  models = { generateContent };
  readonly vertexai = genaiClient.vertexai;
  constructor(opts: unknown) {
    genaiCtor(opts);
  }
}

/** An object of the keys whose value is defined. */
function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

export interface GeminiFake {
  text: string;
  finishReason?: string;
  /** The candidate's `content.parts`; left out, the candidate has no `content`. */
  parts?: unknown[];
  /** Left out, the reply has no `functionCalls` key. */
  functionCalls?: unknown[];
  /** Left out, the reply has no `usageMetadata` key. */
  usage?: Record<string, unknown>;
}

/** A `generateContent` reply with one candidate. Only the fields given are set. */
export function geminiReply(g: GeminiFake): Record<string, unknown> {
  return defined({
    functionCalls: g.functionCalls,
    candidates: [
      defined({
        content: g.parts === undefined ? undefined : { role: 'model', parts: g.parts },
        finishReason: g.finishReason,
      }),
    ],
    usageMetadata: g.usage,
    text: g.text,
  });
}
