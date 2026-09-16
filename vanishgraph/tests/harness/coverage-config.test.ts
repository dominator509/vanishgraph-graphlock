/**
 * The coverage configuration and TESTING.md must agree, and every glob in the binding must resolve (DOD-008; EP-007 M1).
 *
 * WHY THIS EXISTS. `scripts/coverage-gate.sh` reads `config/testing/coverage-thresholds.json`, while `TESTING.md` carries
 * the thresholds as the specification a reader sees. Two copies of one table drift, and the drift that matters is a
 * threshold quietly lowered in the configuration while the document still shows the original — the "lowering a target to
 * obtain a pass" that DOD-027 prohibits. The two are therefore compared here rather than trusted to stay equal.
 *
 * THE SECOND HALF IS THE ONE THAT CAUGHT SOMETHING. A layer binding names source globs and suite globs; a glob that
 * matches nothing makes the gate measure an empty set, and MEASURED while writing the gate: with shell globbing enabled
 * the shell expanded the domain source pattern itself — under a non-globstar shell a two-star segment matches exactly
 * one directory level, so the pattern collapsed to `src/domain/ports/index.ts` — and the layer reported `100.00` for a
 * one-file sample. (This comment deliberately does not spell that glob out: the character sequence that ends a block
 * comment appears inside it, which is how the first version of this file failed to parse at all.) A gate cannot detect
 * the collapse on its own — it has no idea what the layer was supposed to contain — so this suite asserts that every
 * glob in the binding resolves to at least one file, and that the layer names cover exactly the targets.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface Thresholds {
  readonly targets: Record<string, { readonly lines: number; readonly branches: number; readonly functions: number }>;
  readonly layers: readonly {
    readonly name: string;
    readonly sources: readonly string[];
    readonly exclude?: readonly string[];
    readonly suites: readonly string[];
    readonly requiresPostgres: boolean;
    readonly basis: string;
  }[];
}

const config = JSON.parse(readFileSync(join(ROOT, 'config/testing/coverage-thresholds.json'), 'utf8')) as Thresholds;
const testing = readFileSync(join(ROOT, 'TESTING.md'), 'utf8');

/**
 * The JSON block TESTING.md carries under the coverage heading.
 *
 * Pure, so the negative case below can prove the extraction fails on a document that has no block instead of silently
 * returning `undefined` and making the comparison vacuous.
 */
export function extractCoverageBlock(document: string): unknown {
  const section = document.split('## Coverage targets (DOD-008)')[1];
  assert.ok(section !== undefined, 'TESTING.md must carry the coverage-targets section');
  const match = /```json\n([\s\S]*?)```/.exec(section);
  assert.ok(match !== null, 'the section must carry a fenced json block');
  return JSON.parse(match[1] ?? '');
}

/**
 * Whether a path matches a `**`-aware glob. Written here so the check does not depend on the shell's globstar.
 *
 * A SINGLE LEFT-TO-RIGHT PASS, BECAUSE THE OBVIOUS CHAIN OF REPLACEMENTS IS WRONG AND WAS MEASURED TO BE: escaping the
 * metacharacters first and then translating `**` to `.*` leaves that inserted dot-star to be rewritten by the later
 * `*` rule, so `**` ended up meaning "at least one character" and the translated pattern matched only ONE directory
 * level. It reported 27 of 67 mirrored UI modules as unmatched, which would have been read as a configuration defect.
 */
export function globMatches(pattern: string, candidate: string): boolean {
  const METACHARACTERS = '.+^${}()|[]\\';
  const parts: string[] = [];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] ?? '';
    if (character === '*') {
      if (pattern.startsWith('**/', index)) {
        parts.push('(?:[^/]+/)*');
        index += 3;
        continue;
      }
      if (pattern.startsWith('**', index)) {
        parts.push('.*');
        index += 2;
        continue;
      }
      parts.push('[^/]*');
      index += 1;
      continue;
    }
    parts.push(METACHARACTERS.includes(character) ? `\\${character}` : character);
    index += 1;
  }
  return new RegExp(`^${parts.join('')}$`).test(candidate);
}

/** Every file under a root, relative to the repository, with `/` separators. */
function filesUnder(root: string): string[] {
  const absolute = join(ROOT, root);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) {
      found.push(...filesUnder(relative(ROOT, child)));
      continue;
    }
    found.push(relative(ROOT, child).replace(/\\/g, '/'));
  }
  return found;
}

const ALL_FILES = [...filesUnder('src'), ...filesUnder('tests'), ...filesUnder('config'), ...filesUnder('ui/src'), ...filesUnder('.cache-ui-render')];

describe('the coverage configuration matches the specification it mirrors (DOD-008, DOD-027)', () => {
  test('TESTING.md carries the coverage section exactly once, with an extractable JSON block', () => {
    const count = testing.split('## Coverage targets (DOD-008)').length - 1;
    assert.equal(count, 1, 'the plan’s verification grep expects exactly one occurrence');
    const block = extractCoverageBlock(testing) as { targets?: unknown };
    assert.equal(typeof block.targets, 'object');
  });

  test('the thresholds in TESTING.md and in the configuration file are identical', () => {
    const block = extractCoverageBlock(testing) as { targets: Thresholds['targets'] };
    assert.deepEqual(block.targets, config.targets, 'a target may only change in both places at once');
    // AND THE SEVEN LAYERS THE PLAN NAMES ARE ALL PRESENT, so a missing key is a failure rather than a smaller table.
    assert.deepEqual(
      Object.keys(config.targets).sort(),
      ['adapters', 'application', 'domain', 'http', 'infrastructure', 'mcp', 'ui'],
    );
    for (const [layer, target] of Object.entries(config.targets)) {
      for (const metric of ['lines', 'branches', 'functions'] as const) {
        assert.equal(Number.isInteger(target[metric]), true, `${layer}.${metric} must be an integer`);
        assert.ok(target[metric] > 0 && target[metric] <= 100, `${layer}.${metric} must be a percentage`);
      }
      assert.ok(target.lines >= target.branches, `${layer}: a branch target above the line target is not meaningful`);
    }
  });

  test('every layer has a binding, and every binding has a target', () => {
    const bound = config.layers.map((layer) => layer.name).sort();
    assert.deepEqual(bound, Object.keys(config.targets).sort(), 'the two halves of the file must describe the same layers');
    for (const layer of config.layers) {
      assert.ok(layer.sources.length >= 1, `${layer.name} must name at least one source glob`);
      assert.ok(layer.suites.length >= 1, `${layer.name} must name at least one suite glob`);
      assert.equal(typeof layer.requiresPostgres, 'boolean', `${layer.name} must declare whether it needs a database`);
      assert.ok(layer.basis.length > 40, `${layer.name} must state the basis for its binding, not just name it`);
    }
  });

  test('every source glob and every suite glob resolves to at least one file', () => {
    // THE CHECK THAT MATTERS: a glob matching nothing makes the gate measure an empty set and report a perfect score.
    for (const layer of config.layers) {
      for (const glob of layer.sources) {
        // THE ui LAYER'S SOURCES ARE A MIRROR, SO THE CANDIDATES ARE SYNTHESISED FROM WHAT IT MIRRORS. Its basis says
        // the instrumented files are the `.cache-ui-render` copy of `ui/src`, produced by tests/contract/render-support.ts
        // at run time. Matching the glob against `ui/src` itself would test the wrong path — and it did, MEASURED, when
        // the substitution in the first version of this test produced `ui/src/**/*.js` and reported that a TSX tree has
        // no JavaScript in it.
        const candidates =
          layer.name === 'ui'
            ? filesUnder('ui/src')
                .filter((file) => /\.tsx?$/.test(file))
                .map((file) => file.replace(/^ui\/src\//, '.cache-ui-render/').replace(/\.tsx?$/, '.js'))
            : ALL_FILES;
        const matches = candidates.filter((file) => globMatches(glob, file));
        assert.ok(matches.length >= 1, `${layer.name}: source glob ${glob} matches nothing`);
      }
      for (const glob of layer.suites) {
        const matches = ALL_FILES.filter((file) => globMatches(glob, file));
        assert.ok(matches.length >= 1, `${layer.name}: suite glob ${glob} matches nothing`);
      }
      // AND THE EXCLUSIONS MUST MATCH SOMETHING TOO, or they are decoration.
      for (const glob of layer.exclude ?? []) {
        const matches = ALL_FILES.filter((file) => globMatches(glob, file));
        assert.ok(matches.length >= 1, `${layer.name}: exclude glob ${glob} matches nothing`);
      }
    }
    // THE MIRROR CHECK ITSELF, STATED: every TSX file the harness would mirror is covered by the ui layer's glob.
    const uiGlob = config.layers.find((layer) => layer.name === 'ui')?.sources[0] ?? '';
    const mirrors = filesUnder('ui/src')
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => file.replace(/^ui\/src\//, '.cache-ui-render/').replace(/\.tsx?$/, '.js'));
    assert.ok(mirrors.length >= 20, `the UI source tree must be present, saw ${String(mirrors.length)} modules`);
    assert.deepEqual(
      mirrors.filter((file) => !globMatches(uiGlob, file)),
      [],
      'every mirrored module must be inside the ui layer’s source glob',
    );
  });

  test('the extraction FAILS on a document without the block (DOD-018)', () => {
    // A parser that returns something for any input would make the comparison above vacuous.
    assert.throws(() => extractCoverageBlock('# Testing\n\nno coverage section here\n'), /coverage-targets section/);
    assert.throws(
      () => extractCoverageBlock('## Coverage targets (DOD-008)\n\nno fenced block\n'),
      /fenced json block/,
    );
    // And the glob matcher is shown to distinguish a subset from the whole, which is the defect it was written for.
    assert.equal(globMatches('src/domain/**/*.ts', 'src/domain/errors.ts'), true);
    assert.equal(globMatches('src/domain/**/*.ts', 'src/domain/ports/index.ts'), true);
    assert.equal(globMatches('src/domain/*.ts', 'src/domain/ports/index.ts'), false);
  });
});
