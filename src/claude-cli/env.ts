/**
 * @verevoir/llm/claude-cli — the environment allowlist every `claude`
 * spawn goes through, and the provider id every call reports.
 *
 * Pulled out of index.ts so `session.ts` (the held-session transport) can
 * build the exact same child environment `chat()`'s single-shot path
 * uses, without index.ts and session.ts importing each other — index.ts
 * wires `chatWithToolLoop`/`chatWithTools`/the session API against
 * session.ts, so session.ts reaching back into index.ts for this would
 * be a cycle. Both sides import this module instead; index.ts re-exports
 * every name here so nothing importing `@verevoir/llm/claude-cli` can
 * tell this ever moved.
 */

/** Provider id reported on every {@link TokenUsage} this adapter returns,
 * from both the single-shot and the session-holding transport — see
 * index.ts's file header for why this must never be `'anthropic'`. */
export const PROVIDER = 'claude-cli';

/**
 * The base environment names every invocation gets, regardless of what
 * else is permitted. Mirrors `aigency-governance`'s own
 * `src/review/claudeCli.ts` `BASE_ENV_NAMES` exactly — that composition
 * built an independent parallel copy of this file's design and converged
 * on the same three names for the same reasons: `PATH` so the `claude`
 * binary can be found at all, `HOME` because per-user configuration and
 * cache (and, on macOS, the Keychain entry an interactively-logged-in CLI
 * reads its session from) key off it, `TMPDIR` because the CLI writes
 * scratch files and the platform fallback isn't writable everywhere. This
 * list stays boring on purpose — anything added to it is handed to
 * `claude` on every invocation forever.
 */
const BASE_ENV_NAMES = ['PATH', 'HOME', 'TMPDIR'] as const;

/**
 * The one credential this adapter names explicitly — a subscription OAuth
 * token, never the billed `ANTHROPIC_API_KEY` this file exists to avoid
 * spending. See the (fuller) rationale this carried before the move, now
 * in index.ts's own file header CREDENTIAL CONTRACT paragraph and this
 * repository's CHANGELOG 0.25.0 entry — not repeated here verbatim to
 * avoid two copies drifting apart.
 */
export const CLAUDE_CLI_CREDENTIAL_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Every environment variable name the `claude` child process is permitted
 * to see — an ALLOWLIST, built from {@link BASE_ENV_NAMES} plus
 * {@link CLAUDE_CLI_CREDENTIAL_ENV_VAR}, never independently. See
 * index.ts's file header for the full denylist-vs-allowlist history this
 * carried before the move.
 */
export const ALLOWED_ENV_VARS = [...BASE_ENV_NAMES, CLAUDE_CLI_CREDENTIAL_ENV_VAR] as const;

/**
 * The environment to hand a `claude` child process — single-shot OR a
 * held session, both go through this: every name in
 * {@link ALLOWED_ENV_VARS} that `env` actually carries, and nothing else.
 * Never the original object, and never anything not on the allowlist, no
 * matter what the caller's own shell exports. A name on the allowlist
 * that `env` does not have is simply absent from the result, not an
 * error here.
 */
export function allowedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const name of ALLOWED_ENV_VARS) {
    const value = env[name];
    if (value !== undefined) {
      child[name] = value;
    }
  }
  return child;
}
