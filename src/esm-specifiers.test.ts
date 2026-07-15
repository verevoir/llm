import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Regression guard (STDIO-573): 0.18.0–0.20.0 shipped an extensionless relative
// re-export ('./audit-hook') that native ESM refuses to resolve, so the built
// package crashed every consumer while this suite — resolving through Vite —
// stayed green. tsc emits specifiers verbatim, so the invariant is checkable at
// the SOURCE level with no build: every relative import/export specifier in
// src/ (test files included — they normalise the idiom the next author copies)
// must carry its explicit .js extension.

const SRC_DIR = join(process.cwd(), 'src');

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name));
}

/** Every relative specifier in the file: static imports and re-exports,
 * side-effect imports, and dynamic imports. */
function relativeSpecifiers(source: string): string[] {
  const patterns = [
    /from\s+['"](\.[^'"]+)['"]/g,
    /^\s*import\s+['"](\.[^'"]+)['"]/gm,
    /import\(\s*['"](\.[^'"]+)['"]/g,
  ];
  return patterns.flatMap((p) => [...source.matchAll(p)].map((m) => m[1]));
}

describe('ESM specifiers', () => {
  it('every relative import/export specifier under src/ carries an explicit .js extension', () => {
    const violations = tsFilesUnder(SRC_DIR).flatMap((file) =>
      relativeSpecifiers(readFileSync(file, 'utf8'))
        .filter((spec) => !spec.endsWith('.js'))
        .map((spec) => `${relative(SRC_DIR, file)}: '${spec}'`)
    );
    expect(violations).toEqual([]);
  });

  it('the scan actually sees the codebase (it must never pass vacuously)', () => {
    const files = tsFilesUnder(SRC_DIR);
    expect(files.length).toBeGreaterThan(0);
    const specifiers = files.flatMap((f) => relativeSpecifiers(readFileSync(f, 'utf8')));
    expect(specifiers.length).toBeGreaterThan(0);
  });
});
