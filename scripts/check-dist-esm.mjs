#!/usr/bin/env node
// Publish gate (STDIO-573): import every built entrypoint under Node's OWN ESM
// resolver. The vitest suite resolves imports via Vite, which forgives an
// extensionless relative import that native ESM refuses — exactly how
// 0.18.0–0.20.0 shipped an unresolvable `dist/index.js`. Runs after `build` in
// `prepublishOnly`, so an entrypoint no consumer could import fails the publish.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const root = resolve(new URL('..', import.meta.url).pathname);

const entrypoints = Object.entries(pkg.exports ?? {}).flatMap(([subpath, target]) => {
  const file = typeof target === 'string' ? target : target?.import;
  return typeof file === 'string' ? [{ subpath, file }] : [];
});

if (entrypoints.length === 0) {
  console.error('check-dist-esm: no "exports" entrypoints found in package.json');
  process.exit(1);
}

let failed = false;
for (const { subpath, file } of entrypoints) {
  try {
    await import(pathToFileURL(resolve(root, file)).href);
    console.log(`ok  ${subpath} → ${file}`);
  } catch (err) {
    failed = true;
    console.error(`FAIL ${subpath} → ${file}: ${err instanceof Error ? err.message : err}`);
  }
}

if (failed) {
  console.error(
    '\ncheck-dist-esm: built entrypoints are not importable under native ESM — do not publish.'
  );
  process.exit(1);
}
console.log(`check-dist-esm: all ${entrypoints.length} entrypoints import cleanly.`);
