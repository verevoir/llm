import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// `google-auth-library` is an optional peer that only this subpath's callers
// install, so no other entry point may reach it. Checked on the source, with
// no build; type-only imports count too (stricter, and a simpler scan).

const SRC_DIR = join(process.cwd(), 'src');
const AUTH_LIBRARY = 'google-auth-library';
const ENTRY = join('vertex-openai', 'index.ts');

function specifiers(source: string): string[] {
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /import\(\s*['"]([^'"]+)['"]/g,
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1]));
}

const names = (pkg: string) => (spec: string) => spec === pkg || spec.startsWith(`${pkg}/`);

/** Every package named anywhere in the module graph under `entry`, Node's
 * own built-in modules aside. */
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
      else if (!spec.startsWith('node:')) packages.add(spec);
    }
  }
  return packages;
}

const reaches = (entry: string, pkg: string) => [...packagesReachedFrom(entry)].some(names(pkg));

/** Every public entry point: `src/index.ts`, `src/catalog.ts`, `src/<name>/index.ts`. */
const entryPoints = [
  'index.ts',
  'catalog.ts',
  ...readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SRC_DIR, e.name, 'index.ts')))
    .map((e) => join(e.name, 'index.ts')),
];

describe('google-auth-library is imported by the vertex-openai subpath only', () => {
  it('the scan sees the graph (it must never pass vacuously)', () => {
    expect(entryPoints).toContain(ENTRY);
    expect(entryPoints).toContain(join('samba', 'index.ts'));
    // The walk goes through the shared factory to the SDK it imports…
    expect(reaches(join('samba', 'index.ts'), 'openai')).toBe(true);
    // …and does find the credentials library where it is imported.
    expect(reaches(ENTRY, AUTH_LIBRARY)).toBe(true);
  });

  it('no entry point but vertex-openai reaches it', () => {
    expect(entryPoints.filter((entry) => reaches(entry, AUTH_LIBRARY))).toEqual([ENTRY]);
  });

  it('no source file outside src/vertex-openai/client.ts names it', () => {
    const naming = readdirSync(SRC_DIR, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      .map((e) => join(e.parentPath, e.name))
      .filter((file) => specifiers(readFileSync(file, 'utf8')).some(names(AUTH_LIBRARY)))
      .map((file) => relative(SRC_DIR, file));
    expect(naming).toEqual([join('vertex-openai', 'client.ts')]);
  });

  it('the subpath reaches no package but its two peers and the OpenTelemetry API', () => {
    expect([...packagesReachedFrom(ENTRY)].sort()).toEqual([
      '@opentelemetry/api',
      AUTH_LIBRARY,
      'openai',
    ]);
  });
});

describe('the package manifest declares what the subpath needs', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    exports: Record<string, { types: string; import: string }>;
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };

  it('maps the subpath to its built entry', () => {
    expect(pkg.exports['./vertex-openai']).toEqual({
      types: './dist/vertex-openai/index.d.ts',
      import: './dist/vertex-openai/index.js',
    });
  });

  it('names both packages as optional peers', () => {
    for (const name of [AUTH_LIBRARY, 'openai']) {
      expect(pkg.peerDependencies[name]).toBeDefined();
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
  });
});
