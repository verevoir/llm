/**
 * Minimal example: a single LLM call against Anthropic, with token usage
 * printed and priced via `createPriceBook` / `book.costOf(...)` — the
 * successor to the deprecated `estimateCostUSD` (operator decision,
 * 2026-10-22; see CHANGELOG.md).
 *
 * Run:
 *
 *   ANTHROPIC_API_KEY=sk-... npx tsx examples/anthropic-chat.ts
 *
 * Requires `@anthropic-ai/sdk` to be installed alongside `@verevoir/llm`
 * (it's the optional peer dependency for this subpath).
 */

import { anthropic } from '@verevoir/llm/anthropic';
import { createPriceBook, formatTokensCompact } from '@verevoir/llm';

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

  // No `.start()`: this book never fetches LiteLLM's live prices and prices
  // every call from the bundled `PRICING_SNAPSHOT` fallback alone — right for
  // a short-lived example process that has no use for a background timer.
  const book = createPriceBook({ fetch });

  const usage = {
    provider: reply.usage.provider,
    model: reply.usage.model,
    inputTokens: reply.usage.inputTokens,
    outputTokens: reply.usage.outputTokens,
    cacheReadInputTokens: reply.usage.cacheReadInputTokens,
    cacheCreationInputTokens: reply.usage.cacheCreationInputTokens,
  };

  const total =
    usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  console.log(`Total: ${formatTokensCompact(total)} tokens`);

  const cost = book.costOf(usage);
  if ('unpriced' in cost) {
    // An unmatched model is always reported as unpriced, never priced at $0
    // — unlike the deprecated `estimateCostUSD`, which silently contributed
    // $0 for a model its rates table didn't cover.
    console.log(`Estimated cost: unpriced (${cost.unpriced})`);
  } else {
    const usd = cost.usdMicros / 1_000_000;
    console.log(`Estimated cost: $${usd.toFixed(6)}${cost.complete ? '' : ' (partial)'}`);
  }

  // Demonstrate the unpriced case directly: a model id the book has never
  // heard of reports `unpriced`, not a silent $0.
  const unknown = book.costOf({ ...usage, model: 'not-a-real-model-id' });
  console.log('Unknown-model cost (should be unpriced, never $0):', unknown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
