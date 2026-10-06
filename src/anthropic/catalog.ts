/**
 * @verevoir/llm/anthropic's model catalogue — PURE DATA, no SDK import.
 *
 * Split out of `./index.ts` (STDIO — "catalog without the SDK") so a consumer
 * that only wants to RESOLVE a model term (governance's reviewer-model
 * selection, a cost display, a label lookup) never has to import
 * `@anthropic-ai/sdk` just to read this array. `./index.ts` still imports this
 * file and registers it exactly as before — nothing about `@verevoir/llm/anthropic`
 * changes for an existing consumer; this is an extraction, not a behaviour
 * change. See `../catalog.ts` for the SDK-free registration entry point this
 * file exists to serve.
 *
 * The Anthropic model catalog — the **single source of truth**. Each family
 * declares the class it serves, the concrete versioned id used for the call,
 * its pricing (at the family level), a label, and the alias / prefix rules
 * that let any version of the family normalise back to it. `models`, `rates`
 * and the labels in `./index.ts` all derive from this, so a version bump is a
 * one-line `currentId` change — and **decisions key on `provider/family`,
 * never on the version string** (the version is reporting metadata only).
 *
 * Pricing is Anthropic-published rates as of 2026-07-23; each tuple is
 * `[input_per_million_USD, output_per_million_USD]`. Refresh `rates` here when
 * Anthropic publishes new pricing — and pin the new numbers in the catalog test:
 * a stale rate is silent, and it scales every cost this system reports.
 *
 * RATES ARE PROVISIONAL FOR OPUS AND SONNET (STDIO-681). Their `currentId`s
 * moved to the Claude 5 generation so the tiers resolve to a current model; the
 * TUPLES below are still the Claude 4.x published numbers, carried over
 * UNVERIFIED. So every cost figure this system reports for opus or sonnet is an
 * estimate against the PREVIOUS generation's pricing and must not be quoted as
 * spend until the published Claude 5 rates are pinned here and in the catalog
 * test. That is exactly the defect the paragraph above describes — taken on
 * deliberately and briefly, with a card, rather than shipped as a guess wearing
 * the costume of a number.
 *
 * `currentId` being a BUILD-TIME constant is itself the deeper problem, and it
 * is what let opus sit a generation behind: a new model cannot be reached until
 * this package, then accelerator, then capabilities are each released in order.
 * Anthropic serves `GET /v1/models`, so the ids are discoverable at RUNTIME
 * against the calling credential. Pricing and `modelClass` are not — no provider
 * publishes the first, and the second is our judgement — so those stay here,
 * keyed by FAMILY, which is already how every decision keys. See STDIO-682.
 */

import type { ModelCatalogEntry, ProviderConnection } from '../index.js';

export const PROVIDER = 'anthropic';

// How to connect, as PURE DATA (env var names only) — no SDK needed to know
// these strings. `./index.ts` still calls registerProviderConnection(CONNECTION)
// itself; `../catalog.ts` also registers this so resolveModelByTerm's default
// configuredOnly:true check (isProviderConfigured) can see a real credential
// without the SDK subpath ever being imported — the catalog entries alone are
// not enough to make selection succeed, since selection filters by connection,
// not by catalog membership.
export const CONNECTION: ProviderConnection = {
  provider: PROVIDER,
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  // Why: see ProviderConnection.altKeyEnvs's own doc comment in ../index.ts.
  altKeyEnvs: ['CLAUDE_CODE_OAUTH_TOKEN'],
  baseUrlEnv: 'ANTHROPIC_BASE_URL',
};

export const CATALOG: readonly ModelCatalogEntry[] = [
  {
    provider: PROVIDER,
    family: 'opus',
    modelClass: 'reasoning',
    currentId: 'claude-opus-5-5',
    rates: [5, 25], // PROVISIONAL — Claude 4.8 pricing; see the note above.
    label: 'Opus',
    // Superseded ids stay ALIASES rather than being dropped: a transcript, a
    // ledger or a stored cost row naming claude-opus-5 (or claude-opus-4-8,
    // claude-opus-4-7) must still normalise to this family, or historical
    // data silently stops pricing and labelling.
    aliases: ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
    prefixes: ['claude-opus-'],
  },
  {
    provider: PROVIDER,
    family: 'sonnet',
    modelClass: 'drafting',
    currentId: 'claude-sonnet-5',
    rates: [3, 15], // PROVISIONAL — Claude 4.6 pricing; see the note above.
    label: 'Sonnet',
    aliases: ['claude-sonnet-4-6'],
    prefixes: ['claude-sonnet-'],
  },
  {
    provider: PROVIDER,
    family: 'haiku',
    modelClass: 'extraction',
    currentId: 'claude-haiku-4-5-20251001',
    rates: [1, 5],
    label: 'Haiku',
    aliases: ['claude-haiku-4-5'],
    prefixes: ['claude-haiku-'],
  },
];
