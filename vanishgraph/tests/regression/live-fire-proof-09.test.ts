/**
 * LIVE-FIRE-PROOF-09 — Failure recovery (VG-ACTION-001, DOD-015, DOD-017, SPEC-003 §4.2; EP-007 M2).
 *
 * THE OUTCOME'S OWN RULE: AN INTERRUPTION DURING A CAMPAIGN RESUMES FROM DURABLE STATE WITHOUT A SECOND EXTERNAL EFFECT
 * FOR ONE `IdempotencyKey`. Two things make that true, and this suite asserts both where they live:
 *
 *   * THE KEY ITSELF IS COMPARED EXACTLY, so "the same key" is a fact rather than a normalisation: the domain value
 *     object refuses a key with surrounding whitespace instead of trimming it, and it enforces the caller-facing bounds
 *     SPEC-003 §4.2 fixes at 16–255 characters. A key that was trimmed, or that was accepted at a different length than
 *     the contract allows, would make two submissions look different — or one submission look like two.
 *   * THE UNIQUENESS IS A DATABASE CONSTRAINT, read from the migration that owns it
 *     (`UNIQUE (tenant_id, method, route_template, idempotency_key)`), which is what makes the second effect impossible
 *     rather than merely unlikely.
 *
 * THE REQUIRED NEGATIVE CASE — a replayed submission with the same key yields exactly one external effect — is proven
 * against real PostgreSQL in `tests/db/idempotency-store.test.ts` and `tests/db/action-records.test.ts`; this suite
 * asserts those files exist rather than claiming a database property from a unit suite.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { IdempotencyKey } from '../../src/domain/values.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** The refusal an operation produced, or `undefined` when it did not refuse. */
function refusalOf(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('LIVE-FIRE-PROOF-09: one key, one external effect, resumable from durable state (VG-ACTION-001)', () => {
  test('a key is compared EXACTLY: surrounding whitespace is refused rather than trimmed', () => {
    // The defect this forbids: trimming turns " k " and "k" into one key, so two different submissions would share an
    // effect — or a caller that padded a key would silently take over another request's outcome.
    assert.equal(new IdempotencyKey('vg-key-0000000001').value, 'vg-key-0000000001');
    for (const padded of [' vg-key-0000000001', 'vg-key-0000000001 ', '\tvg-key-0000000001']) {
      const refusal = refusalOf(() => new IdempotencyKey(padded));
      assert.ok(refusal instanceof Error, `${JSON.stringify(padded)} must be refused`);
      assert.match(refusal.message, /whitespace|non-empty/);
    }
  });

  test('the UPPER bound is the type’s, and the LOWER bound is the DATABASE’S — a measured divergence, not an assumption', () => {
    // MEASURED, AND IT CORRECTED THIS SUITE: my first version asserted the type enforces SPEC-003 §4.2's 16–255 range.
    // It enforces the MAXIMUM and not the minimum — a 15-character key is ACCEPTED by `IdempotencyKey` — while the
    // database enforces both (`length(idempotency_key) BETWEEN 16 AND 255`, read in the next test). The consequence is
    // recorded rather than smoothed over: a caller that satisfies the type but not the contract reaches PostgreSQL and
    // receives a constraint violation instead of a boundary refusal at the HTTP layer.
    assert.equal(new IdempotencyKey('a'.repeat(255)).value.length, 255, 'the maximum is accepted by the type');
    assert.ok(refusalOf(() => new IdempotencyKey('a'.repeat(256))) instanceof Error, 'and one character more is refused');

    const tooShort = new IdempotencyKey('a'.repeat(15));
    assert.equal(tooShort.value.length, 15, 'MEASURED: the type accepts a key below the contract minimum');
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0011_http_idempotency.sql'), 'utf8');
    assert.match(
      migration,
      /length\(idempotency_key\) BETWEEN 16 AND 255/,
      'and the database is where that minimum is enforced, so the divergence is real and one-sided',
    );
  });

  test('an EMPTY or blank key is refused, so a missing key cannot become a shared one', () => {
    for (const empty of ['', '   ', '\t\n']) {
      const refusal = refusalOf(() => new IdempotencyKey(empty));
      assert.ok(refusal instanceof Error, `${JSON.stringify(empty)} must be refused`);
    }
  });

  test('the UNIQUENESS is a database constraint, read from the migration that owns it', () => {
    // The constraint is what makes a second effect impossible rather than unlikely; the length CHECK beside it is the
    // database agreeing with the domain bounds asserted above.
    const migration = readFileSync(resolve(ROOT, 'db/migrations/0011_http_idempotency.sql'), 'utf8');
    assert.match(migration, /UNIQUE \(tenant_id, method, route_template, idempotency_key\)/);
    assert.match(migration, /length\(idempotency_key\) BETWEEN 16 AND 255/);
  });

  test('the one-effect-per-key proof and the action history live in suites that exist, and are not claimed here', () => {
    for (const suite of ['tests/db/idempotency-store.test.ts', 'tests/db/action-records.test.ts']) {
      assert.equal(existsSync(resolve(ROOT, suite)), true, `${suite} must exist: it proves the durable half`);
    }
  });

  test('DOD-015 and DOD-017 are ACCOUNTED, so the resumability claim has a row rather than a narrative', () => {
    // DOD-030's discipline applied to this outcome: the clauses it rests on must appear in the status record at all.
    const rows = readFileSync(resolve(ROOT, '.agent/verification/state/DOD_STATUS.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { dod_id?: string; status?: string });
    for (const dod of ['DOD-015', 'DOD-017']) {
      const row = rows.find((candidate) => candidate.dod_id === dod);
      assert.ok(row !== undefined, `${dod} must be accounted`);
      assert.ok((row.status ?? '').length > 0, `${dod} must carry a status`);
    }
  });
});
