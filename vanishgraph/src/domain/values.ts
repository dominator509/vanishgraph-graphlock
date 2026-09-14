/**
 * Domain value objects (SPEC-001 §2).
 *
 * These are immutable, self-validating, and compare by value. Constructing an
 * invalid value THROWS rather than coercing. The point is to make unsafe states
 * unrepresentable rather than to validate later:
 *
 *   - `Confidence` cannot exist without a recorded basis, so VG-IDENT-003 holds
 *     by construction and no code path can forget the check.
 *   - `EvidenceDigest` cannot hold a malformed hash, so digest comparison is
 *     meaningful.
 *   - `IdempotencyKey` cannot be empty or blank, so "one key, one effect"
 *     (VG-ACTION-001) has something real to bind to.
 */

import { InvalidValueObject } from './errors.ts';

/** Calibrated match confidence in [0,1] with a mandatory recorded basis. */
export class Confidence {
  readonly value: number;
  readonly basis: readonly string[];

  constructor(value: number, basis: readonly string[]) {
    if (!Number.isFinite(value)) {
      throw new InvalidValueObject('Confidence', `value must be finite, got ${String(value)}`);
    }
    if (value < 0 || value > 1) {
      throw new InvalidValueObject('Confidence', `value must be within [0,1], got ${value}`);
    }
    if (!Array.isArray(basis) || basis.length === 0) {
      throw new InvalidValueObject(
        'Confidence',
        'basis is required; a score with no recorded basis is not evidence (VG-IDENT-003)',
      );
    }
    for (const reason of basis) {
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidValueObject('Confidence', 'basis entries must be non-empty strings');
      }
    }
    this.value = value;
    this.basis = Object.freeze([...basis]);
  }

  atLeast(threshold: number): boolean {
    return this.value >= threshold;
  }

  equals(other: Confidence): boolean {
    return (
      this.value === other.value &&
      this.basis.length === other.basis.length &&
      this.basis.every((b, i) => b === other.basis[i])
    );
  }
}

/** Stable key making one external effect happen at most once (VG-ACTION-001). */
export class IdempotencyKey {
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InvalidValueObject('IdempotencyKey', 'must be a non-empty string');
    }
    if (value !== value.trim()) {
      throw new InvalidValueObject(
        'IdempotencyKey',
        'must not have leading or trailing whitespace (keys are compared exactly)',
      );
    }
    if (value.length > 200) {
      throw new InvalidValueObject('IdempotencyKey', 'must be at most 200 characters');
    }
    this.value = value;
  }

  equals(other: IdempotencyKey): boolean {
    return this.value === other.value;
  }
}

/** SHA-256 content digest of an EvidenceArtifact (VG-EVIDENCE-001). */
export class EvidenceDigest {
  static readonly PATTERN = /^[0-9a-f]{64}$/;
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || !EvidenceDigest.PATTERN.test(value)) {
      throw new InvalidValueObject(
        'EvidenceDigest',
        'must be 64 lowercase hexadecimal characters (SHA-256)',
      );
    }
    this.value = value;
  }

  equals(other: EvidenceDigest): boolean {
    return this.value === other.value;
  }
}

/** Minimum time that must elapse before a removal may be verified (VG-VERIFY-002). */
export class ObservationWindow {
  readonly durationMs: number;
  readonly method: string;

  constructor(durationMs: number, method: string) {
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new InvalidValueObject(
        'ObservationWindow',
        `durationMs must be a positive integer, got ${String(durationMs)}`,
      );
    }
    if (typeof method !== 'string' || method.trim().length === 0) {
      throw new InvalidValueObject('ObservationWindow', 'method must be a non-empty string');
    }
    this.durationMs = durationMs;
    this.method = method;
  }

  hasElapsed(observedAtMs: number, startedAtMs: number): boolean {
    return observedAtMs - startedAtMs >= this.durationMs;
  }
}

/** Source write-permission classification (SPEC-002 permission_class). */
export type PermissionClass =
  | 'READ_ONLY'
  | 'WRITE_PERMITTED'
  | 'WRITE_UNCLEAR'
  | 'PROHIBITED';

/** Data egress classification (DATA_EGRESS_MATRIX.md, SPEC-002 egress_class). */
export type EgressClass =
  | 'NONE'
  | 'OPAQUE_ID'
  | 'CUSTOMER_PII'
  | 'HIGH_RISK_PII'
  | 'IDENTITY_DOCUMENT'
  | 'AUTH_SECRET';

/**
 * Egress is deny-by-default for protected classes (VG-EGRESS-001). Only caller
 * that can demonstrate a tenant policy decision may send these outward.
 */
export const DENY_BY_DEFAULT_EGRESS: readonly EgressClass[] = Object.freeze([
  'CUSTOMER_PII',
  'HIGH_RISK_PII',
  'IDENTITY_DOCUMENT',
  'AUTH_SECRET',
] as const);

export function requiresExplicitPolicy(egressClass: EgressClass): boolean {
  return DENY_BY_DEFAULT_EGRESS.includes(egressClass);
}

/**
 * Only WRITE_PERMITTED sources may be written to. WRITE_UNCLEAR is deliberately
 * treated exactly like PROHIBITED: an unclear permission is not a permission
 * (VG-CHANNEL-002, TOS_AUTOMATION_MATRIX.md).
 */
export function permitsAutomatedWrite(permissionClass: PermissionClass): boolean {
  return permissionClass === 'WRITE_PERMITTED';
}
