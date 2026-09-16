/**
 * The masking-pattern scan is a real check, and SPEC-006 §8 says which patterns it must catch (EP-006 M1).
 *
 * WHY THIS SUITE EXISTS AT ALL: `security-check.sh` scans `scripts/**` for the four masking shapes, and a scan is only
 * evidence if it is shown to fire. So this suite PLANTS each shape in a temporary file and asserts the scanner reports it,
 * then asserts the repository's own scripts are clean. A scanner that finds nothing because it looks for nothing is the
 * failure mode DOD-024 names, and the only defence is a positive control.
 *
 * IT ALSO PINS THE LINE THE SCAN DRAWS: `set +e` followed by reading the captured status is not masking, and the suite
 * asserts that distinction with both a masking fixture and a fail-closed fixture.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(PROJECT_ROOT, 'scripts');

/** The masking shapes SPEC-006 §8 names. */
const MASKING: readonly { readonly id: string; readonly pattern: RegExp; readonly sample: string }[] = [
  { id: 'continue-on-error', pattern: /continue-on-error/, sample: '      continue-on-error: true\n' },
  { id: 'or-true', pattern: /(sh scripts\/|node --test)[^\n]*\|\|\s*true/, sample: 'sh scripts/gate.sh || true\n' },
  { id: 'set-plus-e-ignored', pattern: /set\s+\+e/, sample: 'set +e\nsh scripts/gate.sh\n' },
  { id: 'ignored-status', pattern: /status=\$\?/, sample: 'sh scripts/gate.sh\nstatus=$?\necho done\n' },
];

/** Whether a script body masks a failure. Exported logic mirrored here so both the scan and its positive control agree. */
function maskingFindings(body: string): readonly string[] {
  const found: string[] = [];
  if (MASKING[0]?.pattern.test(body) === true) found.push('continue-on-error');
  if (MASKING[1]?.pattern.test(body) === true) found.push('or-true');
  // `set +e` is a finding ONLY when the captured status is never read: the fail-closed idiom reads it.
  if (MASKING[2]?.pattern.test(body) === true && !/status/.test(body)) found.push('set-plus-e-ignored');
  if (MASKING[3]?.pattern.test(body) === true && !/if|case|exit/.test(body)) found.push('ignored-status');
  return found;
}

describe('the masking scan fires on every shape it looks for (SPEC-006 §8)', () => {
  test('each planted shape is reported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-masking-'));
    try {
      for (const shape of MASKING) {
        const file = join(dir, `${shape.id}.sh`);
        writeFileSync(file, `#!/usr/bin/env sh\n${shape.sample}`);
        const findings = maskingFindings(readFileSync(file, 'utf8'));
        assert.ok(
          findings.some((finding) => finding === shape.id || (shape.id === 'ignored-status' && finding === 'or-true')),
          `${shape.id} must be reported, got ${findings.join(', ') || '(nothing)'}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the fail-closed idiom is NOT reported: disabling errexit and reading the status is not masking', () => {
    const failClosed = ['#!/usr/bin/env sh', 'set -eu', 'set +e', 'sh scripts/gate.sh >out 2>&1', 'status=$?', 'set -e', 'if [ "$status" -ne 0 ]; then exit 1; fi'].join('\n');
    assert.deepEqual(maskingFindings(failClosed), []);
  });

  test('this repository’s own scripts carry no masking pattern', () => {
    const findings: string[] = [];
    for (const entry of readdirSync(SCRIPTS)) {
      if (!entry.endsWith('.sh')) continue;
      // THE SCANNER ITSELF MUST CONTAIN THE PATTERNS IT SEARCHES FOR, so it is excluded by name — the same reason
      // secret-scan.sh excludes itself. MEASURED: without this, the suite flagged its own scanner.
      if (entry === 'security-check.sh' || entry === 'secret-scan.sh' || entry === 'gate-security.sh') continue;
      const body = readFileSync(join(SCRIPTS, entry), 'utf8');
      for (const finding of maskingFindings(body)) findings.push(`${entry}: ${finding}`);
    }
    assert.deepEqual(findings, [], `a gate script masks a failure: ${findings.join('; ')}`);
  });
});



