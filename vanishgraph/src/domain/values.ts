/**
 * Domain value objects (SPEC-001 §2).
 *
 * Immutable, self-validating, equality by value. Constructing an invalid value THROWS
 * rather than coercing: the point is to make unsafe states unrepresentable rather than
 * to validate later.
 *
 *   - `Confidence` cannot exist without a recorded basis (VG-IDENT-003).
 *   - `EvidenceDigest` cannot hold a malformed hash (VG-EVIDENCE-001).
 *   - `IdempotencyKey` cannot be blank, so "one key, one effect" has something real to
 *     bind to (VG-ACTION-001).
 *   - `Jurisdiction` cannot be lowercase or unqualified, and `LegalBasis` always names
 *     the policy version it came from, so a legal basis can never be free-floating
 *     model output (VG-POLICY-001).
 *   - `Money` is integer minor units only: no float arithmetic (SPEC-001 §2).
 */

import { InvalidValueObject } from './errors.ts';
import { ALL_TRUTH_STATES, type TruthState } from './truth-state.ts';

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
    // SPEC-003 §4.2 fixes the caller-facing bounds at 16–255 characters. The domain type previously
    // capped at 200, which was NARROWER than the contract it serves: a caller following the
    // specification could send a 255-character key and have construction fail inside the domain,
    // producing a 500 for input the contract declared valid. MEASURED before the fix:
    // `new IdempotencyKey('a'.repeat(255))` threw. The bound now matches the contract, so the wire
    // layer and the domain agree about what a key is.
    //
    // The domain does NOT enforce the 16-character MINIMUM or the `[A-Za-z0-9._:-]` charset:
    // SPEC-001 §2 says only "non-empty, stable across retries, unique per intended effect", and a
    // domain-side minimum would refuse internal keys that never cross the wire. The shape rules are
    // a `/v1` contract, enforced at the boundary (src/http/plugins/idempotency.ts).
    if (value.length > 255) {
      throw new InvalidValueObject('IdempotencyKey', 'must be at most 255 characters');
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

export const PERMISSION_CLASSES = [
  'READ_ONLY',
  'WRITE_PERMITTED',
  'WRITE_UNCLEAR',
  'PROHIBITED',
] as const satisfies readonly PermissionClass[];

export function isPermissionClass(value: unknown): value is PermissionClass {
  return typeof value === 'string' && (PERMISSION_CLASSES as readonly string[]).includes(value);
}

export function assertPermissionClass(value: unknown): PermissionClass {
  if (!isPermissionClass(value)) {
    throw new InvalidValueObject(
      'PermissionClass',
      `must be one of ${PERMISSION_CLASSES.join(', ')}; received ${String(value)}`,
    );
  }
  return value;
}

/** Data egress classification (DATA_EGRESS_MATRIX.md, SPEC-002 egress_class). */
export type EgressClass =
  | 'NONE'
  | 'OPAQUE_ID'
  | 'CUSTOMER_PII'
  | 'HIGH_RISK_PII'
  | 'IDENTITY_DOCUMENT'
  | 'AUTH_SECRET';

export const EGRESS_CLASSES = [
  'NONE',
  'OPAQUE_ID',
  'CUSTOMER_PII',
  'HIGH_RISK_PII',
  'IDENTITY_DOCUMENT',
  'AUTH_SECRET',
] as const satisfies readonly EgressClass[];

export function isEgressClass(value: unknown): value is EgressClass {
  return typeof value === 'string' && (EGRESS_CLASSES as readonly string[]).includes(value);
}

export function assertEgressClass(value: unknown): EgressClass {
  if (!isEgressClass(value)) {
    throw new InvalidValueObject(
      'EgressClass',
      `must be one of ${EGRESS_CLASSES.join(', ')}; received ${String(value)}`,
    );
  }
  return value;
}

/**
 * Egress is deny-by-default for protected classes (VG-EGRESS-001). Only a caller that
 * can demonstrate a tenant policy decision may send these outward.
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
 * Only WRITE_PERMITTED sources may be written to. WRITE_UNCLEAR is deliberately treated
 * exactly like PROHIBITED: an unclear permission is not a permission (VG-CHANNEL-002).
 */
export function permitsAutomatedWrite(permissionClass: PermissionClass): boolean {
  return permissionClass === 'WRITE_PERMITTED';
}

/** The eleven SPEC-000 §5 states are the only permitted status vocabulary (SPEC-000 §4). */
export function assertTruthState(value: unknown): TruthState {
  if (typeof value !== 'string' || !(ALL_TRUTH_STATES as readonly string[]).includes(value)) {
    throw new InvalidValueObject(
      'TruthState',
      `must be one of the eleven canonical truth states; received ${String(value)}. ` +
        'Ad-hoc statuses such as DONE, COMPLETE, SUCCESS or REMOVED are forbidden (SPEC-000 §4).',
    );
  }
  return value as TruthState;
}

/**
 * Channel priority model (SPEC-000 §8). 1 is the highest priority. A lower-priority
 * channel (a larger number) may be selected only when every higher-priority channel is
 * recorded as unavailable, unlawful, or gated, with a reason (VG-CHANNEL-001).
 */
export const CHANNEL_NAMES = [
  'OFFICIAL_SELF_SERVICE',
  'OFFICIAL_PRIVACY_CONTACT',
  'AUTHORIZED_AGENT',
  'GOVERNMENT_CHANNEL',
  'SEARCH_ENGINE_REMOVAL',
  'CERTIFIED_MAIL',
  'APPEAL_OR_REGULATOR',
  'NOT_REMOVABLE_OUTCOME',
] as const;

export type ChannelName = (typeof CHANNEL_NAMES)[number];

export class ChannelPriority {
  static readonly MIN = 1;
  static readonly MAX = 8;

  readonly value: number;

  constructor(value: number) {
    if (!Number.isInteger(value) || value < ChannelPriority.MIN || value > ChannelPriority.MAX) {
      throw new InvalidValueObject(
        'ChannelPriority',
        `must be an integer ${ChannelPriority.MIN}..${ChannelPriority.MAX} matching SPEC-000 §8; received ${String(value)}`,
      );
    }
    this.value = value;
  }

  channelName(): ChannelName {
    const name = CHANNEL_NAMES[this.value - 1];
    if (name === undefined) {
      throw new InvalidValueObject('ChannelPriority', `no channel at priority ${this.value}`);
    }
    return name;
  }

  equals(other: ChannelPriority): boolean {
    return this.value === other.value;
  }
}

export function priorityOf(channel: ChannelName): ChannelPriority {
  const index = (CHANNEL_NAMES as readonly string[]).indexOf(channel);
  if (index < 0) {
    throw new InvalidValueObject('ChannelName', `unknown channel ${channel}`);
  }
  return new ChannelPriority(index + 1);
}

/** Why a higher-priority channel could not be used. A bare "unavailable" is not enough. */
export type ChannelUnavailableKind = 'UNAVAILABLE' | 'UNLAWFUL' | 'GATED';

export interface ChannelOption {
  readonly channel: ChannelName;
  readonly unavailableKind: ChannelUnavailableKind | null;
  /** Required whenever `unavailableKind` is set: the recorded reason (VG-CHANNEL-001). */
  readonly unavailableReason: string | null;
}

/**
 * Select the highest-priority lawful channel and return it. A malformed option set (an
 * unavailable channel with no reason) is refused, and an option set with no lawful
 * channel is refused too: the honest outcome in that case is NOT_REMOVABLE, never a
 * forced write.
 */
export function selectChannel(options: readonly ChannelOption[]): ChannelOption {
  if (options.length === 0) {
    throw new InvalidValueObject('ChannelOption', 'at least one channel must be considered');
  }
  for (const option of options) {
    if (option.unavailableKind !== null) {
      if (option.unavailableReason === null || option.unavailableReason.trim().length === 0) {
        throw new InvalidValueObject(
          'ChannelOption',
          `channel ${option.channel} is marked ${option.unavailableKind} without a recorded reason (VG-CHANNEL-001)`,
        );
      }
    }
  }
  const available = options
    .filter((option) => option.unavailableKind === null)
    .sort((a, b) => priorityOf(a.channel).value - priorityOf(b.channel).value);
  const selected = available[0];
  if (selected === undefined) {
    throw new InvalidValueObject(
      'ChannelOption',
      'no lawful channel is available; the honest outcome is NOT_REMOVABLE, not a forced write',
    );
  }
  return selected;
}

export function rejectedChannels(
  options: readonly ChannelOption[],
  selected: ChannelOption,
): readonly ChannelOption[] {
  return options.filter(
    (option) => priorityOf(option.channel).value < priorityOf(selected.channel).value,
  );
}

/** ISO 3166-2 jurisdiction code, uppercase (SPEC-001 §2). */
export class Jurisdiction {
  static readonly PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;
  readonly value: string;

  constructor(value: string) {
    if (typeof value !== 'string' || !Jurisdiction.PATTERN.test(value)) {
      throw new InvalidValueObject(
        'Jurisdiction',
        'must be an uppercase ISO 3166-2 code such as US or US-CA',
      );
    }
    this.value = value;
  }

  country(): string {
    return this.value.slice(0, 2);
  }

  equals(other: Jurisdiction): boolean {
    return this.value === other.value;
  }
}

/** A legal basis always names the policy version it came from (VG-POLICY-001). */
export class LegalBasis {
  static readonly PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
  readonly code: string;
  readonly policyVersion: number;

  constructor(code: string, policyVersion: number) {
    if (typeof code !== 'string' || !LegalBasis.PATTERN.test(code)) {
      throw new InvalidValueObject(
        'LegalBasis',
        'must be an uppercase token from versioned policy data, not free text or model output',
      );
    }
    if (!Number.isInteger(policyVersion) || policyVersion < 1) {
      throw new InvalidValueObject(
        'LegalBasis',
        `policyVersion must be a positive integer; received ${String(policyVersion)}`,
      );
    }
    this.code = code;
    this.policyVersion = policyVersion;
  }

  equals(other: LegalBasis): boolean {
    return this.code === other.code && this.policyVersion === other.policyVersion;
  }
}

/** Money in integer minor units. Float arithmetic is prohibited (SPEC-001 §2). */
export class Money {
  readonly minorUnits: number;
  readonly currency: string;

  constructor(minorUnits: number, currency: string) {
    if (!Number.isSafeInteger(minorUnits)) {
      throw new InvalidValueObject(
        'Money',
        `minorUnits must be a safe integer; received ${String(minorUnits)}`,
      );
    }
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidValueObject('Money', 'currency must be an ISO 4217 three-letter code');
    }
    this.minorUnits = minorUnits;
    this.currency = currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  multiply(factor: number): Money {
    if (!Number.isSafeInteger(factor)) {
      throw new InvalidValueObject(
        'Money',
        `factor must be an integer; received ${String(factor)} (no float arithmetic)`,
      );
    }
    return new Money(this.minorUnits * factor, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0;
  }

  equals(other: Money): boolean {
    return this.minorUnits === other.minorUnits && this.currency === other.currency;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new InvalidValueObject(
        'Money',
        `cannot combine ${this.currency} with ${other.currency}`,
      );
    }
  }
}

/**
 * Heuristic PII detector used by the domain to refuse to *record* apparent personal data
 * in audit payloads, event payloads, and repair capsules (VG-SEC-002, VG-EGRESS-002).
 * It guards against accidental capture; it is not a DLP engine. The DLP scrubber belongs
 * to the egress path (SPEC-007).
 *
 * The phone heuristic requires EITHER a leading `+` OR a separator that is not a hyphen.
 *
 * Both restrictions are load-bearing, and both were found by failing tests rather than
 * by inspection. A naive `(?:\+?\d[\s.-]?){7,}` matched the opaque identifier
 * `case-2026-000123` on the substring `2026-000123` and reported a perfectly ordinary
 * case id as personal data. Hyphens are the separator of choice for opaque identifiers
 * (and for ISO dates), so treating a hyphen-separated digit run as a phone number
 * produces false positives on exactly the values this domain is built to use. A real
 * international number still carries a `+`, and a national one is conventionally
 * space-, dot- or parenthesis-separated.
 */
export function containsApparentPii(value: string): boolean {
  if (typeof value !== 'string') return false;
  const emailLike = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  const internationalPhone = /\+\d[\d\s.()-]{6,}\d/;
  const nationalPhone = /\b\d{3}[\s.()]\d{3}[\s.()-]?\d{4}\b/;
  const ssnLike = /\b\d{3}-\d{2}-\d{4}\b/;
  return (
    emailLike.test(value) ||
    internationalPhone.test(value) ||
    nationalPhone.test(value) ||
    ssnLike.test(value)
  );
}
