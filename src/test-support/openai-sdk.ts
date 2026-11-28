/**
 * A fake of the `openai` SDK for tests that mock the module:
 *
 *   vi.mock('openai', () => import('../test-support/openai-sdk.js'));
 *
 * The fake client records its constructor options in `openaiCtor` and answers
 * both APIs the adapters call: `chat.completions.create` with
 * `chatCompletionsCreate` (DeepSeek, the OpenAI-compatible factory) and
 * `responses.create` with `responsesCreate` (`/openai`). Vitest gives each
 * test file its own copy of this module.
 *
 * The build leaves this directory out (`tsconfig.build.json`), so nothing here
 * is published.
 */

import { vi } from 'vitest';

export const chatCompletionsCreate = vi.fn();
export const responsesCreate = vi.fn();
export const openaiCtor = vi.fn();

export default class OpenAI {
  chat = { completions: { create: chatCompletionsCreate } };
  responses = { create: responsesCreate };
  constructor(opts: unknown) {
    openaiCtor(opts);
  }
}

/** An object of the keys whose value is defined. */
function defined(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
}

// ── Chat Completions ─────────────────────────────────────────────────────

/** One `tool_calls` entry of a Chat Completions message. */
export const toolCall = (name: string, args: string, id = 'c1') => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

export interface CompletionFake {
  content: string;
  /** Left out, the choice has no `finish_reason` key. */
  finishReason?: string;
  /** Left out, the message has no `tool_calls` key. */
  toolCalls?: unknown[];
  /** Left out, the reply has no `usage` key. */
  usage?: Record<string, unknown>;
  id?: string;
  model?: string;
}

/** A Chat Completions reply with one choice. Only the fields given are set. */
export function completion(c: CompletionFake): Record<string, unknown> {
  return defined({
    id: c.id,
    model: c.model,
    choices: [
      {
        message: defined({ content: c.content, tool_calls: c.toolCalls }),
        finish_reason: c.finishReason,
      },
    ],
    usage: c.usage,
  });
}

/** A text reply with an empty `tool_calls`, finishing on `stop`. */
export const textCompletion = (
  content: string,
  usage: Record<string, unknown> = { prompt_tokens: 12, completion_tokens: 8 }
) => completion({ content, toolCalls: [], finishReason: 'stop', usage });

/** A reply that calls one tool, `c1`, finishing on `tool_calls`. */
export const toolCallCompletion = (
  name = 'record',
  args = '{"x":1}',
  usage: Record<string, unknown> = { prompt_tokens: 10, completion_tokens: 5 }
) =>
  completion({
    content: '',
    toolCalls: [toolCall(name, args)],
    finishReason: 'tool_calls',
    usage,
  });

// ── Responses API ────────────────────────────────────────────────────────

export interface ResponseFake {
  outputText: string;
  /** Left out, the reply has no `status` key. */
  status?: string;
  /** Left out, the reply has no `usage` key. */
  usage?: Record<string, unknown>;
  /** Left out, the reply has no `incomplete_details` key. */
  incompleteDetails?: Record<string, unknown> | null;
  id?: string;
  model?: string;
}

/** A Responses API reply. Only the fields given are set. */
export function response(r: ResponseFake): Record<string, unknown> {
  return defined({
    id: r.id,
    model: r.model,
    output_text: r.outputText,
    status: r.status,
    incomplete_details: r.incompleteDetails,
    usage: r.usage,
  });
}
