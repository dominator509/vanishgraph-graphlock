/**
 * Import-boundary test (SPEC-001 §1, §8.5; ARCHITECTURE.md code law).
 *
 * `scripts/import-boundary.sh` enforces this in `lint`; this test enforces it in the unit
 * suite, from an independent implementation, and proves the checker can fail on a
 * deliberate violation. The negative case is the point: a boundary test that cannot go
 * red proves nothing (DOD-018).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DOMAIN_DIR = join(ROOT, 'src', 'domain');

const IMPORT_PATTERNS = [
  /\bfrom\s+'([^']+)'/g,
  /\bfrom\s+"([^"]+)"/g,
  /\bimport\s+'([^']+)'/g,
  /\bimport\s+"([^"]+)"/g,
];

/** Extract every module specifier from a source string. */
export function moduleSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) found.add(specifier);
    }
  }
  return [...found];
}

/** A specifier is permitted in the domain layer when it is relative or a node builtin. */
export function isPermittedInDomain(specifier: string): boolean {
  return (
    specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('node:')
  );
}

export function violationsIn(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, source] of files) {
    for (const specifier of moduleSpecifiers(source)) {
      if (!isPermittedInDomain(specifier)) violations.push(`${path}: ${specifier}`);
    }
  }
  return violations;
}

function readDomainFiles(dir: string, prefix = ''): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const relative = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(full).isDirectory()) {
      for (const [path, source] of readDomainFiles(full, relative)) files.set(path, source);
    } else if (entry.endsWith('.ts')) {
      files.set(`src/domain/${relative}`, readFileSync(full, 'utf8'));
    }
  }
  return files;
}

describe('domain import boundary (SPEC-001 §1)', () => {
  test('the domain layer imports only the standard library', () => {
    const files = readDomainFiles(DOMAIN_DIR);
    assert.ok(files.size >= 7, `expected the domain layer to have files, saw ${files.size}`);
    assert.deepEqual(violationsIn(files), []);
  });

  test('the checker detects a real violation (negative case)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-boundary-'));
    try {
      const offending = join(dir, 'offending.ts');
      writeFileSync(offending, "import { z } from 'zod';\nexport const x = z;\n");
      const files = new Map([[offending, readFileSync(offending, 'utf8')]]);
      const violations = violationsIn(files);
      assert.equal(violations.length, 1);
      assert.match(violations[0] ?? '', /zod/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a framework, ORM, HTTP client or model SDK specifier is refused', () => {
    for (const specifier of ['fastify', 'pg', 'undici', '@prisma/client', 'openai', 'zod']) {
      assert.equal(isPermittedInDomain(specifier), false, `${specifier} must be refused`);
    }
    for (const specifier of ['./values.ts', '../domain/values.ts', 'node:crypto', 'node:test']) {
      assert.equal(isPermittedInDomain(specifier), true, `${specifier} must be permitted`);
    }
  });
});
