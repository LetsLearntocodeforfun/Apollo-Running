/**
 * v1.0.7 (R-14 / PX-10): the app must not import src/labs/.
 *
 * src/labs/ holds experimental "science" modules that no screen uses and that
 * contain known-unsafe advice (see src/labs/README.md). This test scans every
 * app source file — everything under src/ except src/labs/ and test files —
 * and fails if any of them imports from labs, statically or dynamically.
 * Fix the module and move it back to src/services/ before wiring it into a
 * screen.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
const LABS = path.join(SRC, 'labs');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === LABS || entry.name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

/** Whether an import specifier written in `file` resolves into src/labs. */
function pointsIntoLabs(file: string, spec: string): boolean {
  let target: string;
  if (spec.startsWith('@/')) target = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) target = path.resolve(path.dirname(file), spec);
  else return false;
  return target === LABS || target.startsWith(LABS + path.sep);
}

describe('labs boundary (R-14)', () => {
  it('scans the app sources', () => {
    // Sanity check, so a wrong path can't make the boundary test pass vacuously.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join('src', 'main.tsx')))).toBe(true);
  });

  it('no app file imports from src/labs', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(IMPORT_RE)) {
        if (pointsIntoLabs(file, match[1])) offenders.push(`${path.relative(SRC, file)} → ${match[1]}`);
      }
    }
    expect(offenders, 'Screens and services must not import experimental src/labs modules (see src/labs/README.md)').toEqual([]);
  });

  it('detects labs imports in every form it guards against', () => {
    const file = path.join(SRC, 'pages', 'Example.tsx');
    expect(pointsIntoLabs(file, '../labs/bonkRisk')).toBe(true);
    expect(pointsIntoLabs(file, '@/labs/glycogenModel')).toBe(true);
    expect(pointsIntoLabs(path.join(SRC, 'main.tsx'), './labs')).toBe(true);
    expect(pointsIntoLabs(file, '../services/fuelingCalculator')).toBe(false);
    expect(pointsIntoLabs(file, 'react')).toBe(false);
    const sample = "import { a } from '@/labs/x';\nconst m = await import('../labs/y');";
    expect([...sample.matchAll(IMPORT_RE)].map((m) => m[1])).toEqual(['@/labs/x', '../labs/y']);
  });
});
