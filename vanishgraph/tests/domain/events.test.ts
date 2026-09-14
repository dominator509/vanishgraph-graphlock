/**
 * Event catalogue tests (SPEC-001 §7) and the ports declaration test (SPEC-001 §5).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as ports from '../../src/domain/ports/index.ts';
import {
  DOMAIN_EVENT_NAMES,
  domainEvent,
  isDomainEventName,
} from '../../src/domain/events.ts';
import { TenantId } from '../../src/domain/identifiers.ts';
import { InvalidValueObject } from '../../src/domain/errors.ts';

const tenantId = new TenantId('tenant-0001');

describe('domain event catalogue (SPEC-001 §7)', () => {
  test('exactly the twenty-two documented events exist', () => {
    assert.equal(DOMAIN_EVENT_NAMES.length, 22);
    assert.deepEqual(
      [...DOMAIN_EVENT_NAMES].sort(),
      [
        'Acknowledged',
        'ActionAmbiguous',
        'ActionSubmitted',
        'AliasAttached',
        'AliasQuarantined',
        'AuthorityGranted',
        'AuthorityRevoked',
        'BudgetExceeded',
        'EvidenceStored',
        'HumanRequired',
        'MatchConfirmed',
        'MatchDisproved',
        'NotRemovable',
        'PolicyResolved',
        'Reappeared',
        'Refused',
        'RequestReady',
        'SearchDelisted',
        'SourceRecordObserved',
        'SubjectRegistered',
        'VerificationFailed',
        'VerifiedRemoved',
      ].sort(),
    );
  });

  test('every name is a past-tense fact and no name is an ad-hoc success word', () => {
    for (const name of DOMAIN_EVENT_NAMES) {
      assert.match(name, /^[A-Z][A-Za-z]+$/, `${name} must be a past-tense event name`);
      assert.ok(!['Success', 'Done', 'Complete', 'Removed'].includes(name));
    }
  });

  test('membership guard refuses non-events', () => {
    assert.equal(isDomainEventName('VerifiedRemoved'), true);
    assert.equal(isDomainEventName('verifiedRemoved'), false);
    assert.equal(isDomainEventName('Success'), false);
    assert.equal(isDomainEventName(42), false);
  });
});

describe('event envelope (VG-OBS-001, VG-SEC-002)', () => {
  test('an event carries correlationId, tenantId and a timestamp', () => {
    const event = domainEvent({
      eventId: 'event-1',
      name: 'VerifiedRemoved',
      tenantId,
      correlationId: 'corr-1',
      occurredAtMs: 1_000,
      payload: { caseId: 'case-0001', transitionId: 'T14' },
    });
    assert.equal(event.correlationId, 'corr-1');
    assert.equal(event.tenantId.value, 'tenant-0001');
    assert.equal(event.payload['transitionId'], 'T14');
  });

  test('a missing correlationId is refused', () => {
    assert.throws(
      () =>
        domainEvent({
          eventId: 'event-2',
          name: 'RequestReady',
          tenantId,
          correlationId: '   ',
          occurredAtMs: 1_000,
        }),
      InvalidValueObject,
    );
  });

  test('a payload containing apparent PII is refused', () => {
    assert.throws(
      () =>
        domainEvent({
          eventId: 'event-3',
          name: 'MatchConfirmed',
          tenantId,
          correlationId: 'corr-1',
          occurredAtMs: 1_000,
          payload: { basis: 'jane.doe@example.com' },
        }),
      InvalidValueObject,
    );
  });

  test('a non-scalar payload value is refused', () => {
    assert.throws(
      () =>
        domainEvent({
          eventId: 'event-4',
          name: 'MatchConfirmed',
          tenantId,
          correlationId: 'corr-1',
          occurredAtMs: 1_000,
          payload: { nested: { a: 1 } as never },
        }),
      InvalidValueObject,
    );
  });
});

describe('domain ports are declarations only (SPEC-001 §5)', () => {
  test('importing ports yields no runtime exports', () => {
    assert.deepEqual(Object.keys(ports), []);
  });
});
