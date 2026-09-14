/**
 * Opaque identifier value objects (SPEC-001 §2).
 *
 * Capability identifiers (subject, tenant, case, exposure, source, recipe, action,
 * evidence) are opaque strings, never a raw PII value. That is not decoration: an
 * email address or a phone number must be *unrepresentable* as an identifier, so no
 * code path can promote a personal value into a primary key, a log field, or a metric
 * label (SPEC-001 §3 closing rule, VG-SEC-002).
 *
 * One class per kind means a CaseId cannot be passed where an ExposureId is expected:
 * cross-kind confusion is a compile error, not a runtime surprise.
 *
 * Construction of an invalid identifier throws InvalidValueObject (SPEC-006).
 */

import { InvalidValueObject } from './errors.ts';

/** The eight identifier kinds declared by SPEC-001 §2. */
export type IdKind =
  | 'SubjectId'
  | 'TenantId'
  | 'CaseId'
  | 'ExposureId'
  | 'SourceId'
  | 'RecipeId'
  | 'ActionId'
  | 'EvidenceId';

/** Canonical opaque-id shape: starts alphanumeric, then [A-Za-z0-9._:-], max 128. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A run of seven or more digits looks like a phone number or a government id. */
const LONG_DIGIT_RUN = /\d{7,}/;
/** An email address is PII, and must never be an identifier. */
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/;
/**
 * A US SSN shape (`123-45-6789`) is PII.
 *
 * This is checked separately from LONG_DIGIT_RUN because the SSN's own digit groups are
 * only 3, 2 and 4 digits long, so no run reaches the seven-digit threshold. Without this
 * rule `123-45-6789` passes every other check and is accepted as an identifier — a real
 * gap, found by a failing test rather than by inspection.
 */
const SSN_LIKE = /(^|[^0-9])\d{3}-\d{2}-\d{4}([^0-9]|$)/;

export abstract class OpaqueId {
  readonly kind: IdKind;
  readonly value: string;

  protected constructor(kind: IdKind, value: string) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new InvalidValueObject(kind, 'must be a non-empty string');
    }
    if (value !== value.trim()) {
      throw new InvalidValueObject(kind, 'must not have surrounding whitespace');
    }
    if (!ID_PATTERN.test(value)) {
      throw new InvalidValueObject(
        kind,
        `must be an opaque identifier of at most 128 characters starting alphanumerically; received length ${value.length}`,
      );
    }
    if (EMAIL_LIKE.test(value) || LONG_DIGIT_RUN.test(value) || SSN_LIKE.test(value)) {
      throw new InvalidValueObject(
        kind,
        'must be an opaque identifier, never a raw PII value (SPEC-001 §2)',
      );
    }
    this.kind = kind;
    this.value = value;
  }

  equals(other: OpaqueId): boolean {
    return this.kind === other.kind && this.value === other.value;
  }

  toString(): string {
    return `${this.kind}:${this.value}`;
  }
}

export class SubjectId extends OpaqueId {
  constructor(value: string) {
    super('SubjectId', value);
  }
}

export class TenantId extends OpaqueId {
  constructor(value: string) {
    super('TenantId', value);
  }
}

export class CaseId extends OpaqueId {
  constructor(value: string) {
    super('CaseId', value);
  }
}

export class ExposureId extends OpaqueId {
  constructor(value: string) {
    super('ExposureId', value);
  }
}

export class SourceId extends OpaqueId {
  constructor(value: string) {
    super('SourceId', value);
  }
}

export class RecipeId extends OpaqueId {
  constructor(value: string) {
    super('RecipeId', value);
  }
}

export class ActionId extends OpaqueId {
  constructor(value: string) {
    super('ActionId', value);
  }
}

export class EvidenceId extends OpaqueId {
  constructor(value: string) {
    super('EvidenceId', value);
  }
}
