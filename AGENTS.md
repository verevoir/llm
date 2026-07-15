# @verevoir/llm — agent context

`@verevoir/llm` is the **provider-agnostic LLM call surface** of the verevoir stack: the
`chat()` / `chatWithTools` / `chatWithToolLoop` contract, token + cost accounting, the model
catalog + provider-routing registries, the model-span audit hook, and the advisor-pair
primitive. Provider SDK adapters live in subpaths (`@verevoir/llm/anthropic`, `/google`,
`/openai`, `/deepseek`, `/samba`, `/mistral`), so a consumer only pays for the SDK it
imports.

## Stack & layout

- TypeScript, ESM, Node ≥ 20. Built with `tsc`; tested with `vitest`; formatted with
  `prettier`.
- `src/index.ts` — the core export: contract types, accounting helpers, catalog + routing
  registries. **SDK-free**, with `audit-hook.ts` (model-span sink + shared `fireUsageHook`)
  and `pair.ts` (`withAdvisor` — the advisor is dependency-injected as a `chat` function).
- `src/openai-compat.ts` — the shared factory for the OpenAI-compatible providers
  (deepseek / samba / mistral / openai tool-calling). Imports the `openai` SDK, so it is
  reached only via provider subpaths — never from the core export.
- `src/<provider>/` — one directory per adapter, each mapped in `package.json#exports`.
- Tests are colocated `*.test.ts` beside the code, mocking the provider SDKs via `vi.mock`.

## Build / test / run

- `npm test` (`vitest run`) · `npm run typecheck` (`tsc --noEmit`) · `npm run lint`
  (`prettier --check .`) / `npm run format`.
- `npm run build` (`tsc -p tsconfig.build.json`, tests excluded from `dist/`).
- The `Makefile` mirrors the npm scripts (`make test` / `typecheck` / `lint` / `build`).

## Standards that bind changes

- **Core stays SDK-free.** Provider SDKs are optional `peerDependencies`, imported only
  under `src/<provider>/` (and the openai-compat factory); nothing reachable from
  `@verevoir/llm` may import one.
- **Publish-on-change:** any `src/` change requires a version bump in `package.json` (+
  lockfile) and a `CHANGELOG.md` entry in house style, in the same PR.
- **Gate before commit:** `npm run lint`, `npm run typecheck`, `npm test` all green —
  never commit red. CI (`.github/workflows/ci.yml`) re-runs the same gate; PRs also pass
  the antagonistic review workflow.
- **Provision-before-code:** pull the bar with the verevoir MCP `provision` tool before
  changing code; source-changing commits carry a `Practices:` trailer.

## Pointers

- `README.md` — human-facing usage (quickstart, subpaths, routing, accounting).
- `llms.txt` — LLM-agent-facing package description; keep it current with any surface
  change.
- `CHANGELOG.md` — release history; one entry per published version.
