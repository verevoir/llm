// Deliberately does NOT import '../anthropic/index.js', '../mistral/index.js'
// or '../samba/index.js' (the real adapter subpaths, which require their SDKs)
// anywhere in this file, directly or transitively — only './catalog.js' (the
// subject under test) and './index.js' (the core, SDK-free by construction).
// That is the behaviour this whole PR exists to prove: a consumer can resolve
// a model term without ever pulling in an SDK.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveModelByTerm, normalizeModelId, modelLabel } from './index.js';
import './catalog.js';

// The real IMPORT form only — not a bare package-name mention, which these
// very files' own prose comments legitimately contain (explaining WHY they
// avoid the SDK import, by name).
const SDK_SPECIFIERS = ["from '@anthropic-ai/sdk'", "from 'openai'", "from '@google/genai'"];

describe('@verevoir/llm/catalog — resolves without the SDK', () => {
  beforeEach(() => {
    // Anthropic's real credential env, so resolveModelByTerm's default
    // `configuredOnly: true` sees the provider as configured — via the
    // CONNECTION this file's own import of './catalog.js' registered,
    // never via importing '../anthropic/index.js'.
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });

  it("resolveModelByTerm('opus') resolves via the catalog subpath alone", () => {
    const entry = resolveModelByTerm('opus');
    expect(entry).not.toBeNull();
    expect(entry?.currentId).toBe('claude-opus-5-5');
    expect(entry?.provider).toBe('anthropic');
  });

  it('normalizeModelId works for every registered family, unconditional on configuredOnly', () => {
    expect(normalizeModelId('claude-opus-5-5')).toEqual({ provider: 'anthropic', family: 'opus' });
    expect(normalizeModelId('mistral-large-latest')).toEqual({
      provider: 'mistral',
      family: 'large',
    });
    expect(normalizeModelId('Meta-Llama-3.3-70B-Instruct')).toEqual({
      provider: 'samba',
      family: 'llama-70b',
    });
  });

  it('modelLabel resolves a label for a catalogued id with no SDK import', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus');
    expect(modelLabel('mistral-large-latest')).toBe('Mistral Large');
  });

  it("resolveModelByTerm('opus') is null when the provider has no credential — the connection, not just the catalog entry, gates selection", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(resolveModelByTerm('opus')).toBeNull();
  });
});

describe('@verevoir/llm/catalog — imports no SDK (guard)', () => {
  // A literal-text guard on the files this subpath's own import graph is
  // built from: catalog.ts plus each provider's catalog.ts (never index.ts,
  // which is where the real SDK imports live). Catches a future edit that
  // accidentally pulls an SDK import into one of these files, which the
  // type system alone would not catch (an unused SDK import still compiles).
  it.each([
    'src/catalog.ts',
    'src/anthropic/catalog.ts',
    'src/mistral/catalog.ts',
    'src/samba/catalog.ts',
  ])('%s names no SDK import specifier', (relativePath) => {
    const text = readFileSync(relativePath, 'utf8');
    for (const specifier of SDK_SPECIFIERS) {
      expect(text).not.toContain(specifier);
    }
  });
});
