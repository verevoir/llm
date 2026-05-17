/**
 * Minimal example: a single LLM call against Anthropic, with token
 * usage printed.
 *
 * Run:
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/anthropic-chat.ts
 *
 * Requires `@anthropic-ai/sdk` to be installed alongside `@verevoir/llm`
 * (it's the optional peer dependency for this subpath).
 */

import { anthropic } from '@verevoir/llm/anthropic';
import { estimateCostUSD, formatTokensCompact, sumUsages } from '@verevoir/llm';

async function main(): Promise<void> {
  const reply = await anthropic.chat({
    systemPrompt: 'You are a concise assistant. One short sentence answers only.',
    turns: [{ role: 'user', content: 'What is the capital of France?' }],
    // apiKey is read from ANTHROPIC_API_KEY when omitted.
    modelClass: 'extraction', // Quick, predictable; cheaper than reasoning.
  });

  console.log('Reply:', reply.content);
  console.log('Stop reason:', reply.stopReason);
  console.log('Tokens:', reply.usage);

  const rollup = sumUsages([
    {
      [reply.usage.model]: {
        in:
          reply.usage.inputTokens +
          reply.usage.cacheCreationInputTokens +
          reply.usage.cacheReadInputTokens,
        out: reply.usage.outputTokens,
      },
    },
  ]);

  const total = rollup[reply.usage.model].in + rollup[reply.usage.model].out;
  const costUSD = estimateCostUSD(rollup, anthropic.rates);

  console.log(`Total: ${formatTokensCompact(total)} tokens`);
  console.log(`Estimated cost (worst case): $${costUSD.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
