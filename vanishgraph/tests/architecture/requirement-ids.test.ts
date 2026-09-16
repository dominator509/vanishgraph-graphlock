/**
 * Every requirement ID cited in this repository must exist in the specification corpus (DOD-016, DOD-027).
 *
 * WHY THIS EXISTS, WITH THE MEASUREMENT THAT PRODUCED IT. While building EP-006 M10's accounting I ran the check this
 * file now runs — grep every `VG-<AREA>-<NNN>` citation out of the tree and look each one up in `.agent/specs/*.md` —
 * and it found **four** citations to requirements that do not exist anywhere in any specification:
 *
 *   * `VG-AUTHZ-024` in `tests/integration/authority-at-execution.test.ts`, authored minutes earlier in this same
 *     milestone. The intended ID was `VG-AUTH-024`. Fixed, and the fix is why the accounting for that suite now cites a
 *     requirement a reader can actually look up.
 *   * `VG-SCOPE-020` in eight files, including four under `src/`. The `VG-SCOPE` series is SPEC-000 §3's ten
 *     out-of-scope prohibitions, `VG-SCOPE-001`…`VG-SCOPE-010`; there is no `VG-SCOPE-011`…`020` in the corpus or in any
 *     blueprint file. The claim it was attached to — "the local file-backed key provider is tests-only" — is governed by
 *     **ADR-006** (recorded `OPEN` in `DECISIONS.md`) and SPEC-002 §4, so the mutable files now cite those.
 *   * `VG-DATA-013` and `VG-DATA-015` in `db/migrations/0004_policy_and_action.sql`. The `VG-DATA` series stops at
 *     `VG-DATA-012`.
 *
 * WHY AN EXCEPTION LIST RATHER THAN A CLEAN SWEEP: three of those citations live in migrations that have ALREADY BEEN
 * APPLIED, and DOD-040 makes an applied migration immutable — the runner compares a recorded checksum and fails when the
 * file changes (measured: `migrate: FAIL - … was already applied with checksum … but the file now hashes to …`). A
 * comment cannot be corrected in place without invalidating every prior run's evidence, so the honest treatment is to
 * name them here, by file and by ID, with the reason, and to keep the check ENFORCING for everything else. A fabricated
 * citation is a claim about a requirement that does not exist, which is the class of defect DOD-016 and DOD-027 are
 * about; the exceptions below are recorded, not waived silently.
 *
 * THE CHECKER IS A PURE FUNCTION AND ITS NEGATIVE CASE IS EXECUTED (DOD-018): `unknownCitations` is asserted to report a
 * citation that is absent from the corpus, so a green result here means the lookup works and not merely that it ran.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SPECS_DIR = join(ROOT, '.agent', 'specs');

/** The trees a citation can appear in. `node_modules`, `dist` and the UI build output are not part of the repository's own prose. */
const SCANNED_ROOTS = ['src', 'tests', 'scripts', 'db', 'ui/src'];
/** Root documents that cite requirements in their prose. */
const SCANNED_ROOT_FILES = ['COMMANDS.md', 'ASSUMPTIONS.md', 'DECISIONS.md', 'TESTING.md', 'ARCHITECTURE.md', 'SECURITY.md'];
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js', '.sh', '.sql', '.py', '.md', '.json', '.csv', '.txt'];

/**
 * Citations that cannot be corrected, with the reason. Each entry names ONE file and ONE id: a wildcard would let a new
 * fabricated citation hide behind it.
 */
export const IMMUTABLE_CITATION_EXCEPTIONS: readonly { readonly file: string; readonly id: string; readonly why: string }[] = [
  {
    file: 'db/migrations/0004_policy_and_action.sql',
    id: 'VG-DATA-013',
    why: 'the migration is applied and immutable (DOD-040); the VG-DATA series ends at VG-DATA-012',
  },
  {
    file: 'db/migrations/0004_policy_and_action.sql',
    id: 'VG-DATA-015',
    why: 'the migration is applied and immutable (DOD-040); the VG-DATA series ends at VG-DATA-012',
  },
  {
    file: 'db/migrations/0009_retention.sql',
    id: 'VG-SCOPE-020',
    why: 'the migration is applied and immutable (DOD-040); the VG-SCOPE series ends at VG-SCOPE-010',
  },
];

/**
 * Citations that are ALLOWED because the file that carries them is the record of the defect.
 *
 * `ASSUMPTIONS.md` §3.56 names the four fabricated citations exactly, because a record that says "some ids were wrong"
 * without naming them is not a record. MEASURED: when this guard was first run in the unit stage it failed on
 * `ASSUMPTIONS.md` for all four — correctly, by its own rule — so the rule needed a second, narrower exception rather
 * than the documentation losing the names. One file, four ids, no pattern.
 */
export const RECORDED_CITATION_EXCEPTIONS: readonly { readonly file: string; readonly id: string; readonly why: string }[] = [
  {
    file: 'ASSUMPTIONS.md',
    id: 'VG-SCOPE-020',
    why: '§3.56 records this fabricated citation by name; naming it is the point of the record',
  },
  {
    file: 'ASSUMPTIONS.md',
    id: 'VG-UI-090',
    why: '§3.56 records the fabricated VG-UI-090…093 range by its first id',
  },
  {
    file: 'ASSUMPTIONS.md',
    id: 'VG-AUTHZ-024',
    why: '§3.56 records this fabricated citation by name',
  },
  {
    file: 'ASSUMPTIONS.md',
    id: 'VG-DATA-013',
    why: '§3.56 records the immutable migration citation by name',
  },
  {
    file: 'ASSUMPTIONS.md',
    id: 'VG-DATA-015',
    why: '§3.56 records the immutable migration citation by name',
  },
];

/** Both lists, which is what the checker consults. */
export const CITATION_EXCEPTIONS = [...IMMUTABLE_CITATION_EXCEPTIONS, ...RECORDED_CITATION_EXCEPTIONS];

/**
 * This file, which must be excluded from its own scan.
 *
 * IT NAMES THE FABRICATED IDS ON PURPOSE — in this header, in the exception list, and in the negative case that asserts
 * the checker can report one. Scanning itself would make every run fail on the documentation of the defect it exists to
 * prevent, and the temptation then would be to delete the documentation. The exclusion is exactly one file and is named
 * here rather than expressed as a pattern.
 */
const SELF = 'tests/architecture/requirement-ids.test.ts';

const CITATION = /\bVG-[A-Z]+-\d{3}\b/g;

/** Every requirement ID cited in one source string. */
export function citedIds(source: string): string[] {
  return [...new Set(source.match(CITATION) ?? [])];
}

/**
 * The citations in one file that the corpus does not define and the exception lists do not name.
 *
 * Pure, so the negative case can be executed against a synthetic string instead of against the repository.
 */
export function unknownCitations(
  filePath: string,
  source: string,
  corpus: string,
  exceptions: readonly { readonly file: string; readonly id: string }[] = CITATION_EXCEPTIONS,
): string[] {
  const key = filePath.replace(/\\/g, '/');
  return citedIds(source).filter((id) => {
    if (corpus.includes(id)) return false;
    return !exceptions.some((exception) => exception.file === key && exception.id === id);
  });
}

/** Every file under a root, with the extensions this check reads. */
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
    if (entry === 'node_modules' || entry === 'dist' || entry === '.cache-ui-render') continue;
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) {
      found.push(...filesUnder(relative(ROOT, child)));
      continue;
    }
    if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(relative(ROOT, child));
  }
  return found;
}

function corpus(): string {
  return readdirSync(SPECS_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => readFileSync(join(SPECS_DIR, name), 'utf8'))
    .join('\n');
}

describe('every cited requirement ID exists in the specification corpus (DOD-016)', () => {
  test('the corpus is real, so a citation can be found in it', () => {
    // THE PREMISE, ASSERTED: if the corpus failed to load, every citation would look fabricated and this suite would
    // fail for the wrong reason — or, worse, a future edit that emptied this list would make it pass vacuously.
    const text = corpus();
    assert.ok(text.length > 100_000, `the specification corpus must load, saw ${String(text.length)} characters`);
    for (const id of ['VG-AUTH-022', 'VG-AUTHZ-005', 'VG-EVIDENCE-001', 'VG-TENANT-002']) {
      assert.ok(text.includes(id), `the corpus must define ${id}`);
    }
  });

  test('no source file cites a requirement the specifications do not define', () => {
    const text = corpus();
    const offenders: string[] = [];
    const scanned = [...SCANNED_ROOTS.flatMap((root) => filesUnder(root)), ...SCANNED_ROOT_FILES];
    for (const file of scanned) {
      if (file.replace(/\\/g, '/') === SELF) continue;
      const absolute = join(ROOT, file);
      let source: string;
      try {
        source = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      for (const id of unknownCitations(file, source, text)) offenders.push(`${file} cites ${id}`);
    }
    assert.ok(scanned.length > 200, `the scan must cover the tree, saw ${String(scanned.length)} files`);
    assert.deepEqual(
      offenders,
      [],
      `a citation to a requirement that does not exist is a claim about a requirement that does not exist:\n${offenders.join('\n')}`,
    );
  });

  test('the exceptions name real files and real citations, so the list cannot rot', () => {
    for (const exception of CITATION_EXCEPTIONS) {
      const source = readFileSync(join(ROOT, exception.file), 'utf8');
      assert.ok(
        citedIds(source).includes(exception.id),
        `${exception.file} no longer cites ${exception.id}; remove the exception rather than keeping a stale waiver`,
      );
      assert.ok(exception.why.length > 20, `${exception.file}/${exception.id} needs a stated reason`);
    }
    // THE IMMUTABLE ONES MUST SAY SO, because "immutable" is the whole basis for not correcting them in place.
    for (const exception of IMMUTABLE_CITATION_EXCEPTIONS) {
      assert.match(exception.why, /immutable/);
    }
    // AND THE RECORDED ONES MUST NOT BE UNDER A MIGRATION, or the two lists have been confused.
    for (const exception of RECORDED_CITATION_EXCEPTIONS) {
      assert.doesNotMatch(exception.file, /^db\/migrations\//);
    }
  });

  test('the checker FAILS on a fabricated citation (DOD-018)', () => {
    // The negative case is the point: a lookup that cannot report a missing requirement proves nothing.
    const text = corpus();
    assert.deepEqual(unknownCitations('tests/example.test.ts', 'proves VG-AUTH-022 and VG-AUTHZ-999', text), [
      'VG-AUTHZ-999',
    ]);
    // A citation in a file that is NOT on either exception list is reported even when the id is on one: the exception is
    // per file and per id, so it cannot be borrowed from elsewhere.
    assert.deepEqual(
      unknownCitations('src/adapters/example.ts', 'see VG-SCOPE-020', text),
      ['VG-SCOPE-020'],
    );
    // And a named exception is honoured, so the enforcing result above is not an artefact of the list being ignored.
    assert.deepEqual(unknownCitations('db/migrations/0009_retention.sql', 'see VG-SCOPE-020', text), []);
    assert.deepEqual(unknownCitations('db/migrations/0009_retention.sql', 'see VG-SCOPE-020 here too', text, []), [
      'VG-SCOPE-020',
    ]);
  });
});
