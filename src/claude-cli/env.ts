/**
 * @verevoir/llm/claude-cli — the environment allowlist every `claude`
 * spawn goes through, and the provider id every call reports.
 *
 * MOVED HERE FROM index.ts, wave 1 of 4 (see CHANGELOG's 0.26.7 entry).
 * Every doc comment below is carried verbatim from where it lived in
 * index.ts before this move — nothing about the reasoning changed, only
 * which file states it. Pulled out so the upcoming session-holding
 * transport (`session.ts`) can build the exact same child environment
 * `chat()`'s single-shot path uses, without index.ts and session.ts
 * importing each other — index.ts wires the session API against
 * session.ts, so session.ts reaching back into index.ts for this would
 * be a cycle. Both sides import this module instead; index.ts
 * re-exports every name here under the same names, so nothing importing
 * `@verevoir/llm/claude-cli` can tell this ever moved.
 */

/** Provider id reported on every {@link TokenUsage} this adapter returns —
 * see index.ts's file header for why this must never be `'anthropic'`. */
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
 * spending.
 *
 * WHY HARDCODE ONE CREDENTIAL NAME INTO A PUBLISHED LIBRARY, RATHER THAN
 * LEAVING THE ALLOWLIST CALLER-EXTENSIBLE. This package has many callers
 * and they may legitimately authenticate the tooling THEY drive
 * differently — real elsewhere in this codebase (every adapter's
 * `<PROVIDER>_BASE_URL` override exists precisely because one caller's
 * endpoint isn't another's). It does not carry over to this constant,
 * because this adapter isn't wrapping "any subprocess" that a caller
 * configures — it is built around exactly one credential mechanism: this
 * file already asserts `route` as the constant `'subscription-oauth'`
 * (see index.ts's file header's PAYLOAD CONTRACT paragraph), specifically
 * so a caller can use a Claude subscription rather than a billed key.
 * `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is the CLI's own
 * documented non-interactive mechanism for that credential — the same
 * token `anthropic/index.ts` in this package already prefers over
 * `ANTHROPIC_API_KEY` for the identical reason. A caller running the CLI
 * interactively, already logged in via Keychain (reachable because `HOME`
 * is passed through above), needs no env var at all: this name is simply
 * absent from their environment, and `allowedEnv` below omits whatever
 * isn't set rather than inventing it. A caller needing some OTHER
 * non-billed auth mechanism for the `claude` binary is not a case this
 * file has evidence for — naming a second credential without a confirmed
 * need would be guessing at a shape nobody has asked for, the same
 * standard index.ts's file header holds itself to everywhere else
 * ("relayed, not confirmed"). If that need arises, widening this is a
 * one-line, deliberate change, not a reason to leave the surface wide by
 * default now.
 */
export const CLAUDE_CLI_CREDENTIAL_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * Every environment variable name the `claude` child process is permitted
 * to see — an ALLOWLIST, built from {@link BASE_ENV_NAMES} plus
 * {@link CLAUDE_CLI_CREDENTIAL_ENV_VAR}, never independently.
 *
 * REPLACES an earlier `STRIPPED_ENV_VARS` / `childEnv` DENYLIST that
 * deleted five named Anthropic/Bedrock/Vertex variables and passed
 * everything else in the caller's environment through to the child
 * unchanged — other cloud credentials, other API tokens, `SSH_AUTH_SOCK`,
 * `GITHUB_TOKEN`, all of it, handed to a third-party CLI subprocess this
 * codebase does not control. A denylist can only ever be as complete as
 * the list of things its author thought to name — this file's own
 * honesty that `STRIPPED_ENV_VARS` was never "provably exhaustive" was
 * itself the admission that the wrong primitive was in use. An allowlist
 * doesn't need to be exhaustive about threats to be complete about
 * permissions: nothing outside {@link ALLOWED_ENV_VARS} reaches the
 * child, full stop, regardless of what it's called or whether this file
 * has ever heard of it.
 */
export const ALLOWED_ENV_VARS = [...BASE_ENV_NAMES, CLAUDE_CLI_CREDENTIAL_ENV_VAR] as const;

/**
 * The environment to hand the `claude` child process: every name in
 * {@link ALLOWED_ENV_VARS} that `env` actually carries, and nothing else —
 * never the original object, and never anything not on the allowlist, no
 * matter what the caller's own shell exports. A name on the allowlist
 * that `env` does not have is simply absent from the result, not an
 * error here: a missing `CLAUDE_CODE_OAUTH_TOKEN` is `claude` itself
 * refusing to authenticate, reported through the normal failure path,
 * not a concern of building the environment.
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
