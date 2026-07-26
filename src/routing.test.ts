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
  resolveModelByTerm,
  modelConnection,
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

  // The credential check must recognise every credential the call path accepts:
  // a provider whose adapter authenticates with a non-api-key token is usable.
  // Shared fixture, one reason to fail per test.
  describe('altKeyEnvs — an alternative credential', () => {
    const ALT = 'routetest-alt';
    const ALT_KEY = 'ROUTETEST_ALT_API_KEY';
    const ALT_TOKEN = 'ROUTETEST_ALT_OAUTH_TOKEN';
    beforeEach(() => {
      registerProviderConnection({ provider: ALT, apiKeyEnv: ALT_KEY, altKeyEnvs: [ALT_TOKEN] });
      delete process.env[ALT_KEY];
      delete process.env[ALT_TOKEN];
    });
    afterEach(() => {
      delete process.env[ALT_KEY];
      delete process.env[ALT_TOKEN];
    });

    it('leaves the provider unconfigured when neither credential is set', () => {
      expect(isProviderConfigured(ALT)).toBe(false);
    });

    it('configures the provider on the alternative credential alone, with no api key', () => {
      process.env[ALT_TOKEN] = 'oauth-abc';
      expect(isProviderConfigured(ALT)).toBe(true);
    });

    it('does NOT configure the provider on an empty/whitespace alternative credential', () => {
      process.env[ALT_TOKEN] = '   ';
      expect(isProviderConfigured(ALT)).toBe(false);
    });
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

describe('resolveModelByTerm + modelConnection (STDIO-378)', () => {
  const entry: ModelCatalogEntry = {
    provider: 'rt2-samba',
    family: 'rt2-deepseek-v3',
    modelClass: 'reasoning',
    currentId: 'DeepSeek-V3.2',
    rates: [0.6, 1.5],
    label: 'DeepSeek V3.2',
    prefixes: ['DeepSeek-V3'],
  };
  beforeEach(() => {
    registerModelCatalog([entry]);
    registerProviderConnection({
      provider: 'rt2-samba',
      apiKeyEnv: 'RT2_KEY',
      baseUrlEnv: 'RT2_URL',
      defaultBaseUrl: 'https://api.example.ai/v1',
    });
    delete process.env.RT2_KEY;
    delete process.env.RT2_URL;
  });
  afterEach(() => {
    delete process.env.RT2_KEY;
    delete process.env.RT2_URL;
  });

  it('resolves a loose family term to the entry when the provider is configured', () => {
    process.env.RT2_KEY = 'k';
    expect(resolveModelByTerm('deepseek')?.currentId).toBe('DeepSeek-V3.2');
  });

  it('returns null when the provider is unconfigured', () => {
    expect(resolveModelByTerm('deepseek')).toBeNull();
  });

  it('builds a usable connection (id + endpoint + key) from a loose term', () => {
    process.env.RT2_KEY = 'sk-x';
    expect(modelConnection('deepseek')).toMatchObject({
      provider: 'rt2-samba',
      modelId: 'DeepSeek-V3.2',
      baseUrl: 'https://api.example.ai/v1',
      apiKey: 'sk-x',
    });
  });

  it('honours a base-url override for the connection endpoint', () => {
    process.env.RT2_KEY = 'sk-x';
    process.env.RT2_URL = 'https://gateway/v1';
    expect(modelConnection('deepseek')?.baseUrl).toBe('https://gateway/v1');
  });

  it('returns no connection for an SDK-only provider (no OpenAI-compatible endpoint)', () => {
    registerModelCatalog([
      {
        provider: 'rt2-sdkonly',
        family: 'rt2-claude',
        modelClass: 'reasoning',
        currentId: 'claude-x',
        rates: [1, 2],
        label: 'Claude',
        prefixes: ['claude'],
      },
    ]);
    registerProviderConnection({ provider: 'rt2-sdkonly', apiKeyEnv: 'RT2_SDK_KEY' }); // no defaultBaseUrl
    process.env.RT2_SDK_KEY = 'k';
    expect(modelConnection('rt2-claude')).toBeNull();
    delete process.env.RT2_SDK_KEY;
  });
});
