import type { ChatOptions, ChatReply, TokenUsage, ToolDef, ToolExecutor } from './index.js';

// Advisor pair (STDIO-574). A cheap executor model runs a tool loop carrying a
// `consult_advisor` tool; when it calls that tool, a stronger advisor model
// answers. The advisor GUIDES — it never certifies the work. Core stays
// SDK-free: the advisor is dependency-injected as a `chat` function, so a
// caller binds any adapter's `chat` (or its own) without this module knowing
// which provider answers.

/** One completed consult — what the executor asked, what the advisor said. */
export interface ConsultInfo {
  /** The executor's question, verbatim from the tool call. */
  question: string;
  /** The excerpt the executor attached, when it attached one. */
  context?: string;
  /** The advisor's reply text, as returned to the executor. */
  answer: string;
  /** The advisor call's usage, when the bound `chat` reported it via `onUsage`. */
  usage?: TokenUsage;
}

/** How to reach the advisor and how it should judge. */
export interface AdvisorConfig {
  /** Any adapter's `chat`, caller-bound — the advisor model behind the tool. */
  chat: (opts: ChatOptions) => Promise<ChatReply>;
  /** The bar the advisor holds — its system prompt for every consult. */
  systemPrompt: string;
  /** Override for the consult tool's name. Default `consult_advisor`. */
  toolName?: string;
  /** Override for the consult tool's description — the consult-calibration lever. */
  description?: string;
  /**
   * Consult-rate metrics hook, fired after each successful consult. Fail-soft:
   * a throw is caught and warned, never breaking the consult. NOT fired when
   * the advisor call itself fails — there is no answer to report.
   */
  onConsult?: (info: ConsultInfo) => void;
}

const DEFAULT_TOOL_NAME = 'consult_advisor';

const DEFAULT_DESCRIPTION =
  'Consult your senior advisor when you hit a decision you cannot confidently resolve: ' +
  'a design choice, whether your work meets the required practices, an ambiguous ' +
  'requirement, before an irreversible action, and before declaring the task done. ' +
  'Ask one specific question and include only the relevant excerpt.';

/**
 * Wrap a tool set + executor so the model can consult a stronger advisor.
 * Returns a NEW tools array with the consult tool appended (the input is never
 * mutated) and an executor that routes consult calls to `advisor.chat` — every
 * other tool call passes through to `executor` untouched. Pass the result to
 * any adapter's `chatWithToolLoop`.
 *
 * A tool already named like the consult tool is a programmer error: throws at
 * wrap time. A failing advisor is a runtime condition: the wrapped executor
 * returns a legible "advisor unavailable" result instead of throwing, so a
 * dead advisor never kills the work.
 */
export function withAdvisor(
  tools: ToolDef[],
  executor: ToolExecutor,
  advisor: AdvisorConfig
): { tools: ToolDef[]; executor: ToolExecutor } {
  const toolName = advisor.toolName ?? DEFAULT_TOOL_NAME;
  if (tools.some((t) => t.name === toolName)) {
    throw new Error(
      `withAdvisor: a tool named "${toolName}" already exists — rename it or set advisor.toolName`
    );
  }
  const consultTool: ToolDef = {
    name: toolName,
    description: advisor.description ?? DEFAULT_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The specific decision or uncertainty; be concrete.',
        },
        context: {
          type: 'string',
          description: 'Only the relevant excerpt, not the whole transcript.',
        },
      },
      required: ['question'],
    },
  };
  const wrapped: ToolExecutor = async (toolUse) =>
    toolUse.name === toolName ? consult(toolUse.input, advisor) : executor(toolUse);
  return { tools: [...tools, consultTool], executor: wrapped };
}

async function consult(input: Record<string, unknown>, advisor: AdvisorConfig): Promise<string> {
  const question = typeof input.question === 'string' ? input.question : '';
  const context = typeof input.context === 'string' && input.context ? input.context : undefined;
  let usage: TokenUsage | undefined;
  let reply: ChatReply;
  try {
    reply = await advisor.chat({
      systemPrompt: advisor.systemPrompt,
      turns: [{ role: 'user', content: context ? `${question}\n\n${context}` : question }],
      modelClass: 'reasoning',
      onUsage: async (u) => {
        usage = u;
      },
    });
  } catch (err) {
    // A dead advisor must not kill the work: the loop's is_error plumbing is
    // for the inner executor's throws, so return a legible result instead.
    const message = err instanceof Error ? err.message : String(err);
    return `advisor unavailable: ${message} — proceed on your own judgement and note the uncertainty`;
  }
  if (advisor.onConsult) {
    try {
      advisor.onConsult({ question, context, answer: reply.content, usage });
    } catch (err) {
      console.warn('withAdvisor: onConsult callback threw', err);
    }
  }
  return reply.content;
}
