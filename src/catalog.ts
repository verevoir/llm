/**
 * @verevoir/llm/catalog — registers every provider's model catalogue, with
 * NO SDK IMPORT at all.
 *
 * Problem this closes: the catalogue is pure data, but before this file
 * existed it was only ever registered as a SIDE EFFECT of importing a real
 * provider adapter subpath (`@verevoir/llm/anthropic`, `/mistral`, `/samba`)
 * — and each of those subpaths requires its SDK (`@anthropic-ai/sdk` or
 * `openai`) as a peer dependency, even for a consumer that only wants to
 * RESOLVE a model term (`resolveModelByTerm('opus')`) or read a label/rate,
 * never place a real call. Governance's reviewer-model selection is exactly
 * that consumer — it needed the catalogue, not a transport — and the only
 * way to get it was to add an SDK dependency solely to trigger an import
 * side effect.
 *
 * Fix: each provider's catalogue now lives in its own `<provider>/catalog.ts`
 * file (pure data: a `PROVIDER` id string and a `CATALOG: ModelCatalogEntry[]`
 * array), importing only the `ModelCatalogEntry` TYPE from `./index.js` — no
 * SDK, no runtime import of anything but plain objects. This file imports
 * those pure data files and registers all of them. A consumer that imports
 * ONLY `@verevoir/llm/catalog` (plus the core `@verevoir/llm` for
 * `resolveModelByTerm` etc.) gets every family this package knows about,
 * with zero SDK as a transitive dependency.
 *
 * `@verevoir/llm/anthropic`, `/mistral` and `/samba` are UNCHANGED for an
 * existing consumer: each still imports its own `./catalog.js` and calls
 * `registerModelCatalog` itself (registration is idempotent per
 * provider/family, so registering the same entries twice — once via this
 * file, once via the real adapter subpath, if a consumer imports both — is
 * a no-op the second time, not a conflict).
 *
 * Deliberately NOT every provider in this package: `/openai`, `/deepseek`
 * and `/google` use a flat `models`/`rates` table plus `registerModelLabels`
 * rather than `ModelCatalogEntry`/`registerModelCatalog` — they have never
 * participated in the catalogue (`resolveModelByTerm`/`normalizeModelId`
 * already return null for their families today, with or without this file),
 * so there is nothing of theirs for this file to extract or register.
 * `/claude-cli` is excluded by its own design (see that adapter's header):
 * it is deliberately never registered into the shared catalog at all.
 */

import { registerModelCatalog, registerProviderConnection } from './index.js';
import {
  CATALOG as ANTHROPIC_CATALOG,
  CONNECTION as ANTHROPIC_CONNECTION,
} from './anthropic/catalog.js';
import { CATALOG as MISTRAL_CATALOG, CONNECTION as MISTRAL_CONNECTION } from './mistral/catalog.js';
import { CATALOG as SAMBA_CATALOG, CONNECTION as SAMBA_CONNECTION } from './samba/catalog.js';

// Re-exported for a consumer that wants the raw data directly (e.g. to list
// every known family) rather than going through resolveModelByTerm/etc.
export { ANTHROPIC_CATALOG, MISTRAL_CATALOG, SAMBA_CATALOG };

// The side effect this subpath exists for: register every provider's
// catalogue AND connection, with no SDK import anywhere in this file's own
// import graph. The connection is registered too, not just the catalogue:
// resolveModelByTerm's default `configuredOnly: true` filters by
// isProviderConfigured, which reads the REGISTERED CONNECTION, not catalog
// membership — catalog entries alone are not enough to make selection resolve
// to anything, even with a real credential present in the environment.
registerModelCatalog([...ANTHROPIC_CATALOG, ...MISTRAL_CATALOG, ...SAMBA_CATALOG]);
registerProviderConnection(ANTHROPIC_CONNECTION);
registerProviderConnection(MISTRAL_CONNECTION);
registerProviderConnection(SAMBA_CONNECTION);
