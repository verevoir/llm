import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveBaseUrl,
  localEndpointKey,
  registerProviderConnection,
  providerConnection,
  isProviderConfigured,
  configuredProviders,
  registerModelCatalog,
  providersForFamily,
  resolveModel,
  type ModelCatalogEntry,
} from './index.js';

describe('resolveBaseUrl (STDIO-375)', () => {
  const KEY = 'ROUTETEST_RESOLVE_URL';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('returns the env override when set', () => {
    process.env[KEY] = 'https://gateway/v1';
    expect(resolveBaseUrl(KEY, 'https://default/v1')).toBe('https://gateway/v1');
  });

  it('falls back to the provider default when the env is unset', () => {
    expect(resolveBaseUrl(KEY, 'https://default/v1')).toBe('https://default/v1');
  });

  it('ignores a whitespace-only override', () => {
    process.env[KEY] = '   ';
    expect(resolveBaseUrl(KEY, 'https://default/v1')).toBe('https://default/v1');
  });

  it('returns undefined with no override and no fallback (use the SDK default)', () => {
    expect(resolveBaseUrl(KEY)).toBeUndefined();
    expect(resolveBaseUrl(undefined, undefined)).toBeUndefined();
  });
});

describe('localEndpointKey — keyless local endpoints (STDIO-375)', () => {
  const URLENV = 'ROUTETEST_LOCAL_URL';
  afterEach(() => {
    delete process.env[URLENV];
  });

  it('returns a placeholder when the base-url override is set (a local endpoint needs no key)', () => {
    process.env[URLENV] = 'http://localhost:1234/v1';
    expect(localEndpointKey(URLENV)).toBe('not-needed');
  });

  it('returns undefined with no override, so the canonical endpoint still demands a real key', () => {
    expect(localEndpointKey(URLENV)).toBeUndefined();
    expect(localEndpointKey(undefined)).toBeUndefined();
  });
});

describe('provider connection registry (STDIO-374)', () => {
  const P = 'routetest-prov'; // hosted — always needs a key
  const KEYENV = 'ROUTETEST_API_KEY';
  const URLENV = 'ROUTETEST_BASE_URL';
  const LOCAL = 'routetest-local'; // keyless-capable (generic OpenAI-compatible / local)
  const LOCAL_KEY = 'ROUTETEST_LOCAL_API_KEY';
  const LOCAL_URL = 'ROUTETEST_LOCAL_BASE_URL';
  beforeEach(() => {
    registerProviderConnection({ provider: P, apiKeyEnv: KEYENV, baseUrlEnv: URLENV });
    registerProviderConnection({
      provider: LOCAL,
      apiKeyEnv: LOCAL_KEY,
      baseUrlEnv: LOCAL_URL,
      keylessCapable: true,
    });
    for (const e of [KEYENV, URLENV, LOCAL_KEY, LOCAL_URL]) delete process.env[e];
  });
  afterEach(() => {
    for (const e of [KEYENV, URLENV, LOCAL_KEY, LOCAL_URL]) delete process.env[e];
  });

  it('records how to connect to a provider', () => {
    expect(providerConnection(P)).toMatchObject({ provider: P, apiKeyEnv: KEYENV });
  });

  it('is unconfigured with no key and no base-url override', () => {
    expect(isProviderConfigured(P)).toBe(false);
  });

  it('is configured when the api key is set', () => {
    process.env[KEYENV] = 'sk-x';
    expect(isProviderConfigured(P)).toBe(true);
  });

  it('a HOSTED provider is NOT configured by a base-url override alone — it still needs its key', () => {
    process.env[URLENV] = 'https://regional.example/v1';
    expect(isProviderConfigured(P)).toBe(false);
  });

  it('a KEYLESS-capable provider IS configured by a base-url override alone (local endpoint)', () => {
    process.env[LOCAL_URL] = 'http://localhost:1234/v1';
    expect(isProviderConfigured(LOCAL)).toBe(true);
  });

  it('reports an unknown provider as unconfigured', () => {
    expect(isProviderConfigured('nope-nonexistent')).toBe(false);
  });

  it('lists configured providers', () => {
    process.env[KEYENV] = 'sk-x';
    expect(configuredProviders()).toContain(P);
  });
});

describe('model→provider routing (STDIO-374)', () => {
  // Two providers serving the SAME family at different prices — the
  // deepseek-over-samba case in miniature: which provider serves a family
  // isn't obvious, so routing resolves it.
  const FAM = 'routetest-fam';
  const cheap: ModelCatalogEntry = {
    provider: 'routetest-cheap',
    family: FAM,
    modelClass: 'reasoning',
    currentId: 'cheap-1',
    rates: [0.5, 1],
    label: 'Cheap',
    prefixes: ['cheap'],
  };
  const dear: ModelCatalogEntry = {
    provider: 'routetest-dear',
    family: FAM,
    modelClass: 'reasoning',
    currentId: 'dear-1',
    rates: [2, 4],
    label: 'Dear',
    prefixes: ['dear'],
  };

  beforeEach(() => {
    registerModelCatalog([cheap, dear]);
    registerProviderConnection({ provider: 'routetest-cheap', apiKeyEnv: 'RT_CHEAP_KEY' });
    registerProviderConnection({ provider: 'routetest-dear', apiKeyEnv: 'RT_DEAR_KEY' });
    delete process.env.RT_CHEAP_KEY;
    delete process.env.RT_DEAR_KEY;
  });
  afterEach(() => {
    delete process.env.RT_CHEAP_KEY;
    delete process.env.RT_DEAR_KEY;
  });

  it('lists every provider serving a family (the inverse index)', () => {
    expect(
      providersForFamily(FAM)
        .map((e) => e.provider)
        .sort()
    ).toEqual(['routetest-cheap', 'routetest-dear']);
  });

  it('returns null when no configured provider serves the family', () => {
    expect(resolveModel({ family: FAM })).toBeNull();
  });

  it('picks the cheapest configured provider by default', () => {
    process.env.RT_CHEAP_KEY = 'k';
    process.env.RT_DEAR_KEY = 'k';
    expect(resolveModel({ family: FAM })?.provider).toBe('routetest-cheap');
  });

  it('skips an unconfigured cheaper provider', () => {
    process.env.RT_DEAR_KEY = 'k'; // only the dearer one is usable
    expect(resolveModel({ family: FAM })?.provider).toBe('routetest-dear');
  });

  it('honours an explicit provider preference over price', () => {
    process.env.RT_CHEAP_KEY = 'k';
    process.env.RT_DEAR_KEY = 'k';
    expect(resolveModel({ family: FAM, prefer: ['routetest-dear'] })?.provider).toBe(
      'routetest-dear'
    );
  });

  it('can include unconfigured providers when asked', () => {
    expect(resolveModel({ family: FAM, configuredOnly: false })?.provider).toBe('routetest-cheap');
  });
});
