/**
 * Retention resolution (SPEC-002 §5, RET-1).
 *
 * RET-1 is the reason this file has no numbers in it. Retention windows are DATA resolved from
 * `jurisdiction_policy` rows, never hard-coded constants and never prompt text. No statutory
 * period appears anywhere in this module, and none is asserted by its tests: which period a
 * jurisdiction requires is a counsel question (`LEGAL_REVIEW_REQUIRED.md`), and encoding a guess
 * would be inventing law with a straight face.
 *
 * The consequence, stated plainly: if a policy row does not state a window for a class, the
 * resolver returns `UNRESOLVED` and the caller must not delete. Failing to delete on an
 * unresolved window is the safe direction — deleting data whose retention basis is unknown
 * destroys records that may be legally required, which is not recoverable.
 */

/** The seven data classes of SPEC-002 §5. */
export type DataClass =
  | 'IDENTITY_DOCUMENT'
  | 'HIGH_RISK_PII'
  | 'CUSTOMER_PII'
  | 'OPAQUE_ID'
  | 'EVIDENCE'
  | 'AUDIT'
  | 'TELEMETRY';

/**
 * Per-class disposition on subject erasure, from SPEC-002 §5.
 *
 * These are the *policy* dispositions, which are the spec's own classification rules rather than
 * a statutory period, so encoding them here is faithful to the spec and not an invention.
 */
export const ERASURE_DISPOSITION: Readonly<Record<DataClass, 'CRYPTO_SHRED' | 'RETAINED' | 'PURGED'>> = {
  IDENTITY_DOCUMENT: 'CRYPTO_SHRED',
  HIGH_RISK_PII: 'CRYPTO_SHRED',
  CUSTOMER_PII: 'CRYPTO_SHRED',
  OPAQUE_ID: 'RETAINED',
  EVIDENCE: 'RETAINED',
  AUDIT: 'RETAINED',
  TELEMETRY: 'PURGED',
};

/** Column on `jurisdiction_policy` holding each class's window. */
const WINDOW_COLUMN: Readonly<Record<DataClass, string>> = {
  IDENTITY_DOCUMENT: 'retention_days_identity_document',
  HIGH_RISK_PII: 'retention_days_high_risk_pii',
  CUSTOMER_PII: 'retention_days_customer_pii',
  OPAQUE_ID: 'retention_days_customer_pii',
  EVIDENCE: 'retention_days_evidence',
  AUDIT: 'retention_days_audit',
  TELEMETRY: 'retention_days_telemetry',
};

export function windowColumn(dataClass: DataClass): string {
  return WINDOW_COLUMN[dataClass];
}

/** A resolved retention window, or an explicit statement that none could be resolved. */
export type RetentionResolution =
  | {
      readonly kind: 'RESOLVED';
      readonly dataClass: DataClass;
      readonly days: number;
      readonly policyId: string;
      readonly jurisdiction: string;
      readonly policyVersion: number;
    }
  | {
      readonly kind: 'UNRESOLVED';
      readonly dataClass: DataClass;
      readonly reason: string;
    };

/**
 * Resolve a class's window from a policy row.
 *
 * `policy` is a row projected from `jurisdiction_policy`. The resolver reads whatever columns the
 * row carries rather than querying, so it stays a pure function and can be exercised without a
 * database; the caller owns the query.
 */
export function resolveRetention(
  dataClass: DataClass,
  policy:
    | {
        readonly id: string;
        readonly jurisdiction: string;
        readonly version: number;
        readonly [column: string]: unknown;
      }
    | undefined,
): RetentionResolution {
  if (policy === undefined) {
    return {
      kind: 'UNRESOLVED',
      dataClass,
      reason: 'no policy in force: refusing to infer a retention window from a default',
    };
  }
  const column = WINDOW_COLUMN[dataClass];
  const raw = policy[column];
  if (raw === null || raw === undefined) {
    return {
      kind: 'UNRESOLVED',
      dataClass,
      reason:
        `policy ${policy.jurisdiction} v${policy.version} states no window for ${dataClass} ` +
        `(${column} is NULL); a retention period is a counsel question and is not defaulted`,
    };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return {
      kind: 'UNRESOLVED',
      dataClass,
      reason: `policy ${policy.jurisdiction} v${policy.version} has a non-positive ${column}`,
    };
  }
  return {
    kind: 'RESOLVED',
    dataClass,
    days: raw,
    policyId: policy.id,
    jurisdiction: policy.jurisdiction,
    policyVersion: policy.version,
  };
}

/**
 * Whether a record of `dataClass`, created at `createdAtMs`, is still within its window.
 *
 * Returns `undefined` when the window is unresolved, rather than a boolean. That is deliberate:
 * a boolean would force a caller to choose a default, and both defaults are wrong — `false`
 * deletes data whose basis is unknown, `true` silently keeps expired data forever. `undefined`
 * makes the caller handle the unresolved case explicitly.
 */
export function isWithinRetention(
  resolution: RetentionResolution,
  createdAtMs: number,
  nowMs: number,
): boolean | undefined {
  if (resolution.kind === 'UNRESOLVED') return undefined;
  const ageMs = nowMs - createdAtMs;
  const windowMs = resolution.days * 24 * 60 * 60 * 1000;
  return ageMs <= windowMs;
}
