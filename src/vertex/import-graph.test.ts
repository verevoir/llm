import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// `@anthropic-ai/vertex-sdk` is an optional peer: only a caller that imports
// `@verevoir/llm/vertex` needs it installed. So no other entry point may reach
// it. Checked at the source level, with no build: walk each entry point's
// relative imports and collect every package it names along the way. Type-only
// imports count too — the stricter reading, and the simpler scan.

const SRC_DIR = join(process.cwd(), 'src');
const VERTEX_SDK = '@anthropic-ai/vertex-sdk';

function specifiers(source: string): string[] {
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]/g,
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1]));
}

/** Every package named anywhere in the module graph under `entry`. */
function packagesReachedFrom(entry: string): Set<string> {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [join(SRC_DIR, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      else packages.add(spec);
    }
  }
  return packages;
}

const reachesVertexSdk = (entry: string) =>
  [...packagesReachedFrom(entry)].some((p) => p === VERTEX_SDK || p.startsWith(`${VERTEX_SDK}/`));

/** Every public entry point: `src/index.ts`, `src/catalog.ts`, `src/<name>/index.ts`. */
const entryPoints = [
  'index.ts',
  'catalog.ts',
  ...readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SRC_DIR, e.name, 'index.ts')))
    .map((e) => join(e.name, 'index.ts')),
];

describe('the Vertex SDK is imported by the vertex subpath only', () => {
  it('the scan sees the graph (it must never pass vacuously)', () => {
    expect(entryPoints).toContain(join('anthropic', 'index.ts'));
    expect(entryPoints).toContain(join('vertex', 'index.ts'));
    // The direct adapter's graph is walked through to its client module…
    expect(packagesReachedFrom(join('anthropic', 'index.ts'))).toContain('@anthropic-ai/sdk');
    // …and the same walk does find the Vertex SDK where it is imported.
    expect(reachesVertexSdk(join('vertex', 'index.ts'))).toBe(true);
  });

  it('the direct Anthropic adapter does not reach it', () => {
    expect(reachesVertexSdk(join('anthropic', 'index.ts'))).toBe(false);
  });

  it('no entry point but vertex reaches it', () => {
    const reaching = entryPoints.filter(reachesVertexSdk);
    expect(reaching).toEqual([join('vertex', 'index.ts')]);
  });

  it('no source file outside src/vertex names it', () => {
    const naming = readdirSync(SRC_DIR, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      .map((e) => join(e.parentPath, e.name))
      .filter((file) =>
        specifiers(readFileSync(file, 'utf8')).some((s) => s.startsWith(VERTEX_SDK))
      )
      .map((file) => relative(SRC_DIR, file));
    expect(naming).toEqual([join('vertex', 'client.ts')]);
  });
});
