/**
 * Opaque identifier value objects (SPEC-001 §2).
 *
 * The property under test is that an identifier cannot be, or contain, a raw personal
 * value; and that identifiers of different kinds are not interchangeable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ActionId,
  CaseId,
  EvidenceId,
  ExposureId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from '../../src/domain/identifiers.ts';
import { InvalidValueObject } from '../../src/domain/errors.ts';

describe('opaque identifiers (SPEC-001 §2)', () => {
  test('all eight kinds accept a canonical opaque value', () => {
    assert.equal(new SubjectId('subject-0001').value, 'subject-0001');
    assert.equal(new TenantId('tenant_01').value, 'tenant_01');
    assert.equal(new CaseId('case:2026:0001').value, 'case:2026:0001');
    assert.equal(new ExposureId('exposure.7').value, 'exposure.7');
    assert.equal(new SourceId('source0001').value, 'source0001');
    assert.equal(new RecipeId('recipe-0001-v3').value, 'recipe-0001-v3');
    assert.equal(new ActionId('action-0001').value, 'action-0001');
    assert.equal(new EvidenceId('evidence-0001').value, 'evidence-0001');
  });

  test('a raw PII value is unrepresentable as an identifier', () => {
    assert.throws(() => new SubjectId('jane.doe@example.com'), InvalidValueObject);
    assert.throws(() => new SubjectId('+14155550123'), InvalidValueObject);
    assert.throws(() => new SubjectId('4155550123'), InvalidValueObject);
    assert.throws(() => new TenantId('123-45-6789'), InvalidValueObject);
  });

  /**
   * A canonical UUID is an opaque identifier and must be representable.
   *
   * MEASURED DEFECT this guards: the phone-number heuristic `\d{7,}` rejected
   * `11111111-1111-4111-8111-111111111111`, because the UUID's leading 8-hex-digit group is a
   * seven-plus digit run. SPEC-002 §1 declares every table's `id` and `tenant_id` as `uuid`, so
   * the domain type could not represent the tenants the schema stores. No domain test caught it
   * because they all used `tenant-0001`; the Postgres-backed suite passed a real tenant id and
   * threw during construction.
   */
  test('a canonical UUID is a valid opaque identifier, not a PII match', () => {
    for (const uuid of [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF',
    ]) {
      assert.equal(new TenantId(uuid).value, uuid);
    }
  });

  test('the UUID exemption does not weaken the PII rules', () => {
    // Anything that is not a canonical UUID still faces the digit-run heuristic, and the email
    // and SSN checks apply to every identifier including a UUID-shaped one.
    for (const bad of ['12345678', '123456789', '5551234567', '+15551234567', '123-45-6789']) {
      assert.throws(() => new SubjectId(bad), InvalidValueObject, `${bad} must stay refused`);
    }
    assert.throws(() => new SubjectId('user@example.com'), InvalidValueObject);

    // The exemption is keyed on the canonical UUID SHAPE, not on "contains hex". A seven-digit
    // group one is NOT a UUID (`[0-9a-f]{8}` requires eight), so it keeps facing the heuristic.
    // Measured, not assumed: '1234567a-…' IS a canonical UUID (`a` is a hex digit) and is
    // therefore accepted, while '1234567-…' is not and is refused.
    assert.throws(
      () => new SubjectId('1234567-1111-4111-8111-111111111111'),
      InvalidValueObject,
      'a seven-hex-digit leading group is not a canonical UUID and must face the digit-run rule',
    );
    assert.equal(
      new SubjectId('1234567a-1111-4111-8111-111111111111').value,
      '1234567a-1111-4111-8111-111111111111',
      'eight hex digits is a canonical UUID and is exempt, even when they are all digits',
    );
  });

  test('empty, padded, over-long, and malformed values are refused', () => {
    for (const bad of [
      '',
      '   ',
      ' subject-1',
      'subject-1 ',
      'subject 1',
      '-leading',
      'x'.repeat(129),
    ]) {
      assert.throws(
        () => new SubjectId(bad),
        InvalidValueObject,
        `should refuse ${JSON.stringify(bad)}`,
      );
    }
  });

  test('equality is by kind and value, and cross-kind equality is false', () => {
    assert.ok(new SubjectId('a').equals(new SubjectId('a')));
    assert.equal(new SubjectId('a').equals(new SubjectId('b')), false);
    assert.equal(new SubjectId('a').equals(new SourceId('a')), false);
  });

  test('string form names the kind, so a log line cannot confuse two identifiers', () => {
    assert.equal(String(new CaseId('c1')), 'CaseId:c1');
  });
});
