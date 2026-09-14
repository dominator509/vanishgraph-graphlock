/**
 * Domain events (SPEC-001 §7).
 *
 * Immutable facts, past tense, carrying `correlationId` and `tenantId`. They are the only
 * channel by which the application layer reacts to domain change; the domain never calls
 * outward.
 *
 * Payloads are restricted to opaque scalars and are refused when they appear to contain
 * personal data. That restriction is the reason an event can be logged, counted, and
 * replayed safely: there is nothing in it to leak (VG-SEC-002, VG-EGRESS-002).
 */

import { InvalidValueObject } from './errors.ts';
import type { TenantId } from './identifiers.ts';
import { containsApparentPii } from './values.ts';

/** The twenty-two events of SPEC-001 §7, in spec order. */
export const DOMAIN_EVENT_NAMES = [
  'SubjectRegistered',
  'AuthorityGranted',
  'AuthorityRevoked',
  'AliasAttached',
  'AliasQuarantined',
  'SourceRecordObserved',
  'MatchConfirmed',
  'MatchDisproved',
  'PolicyResolved',
  'RequestReady',
  'ActionSubmitted',
  'ActionAmbiguous',
  'Acknowledged',
  'Refused',
  'HumanRequired',
  'VerifiedRemoved',
  'VerificationFailed',
  'Reappeared',
  'NotRemovable',
  'SearchDelisted',
  'EvidenceStored',
  'BudgetExceeded',
] as const;

export type DomainEventName = (typeof DOMAIN_EVENT_NAMES)[number];

/** Opaque scalars only: no nested objects, no arrays, no raw records. */
export type EventPayloadValue = string | number | boolean | null;

export interface DomainEvent {
  readonly eventId: string;
  readonly name: DomainEventName;
  readonly tenantId: TenantId;
  readonly correlationId: string;
  readonly occurredAtMs: number;
  readonly payload: Readonly<Record<string, EventPayloadValue>>;
}

export function isDomainEventName(value: unknown): value is DomainEventName {
  return typeof value === 'string' && (DOMAIN_EVENT_NAMES as readonly string[]).includes(value);
}

export function domainEvent(input: {
  eventId: string;
  name: DomainEventName;
  tenantId: TenantId;
  correlationId: string;
  occurredAtMs: number;
  payload?: Readonly<Record<string, EventPayloadValue>>;
}): DomainEvent {
  if (!isDomainEventName(input.name)) {
    throw new InvalidValueObject(
      'DomainEvent',
      `name must be one of the twenty-two SPEC-001 §7 events; received ${String(input.name)}`,
    );
  }
  if (typeof input.eventId !== 'string' || input.eventId.trim().length === 0) {
    throw new InvalidValueObject('DomainEvent', 'eventId must be a non-empty string');
  }
  if (typeof input.correlationId !== 'string' || input.correlationId.trim().length === 0) {
    throw new InvalidValueObject(
      'DomainEvent',
      'correlationId is required; an event that cannot be correlated cannot be operated (VG-OBS-001)',
    );
  }
  if (!Number.isInteger(input.occurredAtMs)) {
    throw new InvalidValueObject('DomainEvent', 'occurredAtMs must be an integer');
  }
  const payload = input.payload ?? {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string' && containsApparentPii(value)) {
      throw new InvalidValueObject(
        'DomainEvent',
        `payload.${key} appears to contain personal data; events carry opaque identifiers only (VG-SEC-002)`,
      );
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new InvalidValueObject(
        'DomainEvent',
        `payload.${key} must be an opaque scalar; nested structures are refused`,
      );
    }
  }
  return Object.freeze({
    eventId: input.eventId,
    name: input.name,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    occurredAtMs: input.occurredAtMs,
    payload: Object.freeze({ ...payload }),
  });
}
