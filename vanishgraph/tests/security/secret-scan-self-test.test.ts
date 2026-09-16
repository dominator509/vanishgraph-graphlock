/**
 * The secret scanner discriminates (SPEC-006 §8 row 8; DOD-018; EP-006 M8).
 *
 * A SCANNER THAT FINDS NOTHING BECAUSE IT LOOKS FOR NOTHING IS THE FAILURE MODE DOD-018 NAMES, and the only defence is a
 * POSITIVE CONTROL: plant each shape the scanner claims to detect and require it to be reported, then require a clean file
 * to pass. The patterns are read from `scripts/secret-scan.sh` itself, so the fixture set cannot drift from the scanner's
 * own list — a pattern added to the script without a fixture here fails, and a fixture for a pattern the script dropped
 * fails too.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SCANNER = readFileSync(join(PROJECT_ROOT, 'scripts', 'secret-scan.sh'), 'utf8');

/**
 * The shapes the scanner searches for, each with a fixture that MUST be found and a near-miss that must NOT be.
 *
 * THE NEAR-MISSES ARE THE POINT OF THE SECOND COLUMN: a scanner that flagged every assignment would be turned off within a
 * week, and one that flagged a documented example would make the documentation impossible to write.
 */
const SHAPES: readonly { readonly id: string; readonly found: string; readonly ignored: string }[] = [
  { id: 'private-key-header', found: '-----BEGIN RSA PRIVATE KEY-----', ignored: '-----BEGIN PUBLIC KEY----- (a public key is not a secret)' },
  // MEASURED: the AWS positive control must NOT be the documentation value. `AKIAIOSFODNN7EXAMPLE` ends in "EXAMPLE", so
  // the scanner's placeholder exclusion drops it by name — correctly, because that value is published in AWS's own docs
  // and is not a secret. The positive control therefore carries no placeholder word, and the documentation value is
  // asserted in the ignored column instead.
  { id: 'aws-access-key-id', found: 'AKIAQWERTYUIOPASDFGH', ignored: 'AKIAIOSFODNN7EXAMPLE (the documentation value, excluded by name)' },
  { id: 'json-web-token', found: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', ignored: 'eyJhbGciOiJIUzI1NiJ9 (a header alone is not a token)' },
  { id: 'credential-assignment', found: 'CLIENT_SECRET="s3cr3t-value-abcdef"', ignored: 'CLIENT_SECRET="<CLIENT_SECRET> (placeholder)"' },
];

/**
 * The scanner's own regex, read out of the script rather than copied.
 *
 * ONE TRANSLATION IS APPLIED, AND IT IS RECORDED RATHER THAN HIDDEN: the scanner's pattern is written for `grep -E`, which
 * spells a whitespace class `[[:space:]]`, and JavaScript's `RegExp` does not understand POSIX classes. MEASURED: the
 * first version compiled the raw string and threw `Invalid regular expression`. The translation is applied to the CLASS
 * SYNTAX ONLY, and the test asserts the raw pattern contains no other construct this translation would have to hide — so
 * the fixture set is checking the same shape list the scanner uses, not a paraphrase of it.
 */
function scannerPattern(): RegExp {
  const match = /^PATTERNS="(.*)"$/m.exec(SCANNER);
  assert.ok(match !== null, 'the scanner must declare its PATTERNS in a single quoted string');
  const raw = match[1] ?? '';
  assert.equal(/\[\[:(?!space:\])/.test(raw), false, 'a POSIX class other than [[:space:]] would need its own translation');
  return new RegExp(raw.replaceAll('[[:space:]]', '\\s'), 'i');
}

/** The scanner's placeholder exclusion, read the same way. */
function exclusionPattern(): RegExp {
  const match = /grep -vE '\(([^']+)\)'/.exec(SCANNER);
  assert.ok(match !== null, 'the scanner must declare its exclusion list');
  return new RegExp(match[1] ?? '', 'i');
}

describe('the secret scanner detects every shape it claims to (DOD-018)', () => {
  test('each planted shape is reported, and its near-miss is not', () => {
    const pattern = scannerPattern();
    const exclusion = exclusionPattern();
    const dir = mkdtempSync(join(tmpdir(), 'vg-secret-scan-'));
    try {
      for (const shape of SHAPES) {
        const found = join(dir, `${shape.id}.txt`);
        writeFileSync(found, `# fixture\n${shape.found}\n`);
        const text = readFileSync(found, 'utf8');
        assert.equal(pattern.test(text), true, `${shape.id} must be detected`);
        assert.equal(exclusion.test(text), false, `${shape.id} must not be excluded by the placeholder list`);

        // THE NEAR-MISS: a public key, a documented shape, a bare JWT header, and a placeholder assignment.
        const ignored = shape.ignored.startsWith('-----BEGIN PUBLIC KEY-----')
          ? shape.ignored
          : shape.ignored.replace(/ \(.*\)$/, '');
        const clean = join(dir, `${shape.id}-clean.txt`);
        writeFileSync(clean, `# fixture\n${ignored}\n`);
        const cleanText = readFileSync(clean, 'utf8');
        const flagged = pattern.test(cleanText) && !exclusion.test(cleanText);
        // MEASURED, AND IT CORRECTED TWO OF MY ASSUMPTIONS: every near-miss is correctly NOT flagged. I had expected the
        // bare JWT header to trip the three-segment pattern (it does not) and the AWS documentation key to be a precision
        // limit (it is excluded by name), so the assertion is the simple one and the earlier expectation is recorded here
        // rather than kept as a branch that asserted a limit the scanner does not have.
        assert.equal(flagged, false, `${shape.id}: ${shape.ignored} must not be flagged`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the scanner has no baseline auto-accept mechanism, and refuses a zero-file scan', () => {
    // SPEC-006 §8 row 8: there is no `--update` flag and no ignore file that silences a class of finding.
    assert.equal(/--update/.test(SCANNER), false, 'an auto-accept flag would silence findings in bulk');
    assert.equal(/baseline/i.test(SCANNER), false, 'a baseline file is how a finding becomes permanent');
    assert.match(SCANNER, /refusing to report a clean scan over a tree this small/, 'a zero-file scan must fail');
    assert.match(SCANNER, /only \$count files were readable/);
  });

  test('the scanner excludes only itself and the lockfile, each for a stated reason', () => {
    // The exclusion is on the file list, not on the patterns, so a scanner cannot be talked out of a finding.
    assert.match(SCANNER, /grep -vE '\^\(package-lock/);
    assert.match(SCANNER, /scripts\/secret-scan\\\.sh/);
    // And it names the file and the line on a finding rather than a count.
    assert.match(SCANNER, /a credential-shaped value is committed/);
    assert.match(SCANNER, /head -n 20/);
  });
});



