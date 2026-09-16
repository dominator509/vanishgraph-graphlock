/**
 * The `SecretResolver` port and the egress gate (SPEC-005 §8 VG-AUTH-011…015, §10 VG-AUTH-030; SPEC-006 §7.1/§9; EP-006 M8).
 *
 * **A RESOLUTION FAILURE MAKES NO ATTEMPT AND FALLS BACK TO NOTHING.** The port returns a reference-shaped result, and a
 * failure is `DEPENDENCY_UNAVAILABLE` with ZERO outbound attempts — no plaintext, no `.env`, no empty value, no cached
 * value. That is the whole point of the rule: every fallback is a path where a credential the deployment did not intend to
 * use gets used, and the failure is precisely when somebody is tempted to add one.
 *
 * THE EGRESS GATE DENIES BY DEFAULT for the four classes that may not leave, and it takes the ALLOW list rather than an
 * exemption list: a class that is not declared as allowed is denied, so a new class added to the domain is denied until
 * somebody decides otherwise.
 *
 * DLP RUNS BEFORE EVERY EGRESS AND AN UNAVAILABLE SCRUBBER DENIES. A gate that let content out because the scrubber was
 * down would make the scrubber's availability the control, which is the inversion SPEC-006 §7.1 row 14 forbids.
 *
 * METRIC LABELS ARE A CLOSED SET. A label carrying a case, subject or action id is how PII reaches a metric backend that
 * nobody thinks of as an egress path.
 */

/** The classes that may not leave the deployment (VG-EGRESS-001). */
export const DENIED_EGRESS_CLASSES: readonly string[] = Object.freeze([
  'CUSTOMER_PII',
  'HIGH_RISK_PII',
  'IDENTITY_DOCUMENT',
  'AUTH_SECRET',
]);

/** The egress classes this deployment permits, each with the reason it is permitted. */
export const ALLOWED_EGRESS_CLASSES: readonly { readonly egressClass: string; readonly reason: string }[] = Object.freeze([
  { egressClass: 'OPERATIONAL_METADATA', reason: 'counts, timings and state names carry no subject content' },
  { egressClass: 'PUBLIC_SOURCE_FETCH', reason: 'the request is to a source the tenant is permitted to read' },
  { egressClass: 'CONTROLLER_CORRESPONDENCE', reason: 'the correspondence is the product’s purpose, and it is the redacted template' },
]);

export type EgressDecisionCode = 'EGRESS_DENIED' | 'DLP_UNAVAILABLE' | 'DEPENDENCY_UNAVAILABLE' | 'LABEL_NOT_PERMITTED';

export interface EgressRequest {
  readonly egressClass: string;
  readonly destination: string;
  /** The payload, as the caller holds it. It is never logged by this module. */
  readonly payload: string;
  readonly tenantId: string;
}

export interface ScrubbedPayload {
  /** The payload with every PII pattern replaced. */
  readonly scrubbed: string;
  /** The id of the redaction record, resolvable by an auditor (VG-ERR-071). */
  readonly redactionEvidenceId: string;
  /** What the scrubber removed, by class — never the removed value. */
  readonly removedClasses: readonly string[];
}

/** The scrubber port. Returning `undefined` means DLP could not run, which DENIES egress. */
export type DlpScrubber = (payload: string) => ScrubbedPayload | undefined;

export interface EgressOutcome {
  readonly allow: boolean;
  readonly code?: EgressDecisionCode;
  readonly detail: string;
  /** Present only when egress is allowed. */
  readonly redactionEvidenceId?: string;
  /** The number of outbound attempts this decision produced. Denied egress is always zero. */
  readonly outboundAttempts: number;
}

/**
 * Decide whether a payload may leave.
 *
 * THE ORDER IS THE FAIL-CLOSED ONE: class first (a denied class never reaches the scrubber, so nobody can argue the
 * payload was clean), then DLP (an unavailable scrubber denies), then the outbound attempt count is ONE only after both
 * have passed.
 */
export function decideEgress(request: EgressRequest, scrubber: DlpScrubber): EgressOutcome {
  if (DENIED_EGRESS_CLASSES.includes(request.egressClass)) {
    return {
      allow: false,
      code: 'EGRESS_DENIED',
      detail: `${request.egressClass} may not leave the deployment (VG-EGRESS-001): no outbound request is made`,
      outboundAttempts: 0,
    };
  }
  if (!ALLOWED_EGRESS_CLASSES.some((entry) => entry.egressClass === request.egressClass)) {
    // AN UNDECLARED CLASS IS DENIED RATHER THAN DEFAULTED: a new class is denied until somebody decides otherwise.
    return {
      allow: false,
      code: 'EGRESS_DENIED',
      detail: `"${request.egressClass}" is not a declared egress class, and the default is deny`,
      outboundAttempts: 0,
    };
  }
  const scrubbed = scrubber(request.payload);
  if (scrubbed === undefined) {
    return {
      allow: false,
      code: 'DLP_UNAVAILABLE',
      detail: 'the DLP scrubber could not run, so egress is denied (SPEC-006 §7.1 row 14)',
      outboundAttempts: 0,
    };
  }
  const withoutEvidence = scrubbed.redactionEvidenceId.trim().length === 0;
  if (withoutEvidence) {
    // A SCRUB WITH NO EVIDENCE ID IS NOT AUDITABLE, and the requirement is that the record is resolvable.
    return {
      allow: false,
      code: 'DEPENDENCY_UNAVAILABLE',
      detail: 'the DLP scrub returned no redaction evidence id, so the egress cannot be audited',
      outboundAttempts: 0,
    };
  }
  return {
    allow: true,
    detail: `egress permitted for ${request.egressClass}`,
    redactionEvidenceId: scrubbed.redactionEvidenceId,
    outboundAttempts: 1,
  };
}

/** The metric labels this deployment permits (VG-ERR-070). A label outside this set is refused. */
export const PERMITTED_METRIC_LABELS: readonly string[] = Object.freeze(['code', 'class', 'category', 'tenantId', 'reason']);

export function assertMetricLabels(labels: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(labels)) {
    if (!PERMITTED_METRIC_LABELS.includes(name)) {
      throw new Error(
        `metric label "${name}" is not permitted: VG-ERR-070 restricts labels to ${PERMITTED_METRIC_LABELS.join(', ')}, and a label carrying a case, subject or action id is how PII reaches a metric backend`,
      );
    }
    // The REASON label is an enum, never free text: free text is where a subject reference travels.
    if (name === 'reason' && !/^[A-Z][A-Z0-9_]{2,40}$/.test(value)) {
      throw new Error(`metric label "reason" must be a declared enum value, and "${value}" is free text`);
    }
    // A tenant id is permitted; a subject or case reference is not, and both are opaque UUIDs — so the check is on the
    // label NAME, which is what this function does above.
  }
}

/** The log/trace field names that may never carry a secret or PII (SPEC-006 §8). */
export const FORBIDDEN_LOG_FIELDS: readonly string[] = Object.freeze([
  'secret',
  'clientSecret',
  'sessionSecret',
  'authorization',
  'cookie',
  'token',
  'identifierValue',
  'displayRef',
  'email',
  'phone',
]);

export function assertNoSecretInLogFields(fields: Readonly<Record<string, unknown>>): void {
  for (const name of Object.keys(fields)) {
    if (FORBIDDEN_LOG_FIELDS.includes(name)) {
      throw new Error(
        `"${name}" may not be logged: SPEC-006 §8 forbids a secret or PII in a log event, an error body, a metric label or a trace attribute`,
      );
    }
  }
}

/**
 * A static secret needs a recorded, time-bounded exception (VG-AUTH-011…013). The exception is a value here rather than a
 * flag, so a caller cannot hold a static key without one.
 */
export interface StaticSecretException {
  readonly reason: string;
  readonly owner: string;
  readonly expiresAt: string;
}

export function assertStaticSecretException(exception: StaticSecretException | undefined, now: string): void {
  if (exception === undefined) {
    throw new Error('a static secret requires a recorded time-bounded exception with an owner and a reason (VG-AUTH-011)');
  }
  if (exception.expiresAt <= now) {
    throw new Error(`the static-secret exception expired at ${exception.expiresAt}, so the secret must be rotated to a workload identity`);
  }
  if (exception.owner.trim().length === 0 || exception.reason.trim().length === 0) {
    throw new Error('the exception must name an owner and a reason: an exception nobody owns is one nobody reviews');
  }
}
