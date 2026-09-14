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
