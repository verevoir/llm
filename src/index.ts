/**
 * @verevoir/llm — provider-agnostic LLM call surface.
 *
 * The core export holds shared types, accounting helpers, and the
 * `chat()` contract that every provider adapter implements. SDK
 * adapters live in subpaths (./anthropic, ./google planned). Consumers
 * import the subpath(s) they use; the unused SDK never enters their
 * bundle.
 */

// ────────────────────────────────────────────────────────────────────
// Core types
// ────────────────────────────────────────────────────────────────────

/**
 * Model-class semantic — what kind of work the call is doing.
 *
 * - `reasoning`: open-ended judgement, cross-document synthesis,
 *   nuanced chat. The conservative default for sites that have to
 *   think across context.
 * - `drafting`: produce substantial new content — code, prose, drafts.
 *   The mid-tier workhorse, between reasoning and extraction. Maps to
 *   Sonnet on Anthropic; on providers with no distinct mid it resolves
 *   up to the reasoning model.
 * - `extraction`: structured turn-text-into-shape tasks (URLs from a
 *   conversation, config from a paragraph). Quick, predictable,
 *   constrained output. Smallest competent model.
 *
 * Adapters map each class to a concrete provider model id (e.g.
 * `reasoning` → `claude-opus-4-7` on Anthropic). The class travels
 * through to {@link TokenUsage} as `direction` so cost rollups can
 * break down spend per direction natively.
 */
export type ModelClass = 'reasoning' | 'drafting' | 'extraction';

// Model-span hook (STDIO-500) — optional, fail-soft per-call instrumentation so
// a consumer can audit every model call, not only delegated ones.
export {
  setModelSpanSink,
  emitModelSpan,
  type ModelSpan,
  type ModelSpanSink,
} from './audit-hook.js';

// Advisor pair (STDIO-574) — a cheap executor's tool loop carries a
// consult_advisor tool answered by a stronger, caller-bound model.
export { withAdvisor, type AdvisorConfig, type ConsultInfo } from './pair.js';

/**
 * Per-turn content. Plain `string` is the convenient v0 shape for
 * pure-text conversations. `ContentBlock[]` carries structured
 * content needed for multi-turn tool loops (tool_use + tool_result
 * blocks) and lays the schema for future multimodal blocks (image,
 * document) without a second migration.
 *
 * Adapters accept either form; pass a string if you have no
 * structure to preserve.
 */
export type TurnContent = string | ContentBlock[];

/**
 * Discriminated union of message-content blocks. Mirrors Anthropic's
 * native shape so the adapter doesn't have to translate. Adapters that
 * don't support a given block kind (e.g. Google for `tool_result`)
 * should surface a typed error rather than silently dropping content.
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      /**
       * Result returned by the tool, serialised as a string the model
       * can read. Use JSON for structured results.
       */
      content: string;
      /** True when the tool errored; the model treats it as a failure. */
      is_error?: boolean;
    };

/** A single message in a conversation. */
export interface Turn {
  role: 'user' | 'assistant';
  content: TurnContent;
}

/**
 * Per-call token + provenance record. Returned alongside every reply.
 * The (provider, model, direction) triple is the model-direction grid
 * used for cost rollups.
 */
export interface TokenUsage {
  /** Provider id, e.g. `anthropic`, `google`. */
  provider: string;
  /** Concrete model id used for the call, e.g. `claude-opus-4-7`. */
  model: string;
  /** The model-class semantic the caller asked for. */
  direction: ModelClass;
  /** Standard input tokens. */
  inputTokens: number;
  /** Output tokens (completion + tool-use args). */
  outputTokens: number;
  /** Tokens written to provider cache on this call. */
  cacheCreationInputTokens: number;
  /** Tokens read from provider cache on this call. */
  cacheReadInputTokens: number;
}

/** Live-progress narration emitted by the model during a long call. */
export interface ProgressInfo {
  /** Progress in 5–90 (the system handles 0 and 100). */
  percent: number;
  /** Short customer-facing status message. */
  message: string;
}

/** Information passed to {@link ChatOptions.onRetry} before each retry. */
export interface ChatRetryInfo {
  /** 1-indexed retry attempt; the original call is attempt 0. */
  attempt: number;
  /** Total retries that will be made before giving up. */
  maxAttempts: number;
  /** Milliseconds we're about to wait before this retry. */
  delayMs: number;
  /** Short human-readable reason — suitable for chat narration. */
  reason: string;
}

/** Options for a single LLM call. */
export interface ChatOptions {
  systemPrompt: string;
  turns: Turn[];
  /**
   * Per-user (BYOK) API key. When null/undefined the adapter falls
   * back to the platform default (e.g. an env var).
   */
  apiKey?: string | null;
  /** Defaults to `'reasoning'` — the conservative choice. */
  modelClass?: ModelClass;
  /**
   * Optional hook invoked before each retry. Best-effort; the adapter
   * never lets a callback failure block the retry.
   */
  onRetry?: (info: ChatRetryInfo) => Promise<void>;
  /** Optional hook invoked after a successful call with token usage. */
  onUsage?: (usage: TokenUsage) => Promise<void>;
  /**
   * Optional hook invoked LIVE during the call when the model emits
   * `report_progress`. When set, the adapter auto-injects the
   * `report_progress` tool into the request.
   */
  onProgress?: (info: ProgressInfo) => Promise<void>;
  /**
   * Optional `AbortSignal` for cancelling the call. When the signal
   * is aborted, the adapter throws the signal's `reason` (or a
   * generic AbortError when none was provided). Checked between
   * loop iterations in `chatWithToolLoop` — in-flight LLM calls
   * complete and their tokens are still recorded, but no further
   * iterations start once the signal is aborted.
   *
   * The canonical use case: an `onUsage` hook that aborts the
   * controller when an aggregate budget is exceeded. The hook's own
   * throws are still swallowed by the adapter for back-compat;
   * abort is the supported escape hatch.
   */
  abortSignal?: AbortSignal;
}

/** Result of a single LLM call via {@link chat}. */
export interface ChatReply {
  /** The assembled text content of the reply. */
  content: string;
  /** Token usage for the call. */
  usage: TokenUsage;
  /** The provider's stop reason — `'end_turn'` for normal completion. */
  stopReason: string;
}

// ────────────────────────────────────────────────────────────────────
// Tool-calling
// ────────────────────────────────────────────────────────────────────

/** Definition of a tool the model can choose to invoke. */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

/** A single tool_use the model emitted in its reply. */
export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Options for {@link chatWithTools}. */
export interface ChatWithToolsOptions extends ChatOptions {
  tools: ToolDef[];
}

/** Result of a single LLM call via {@link chatWithTools}. */
export interface ChatWithToolsResult {
  toolUses: ToolUse[];
  text: string;
  stopReason: string;
  usage: TokenUsage;
}

// ────────────────────────────────────────────────────────────────────
// Multi-turn tool loop
// ────────────────────────────────────────────────────────────────────

/**
 * Caller-supplied function that executes a single tool_use the model
 * emitted, returning a string the model will see as the matching
 * `tool_result`. Throw to indicate a tool failure — the loop will
 * surface it to the model with `is_error: true` so the model can
 * react (apologise, try a different approach, etc.) rather than
 * crashing the entire conversation.
 */
export type ToolExecutor = (toolUse: ToolUse) => Promise<string>;

/** Options for {@link chatWithToolLoop}. */
export interface ChatWithToolLoopOptions extends ChatWithToolsOptions {
  /** Runs each tool_use the model emits. Required. */
  executor: ToolExecutor;
  /**
   * Cap on tool-call iterations. The loop exits after this many
   * tool-using assistant turns regardless of whether the model would
   * have continued. Default 5 — generous for typical conversations
   * (each tool round costs a full LLM call + execution).
   */
  maxIterations?: number;
  /**
   * Optional hook fired after each iteration with a compact summary —
   * useful for narrating progress into a chat surface ("Looking up
   * issues...", "Reading file...").
   */
  onIteration?: (info: {
    iteration: number;
    toolUses: ToolUse[];
    stopReason: string;
  }) => Promise<void>;
}

/** Result of a multi-turn tool conversation. */
export interface ChatWithToolLoopResult {
  /** The model's final text response (after all tool iterations). */
  text: string;
  /** All tool_uses across every iteration of the loop, in order. */
  toolUses: ToolUse[];
  /** Per-tool-use, the string the executor returned (or the error message). */
  toolResults: { toolUseId: string; content: string; isError: boolean }[];
  /** How many model calls happened (1 = pure text, no tools used). */
  iterations: number;
  /** Aggregated usage across all iterations of the loop. */
  usage: TokenUsage;
}

// ────────────────────────────────────────────────────────────────────
// Accounting helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Per-model rollup keyed by concrete model id. Produced by
 * {@link sumUsages}; consumed by display + cost helpers.
 *
 * `cacheRead` / `cacheWrite` are optional so older persisted rollups
 * (which carried only `in` / `out`) still parse — every helper coalesces
 * a missing cache field to 0. Keeping cache tokens *separate* from `in`
 * is what lets {@link estimateCostUSD} price them at their real rates
 * (a cache read is ~0.1× the input rate) instead of burying them in the
 * standard input figure.
 */
export type PerModelUsage = Record<
  string,
  { in: number; out: number; cacheRead?: number; cacheWrite?: number }
>;

/**
 * Parse a JSON-serialised {@link PerModelUsage} produced by a previous
 * call, returning an empty rollup on malformed/empty input.
 */
export function parseUsage(json: string): PerModelUsage {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PerModelUsage;
    }
  } catch {
    // Malformed JSON — treat as empty.
  }
  return {};
}

/**
 * Sum multiple {@link PerModelUsage} rollups into one. Output entries
 * always carry all four counters (a missing input field counts as 0).
 */
export function sumUsages(usages: PerModelUsage[]): PerModelUsage {
  const out: PerModelUsage = {};
  for (const u of usages) {
    for (const [model, vals] of Object.entries(u)) {
      const existing = out[model] ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
      existing.in += vals.in;
      existing.out += vals.out;
      existing.cacheRead = (existing.cacheRead ?? 0) + (vals.cacheRead ?? 0);
      existing.cacheWrite = (existing.cacheWrite ?? 0) + (vals.cacheWrite ?? 0);
      out[model] = existing;
    }
  }
  return out;
}

/**
 * Total tokens across all models in a rollup — input + output + cache
 * read + cache write, all at face value. This is the right figure for a
 * runaway-loop budget guard: a cache *read* costs less in dollars but is
 * still a token the model had to process.
 */
export function totalTokens(usage: PerModelUsage): number {
  let total = 0;
  for (const v of Object.values(usage)) {
    total += v.in + v.out + (v.cacheRead ?? 0) + (v.cacheWrite ?? 0);
  }
  return total;
}

/**
 * Compact token total — `123`, `12.3k`, `12k`, `1.2M`. Drops trailing
 * `.0` so round numbers don't look gawky.
 */
export function formatTokensCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * Per-model USD rates per million tokens:
 * `[input, output, cacheRead?, cacheWrite?]`. The cache entries are
 * optional; when an adapter omits them {@link estimateCostUSD} falls
 * back to the Anthropic-standard multipliers (cache read 0.1×, cache
 * write 1.25× of the input rate). Existing two-element tables stay
 * valid.
 */
export type RateTuple = readonly [number, number, number?, number?];

/** Per-model rate table — `model id → RateTuple`. */
export type RatesTable = Readonly<Record<string, RateTuple>>;

/** Default cache-rate multipliers (Anthropic standard) applied when a
 * rate tuple doesn't carry explicit cache rates. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Estimate the USD cost of a per-model rollup against an adapter's rate
 * table. Input + output price at the table's standard rates; cache reads
 * and cache writes price at their own rates — either the explicit 3rd /
 * 4th rate-tuple entries, or the Anthropic-standard fallbacks (read
 * 0.1×, write 1.25× of input). Pricing cache tokens separately is what
 * makes prompt-cache savings *visible* in the estimate, rather than
 * hidden behind a worst-case full-input-rate treatment.
 *
 * Unknown models contribute 0 to the total — the caller can detect
 * coverage gaps by checking that every model in the rollup is in the
 * rates table.
 */
export function estimateCostUSD(usage: PerModelUsage, rates: RatesTable): number {
  let total = 0;
  for (const [model, v] of Object.entries(usage)) {
    // Exact id first (cheapest), then the family catalog — so a new, unseen
    // version of a known family still prices instead of silently zeroing.
    // Genuinely unknown ids still contribute 0 (see `uncoveredModels` for the
    // loud surface).
    const rate = rates[model] ?? catalogEntryFor(model)?.rates;
    if (!rate) continue;
    const inputRate = rate[0];
    const outputRate = rate[1];
    const cacheReadRate = rate[2] ?? inputRate * CACHE_READ_MULTIPLIER;
    const cacheWriteRate = rate[3] ?? inputRate * CACHE_WRITE_MULTIPLIER;
    total +=
      (v.in * inputRate +
        v.out * outputRate +
        (v.cacheRead ?? 0) * cacheReadRate +
        (v.cacheWrite ?? 0) * cacheWriteRate) /
      1_000_000;
  }
  return total;
}

/**
 * Friendly label registry for known model ids. Adapters merge their
 * known models into this map; consumers can register their own
 * additions. Falls back to the bare id for unknown models so we don't
 * silently swallow them.
 */
const MODEL_LABELS: Record<string, string> = {};

/** Register friendly labels for the given model ids. Idempotent. */
export function registerModelLabels(labels: Record<string, string>): void {
  Object.assign(MODEL_LABELS, labels);
}

/** Display label for a model id, falling back to the catalog's family label
 * (so a new, unregistered version of a known family still labels sensibly)
 * and finally to the bare id. */
export function modelLabel(id: string): string {
  return MODEL_LABELS[id] ?? catalogEntryFor(id)?.label ?? id;
}

// ────────────────────────────────────────────────────────────────────
// Model identity — decisions key on provider/family, never on version
// ────────────────────────────────────────────────────────────────────

/**
 * A version-free model identity — `{ provider, family }`, e.g.
 * `{ anthropic, haiku }`. This is the **decision key**: routing, tier pools,
 * and pricing branch on it, never on the exact versioned id. The concrete
 * version (`claude-haiku-4-5-20251001`) is reporting metadata only.
 */
export interface ModelIdentity {
  provider: string;
  family: string;
}

/**
 * A catalog entry — the single source of truth for one model family. An
 * adapter registers its families once (via {@link registerModelCatalog}) and
 * derives its `models` / `rates` / labels from the same entries, so a version
 * bump is a one-line `currentId` change rather than edits rippling across
 * three hand-maintained tables.
 */
export interface ModelCatalogEntry {
  /** Provider id, e.g. `anthropic`. */
  provider: string;
  /** Decision-key family, e.g. `opus` | `sonnet` | `haiku`. */
  family: string;
  /** The concrete versioned id used for the actual API call + reporting. */
  currentId: string;
  /** Pricing at the family level (version-stable). */
  rates: RateTuple;
  /** Display label, e.g. `Haiku`. */
  label: string;
  /** Which model-class this family serves, if the adapter routes by class. */
  modelClass?: ModelClass;
  /** Older / alternate exact ids that also normalise to this family, so
   * historical usage still prices and labels. */
  aliases?: string[];
  /** Id prefixes that resolve **forward** to this family — a new, unseen
   * version of a known family (e.g. `claude-haiku-…`) still normalises
   * rather than dropping to "unknown". */
  prefixes?: string[];
}

const MODEL_CATALOG: ModelCatalogEntry[] = [];

/**
 * Register model families into the catalog. Idempotent per `provider/family`
 * (re-registering replaces). Also registers each entry's `currentId` and
 * `aliases` as labels, so the existing {@link modelLabel} path keeps working
 * without a separate {@link registerModelLabels} call.
 */
export function registerModelCatalog(entries: ModelCatalogEntry[]): void {
  for (const e of entries) {
    const i = MODEL_CATALOG.findIndex((x) => x.provider === e.provider && x.family === e.family);
    if (i >= 0) MODEL_CATALOG[i] = e;
    else MODEL_CATALOG.push(e);
    registerModelLabels({ [e.currentId]: e.label });
    for (const alias of e.aliases ?? []) registerModelLabels({ [alias]: e.label });
  }
}

/**
 * Normalise a concrete model id to its `{ provider, family }`, or `null` when
 * no registered family claims it (the **loud-on-miss** signal: callers should
 * surface a null rather than silently mis-route). Match order: exact
 * `currentId`, exact `alias`, then `prefix` — the prefix pass is what lets a
 * brand-new version of a known family resolve forward instead of falling off.
 */
export function normalizeModelId(id: string): ModelIdentity | null {
  for (const e of MODEL_CATALOG) {
    if (e.currentId === id || e.aliases?.includes(id)) {
      return { provider: e.provider, family: e.family };
    }
  }
  for (const e of MODEL_CATALOG) {
    if (e.prefixes?.some((p) => id.startsWith(p))) {
      return { provider: e.provider, family: e.family };
    }
  }
  return null;
}

/** The catalog entry a concrete id normalises to, or `null`. */
export function catalogEntryFor(id: string): ModelCatalogEntry | null {
  const ident = normalizeModelId(id);
  if (!ident) return null;
  return (
    MODEL_CATALOG.find((e) => e.provider === ident.provider && e.family === ident.family) ?? null
  );
}

/**
 * The model ids in a usage rollup that price to nothing — neither in the
 * supplied `rates` table nor resolvable via the catalog. This is the **loud**
 * surface for "we billed something we can't price": a cost display should warn
 * on a non-empty result rather than quietly showing an under-count. Distinct
 * from {@link estimateCostUSD}, which stays silent (back-compat) and treats an
 * uncovered model as $0.
 */
export function uncoveredModels(usage: PerModelUsage, rates: RatesTable = {}): string[] {
  return Object.keys(usage).filter((model) => !rates[model] && !catalogEntryFor(model)?.rates);
}

// ── Provider base-URL override (STDIO-375) ──────────────────────────────────

/**
 * Resolve a client base URL: the `<PROVIDER>_BASE_URL` env override when set
 * (and non-empty), else the provider's `fallback` (or `undefined` to use the
 * SDK default). Lets any provider be pointed at a gateway, proxy, regional, or
 * self-hosted endpoint without a code change — keyed by provider/endpoint, the
 * same convention as `<PROVIDER>_API_KEY`.
 */
export function resolveBaseUrl(envVar?: string, fallback?: string): string | undefined {
  const override = envVar ? process.env[envVar]?.trim() : undefined;
  return override || fallback;
}

/**
 * A placeholder API key for a keyless LOCAL endpoint. When a provider's base-URL
 * override is set but its API key is blank, the endpoint is presumed local — LM
 * Studio / Ollama / vLLM expose OpenAI-compatible servers that need no key, yet
 * the SDK still wants a non-empty string. Returns `undefined` when no base-URL
 * override is set, so a missing key against the *canonical* endpoint still errors
 * loudly rather than silently building an unauthenticated client.
 */
export function localEndpointKey(baseUrlEnv?: string): string | undefined {
  return baseUrlEnv && process.env[baseUrlEnv]?.trim() ? 'not-needed' : undefined;
}

// ── Provider connection registry + model→provider routing (STDIO-374) ───────
// The catalog above advertises which families each provider serves; this
// registry records how to *connect* to a provider (its key + base-URL envs), so
// routing can ask "is this provider actually configured?". Each adapter
// registers its connection at module load, beside registerModelCatalog — so, as
// with the catalog, routing only sees providers whose subpath has been imported.

/** How to connect to a provider: the envs that hold its credential + endpoint. */
export interface ProviderConnection {
  provider: string;
  /** Env var holding the API key (e.g. `SAMBA_NOVA_API_KEY`). */
  apiKeyEnv: string;
  /**
   * Additional env vars whose presence ALSO makes this provider usable — a
   * credential that is not the API key but authenticates just as well. Anthropic
   * declares `CLAUDE_CODE_OAUTH_TOKEN` here: the adapter prefers that token over
   * the metered key, so a caller holding only the subscription token has a
   * perfectly usable provider. Without this, {@link isProviderConfigured} would
   * look only at `apiKeyEnv`, report the provider unconfigured, and routing would
   * refuse to pick it — even though every call would have succeeded. The credential
   * CHECK must recognise every credential the CALL path accepts, or the two
   * disagree and the caller is told to set a key it does not need.
   */
  altKeyEnvs?: readonly string[];
  /** Env var that overrides the base URL (e.g. `SAMBA_NOVA_BASE_URL`), if any. */
  baseUrlEnv?: string;
  /**
   * The provider's default OpenAI-compatible base URL, for a raw caller (a
   * delegate worker) that drives the endpoint directly rather than via the SDK.
   * Set for the OpenAI-compatible providers (OpenAI, DeepSeek, SambaNova,
   * Mistral); omitted for SDK-only providers (Anthropic, Gemini) — which a raw
   * OpenAI-compatible caller cannot drive, so they resolve to no connection.
   */
  defaultBaseUrl?: string;
  /**
   * Whether a base-URL override **without a key** makes this provider usable —
   * true only for the generic OpenAI-compatible client pointed at a keyless
   * LOCAL server (LM Studio / Ollama / vLLM). Hosted providers (Anthropic,
   * Gemini, SambaNova, Mistral, DeepSeek) always need a key, so a base-URL
   * override alone (a regional/proxy endpoint) does NOT make them usable.
   * Default false.
   */
  keylessCapable?: boolean;
}

const PROVIDER_CONNECTIONS: Record<string, ProviderConnection> = {};

/** Register how to connect to a provider. Idempotent per provider. */
export function registerProviderConnection(c: ProviderConnection): void {
  PROVIDER_CONNECTIONS[c.provider] = c;
}

/** The registered connection for a provider, or `undefined`. */
export function providerConnection(provider: string): ProviderConnection | undefined {
  return PROVIDER_CONNECTIONS[provider];
}

/**
 * Whether a provider is usable right now: its API key is set, one of its
 * alternative credentials ({@link ProviderConnection.altKeyEnvs} — e.g.
 * Anthropic's `CLAUDE_CODE_OAUTH_TOKEN`) is set, or a base-URL override points it
 * at a keyless local endpoint. Routing must never pick an endpoint with no
 * credential — but it must equally never refuse one that HAS a credential the
 * call path accepts, which is why the alt keys are consulted here.
 */
export function isProviderConfigured(provider: string): boolean {
  const c = PROVIDER_CONNECTIONS[provider];
  if (!c) return false;
  if (process.env[c.apiKeyEnv]?.trim()) return true;
  if (c.altKeyEnvs?.some((env) => process.env[env]?.trim())) return true;
  // Only a keyless-capable provider (the generic OpenAI-compatible client) is
  // usable on a base-URL override alone — a hosted provider still needs its key.
  return !!(c.keylessCapable && c.baseUrlEnv && process.env[c.baseUrlEnv]?.trim());
}

/** The providers that are configured right now (have a usable connection). */
export function configuredProviders(): string[] {
  return Object.keys(PROVIDER_CONNECTIONS).filter(isProviderConfigured);
}

/** Every catalog entry serving a family, across providers — the inverse of the
 * per-provider catalog. Empty when no registered provider serves it. */
export function providersForFamily(family: string): ModelCatalogEntry[] {
  return MODEL_CATALOG.filter((e) => e.family === family);
}

/** How to pick when several providers serve the same model. */
export interface ResolveModelOptions {
  /** Restrict to one family (e.g. `deepseek-v3`). */
  family?: string;
  /** Restrict to one class (reasoning / drafting / extraction). */
  modelClass?: ModelClass;
  /** Only consider providers configured right now. Default true. */
  configuredOnly?: boolean;
  /** Provider priority — earlier wins; overrides cheapest. */
  prefer?: string[];
}

/**
 * Resolve a desired model — by family and/or class — to a concrete catalog
 * entry, across all providers. This is what lets "I want DeepSeek-V3" pick
 * deepseek.com *or* SambaNova by policy, rather than the caller knowing which
 * providers serve it. Policy: a `prefer` provider order if given, else cheapest
 * by input rate; configured providers only unless told otherwise. Returns
 * `null` when nothing matches (loud-on-miss, like {@link normalizeModelId}).
 */
export function resolveModel(opts: ResolveModelOptions = {}): ModelCatalogEntry | null {
  const { family, modelClass, configuredOnly = true, prefer } = opts;
  let candidates = MODEL_CATALOG.filter(
    (e) =>
      (family === undefined || e.family === family) &&
      (modelClass === undefined || e.modelClass === modelClass)
  );
  if (configuredOnly) candidates = candidates.filter((e) => isProviderConfigured(e.provider));
  if (candidates.length === 0) return null;
  const prefRank = (e: ModelCatalogEntry): number => {
    const i = prefer ? prefer.indexOf(e.provider) : -1;
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
  };
  const price = (e: ModelCatalogEntry): number => (e.rates ? e.rates[0] : Number.MAX_SAFE_INTEGER);
  return candidates.slice().sort((a, b) => prefRank(a) - prefRank(b) || price(a) - price(b))[0];
}

/**
 * Resolve a loose human term ("deepseek") OR an exact family/id to a catalog
 * entry, across providers — so config can name a model by family, not a pinned
 * version. Matches the term (case-insensitive) against family, currentId, label,
 * and prefixes; exact family/id wins over a substring, then `prefer` order, then
 * cheapest, then newest id. Configured providers only unless told otherwise.
 * Null on no match (loud-on-miss, like {@link normalizeModelId}).
 */
export function resolveModelByTerm(
  term: string,
  opts: Omit<ResolveModelOptions, 'family'> = {}
): ModelCatalogEntry | null {
  const lc = term.trim().toLowerCase();
  if (!lc) return null;
  const matches = (e: ModelCatalogEntry): boolean =>
    e.family.toLowerCase().includes(lc) ||
    e.currentId.toLowerCase().includes(lc) ||
    (e.label?.toLowerCase().includes(lc) ?? false) ||
    (e.prefixes?.some((p) => p.toLowerCase().startsWith(lc) || lc.startsWith(p.toLowerCase())) ??
      false);
  const { modelClass, configuredOnly = true, prefer } = opts;
  let candidates = MODEL_CATALOG.filter(
    (e) => matches(e) && (modelClass === undefined || e.modelClass === modelClass)
  );
  if (configuredOnly) candidates = candidates.filter((e) => isProviderConfigured(e.provider));
  if (candidates.length === 0) return null;
  const exactRank = (e: ModelCatalogEntry): number =>
    e.family.toLowerCase() === lc || e.currentId.toLowerCase() === lc ? 0 : 1;
  const prefRank = (e: ModelCatalogEntry): number => {
    const i = prefer ? prefer.indexOf(e.provider) : -1;
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
  };
  const price = (e: ModelCatalogEntry): number => (e.rates ? e.rates[0] : Number.MAX_SAFE_INTEGER);
  return candidates
    .slice()
    .sort(
      (a, b) =>
        exactRank(a) - exactRank(b) ||
        prefRank(a) - prefRank(b) ||
        price(a) - price(b) ||
        b.currentId.localeCompare(a.currentId, undefined, { numeric: true })
    )[0];
}

/** A usable OpenAI-compatible connection for a resolved model — everything a
 * raw caller (a delegate worker, a per-tier model slot) needs to make the call,
 * without importing the provider's SDK. */
export interface ModelConnection {
  provider: string;
  /** The concrete current model id (e.g. `DeepSeek-V3.2`). */
  modelId: string;
  /** The OpenAI-compatible base URL (env override, else the provider default). */
  baseUrl: string;
  /** The API key from env, a local placeholder, or null. */
  apiKey: string | null;
}

/**
 * Resolve a term ("deepseek", or an exact id) to a usable OpenAI-compatible
 * connection: provider + concrete model id + endpoint + key, read from the
 * registered connection + env. This is what lets a config name a model by
 * family and have it bind to a real endpoint at resolve time. Null when nothing
 * matches, the provider isn't configured, or it has no OpenAI-compatible
 * endpoint (Anthropic / Gemini are SDK-only and can't be driven raw).
 */
export function modelConnection(
  term: string,
  opts: Omit<ResolveModelOptions, 'family'> = {}
): ModelConnection | null {
  const entry = resolveModelByTerm(term, opts);
  if (!entry) return null;
  const conn = PROVIDER_CONNECTIONS[entry.provider];
  if (!conn) return null;
  const baseUrl = resolveBaseUrl(conn.baseUrlEnv, conn.defaultBaseUrl);
  if (!baseUrl) return null; // SDK-only provider — no raw endpoint
  const apiKey = process.env[conn.apiKeyEnv]?.trim() || localEndpointKey(conn.baseUrlEnv) || null;
  return { provider: entry.provider, modelId: entry.currentId, baseUrl, apiKey };
}
