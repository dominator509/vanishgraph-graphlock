/**
 * The wire shapes the portal reads, as SPEC-003 declares them (EP-005 M5).
 *
 * EVERY FIELD HERE WAS TAKEN FROM THE SPECIFICATION'S OWN RESPONSE TEXT, and `tests/contract/portal-api-contract.test.ts`
 * asserts that each declared name appears in SPEC-003 — so a field invented by habit fails a test rather than reaching a
 * surface. The test states its own limit: it proves a name is SOMEWHERE in the contract, not that it is in the right
 * section, which is what the per-section comments below are for.
 *
 * THE UI DECLARES ITS OWN TYPES RATHER THAN IMPORTING THE SERVER'S. `scripts/import-boundary.sh` rule 4 forbids
 * `ui/src/**` from importing `src/domain|adapters|http|infrastructure`, and that rule exists because a browser bundle
 * that reaches into the domain is a bundle that ships the domain's internals. The cost of the rule is this file: a
 * deliberately narrow view of the contract, listing only the fields a surface renders.
 *
 * FIELDS THE SURFACES DO NOT USE ARE NOT DECLARED. A complete mirror of every response would be a second contract to
 * keep in step, and the first field anyone adds to it would be one nobody reads.
 */

import type { TruthStateToken } from '../copy/truth-state.ts';

/** SPEC-003 §2.5's collection envelope, which every collection route returns. */
export interface Page {
  readonly limit: number;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly sort?: string;
  readonly filter?: Readonly<Record<string, unknown>>;
}

export interface Collection<T> {
  readonly data: readonly T[];
  readonly page?: Page;
}

/** SPEC-003 §5.5.1: the confidence object, which is "always the object, never a bare number". */
export interface WireConfidence {
  readonly value: number;
  readonly basis: readonly { readonly feature: string; readonly weight: number }[];
}

/** SPEC-003 §5.5.1/§5.5.2: an exposure row, and the detail row that adds the fields below it. */
export interface WireExposure {
  readonly exposureId: string;
  readonly subjectRef: string;
  readonly sourceId: string;
  readonly sourceRecordId: string;
  readonly truthState: TruthStateToken;
  readonly confidence: WireConfidence;
  readonly caseRef: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  /** §5.5.2 only: the id of the removed event this exposure reappeared from, or `null`. */
  readonly reappearanceOf?: string | null;
  readonly truthStateChangedAt?: string;
}

/** SPEC-003 §5.7.3/§5.7.2: a case row, and the deadline summary it embeds. */
export interface WireCaseDeadlineRef {
  readonly deadlineId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly state: string;
}

export interface WireCase {
  readonly caseId: string;
  readonly subjectRef: string;
  readonly sourceId: string;
  readonly exposureId: string;
  readonly truthState: TruthStateToken;
  readonly channel: string;
  readonly actionCount: number;
  readonly verificationCount: number;
  readonly nextDeadline: WireCaseDeadlineRef | null;
  readonly updatedAt: string;
  readonly truthStateChangedAt?: string;
  readonly lastTransition?: { readonly transitionCode: string };
  readonly evidenceArtifactIds?: readonly string[];
}

/** SPEC-003 §5.7.6: one row of the append-only timeline. */
export interface WireTimelineRow {
  readonly at: string;
  readonly kind:
    | 'EXTERNAL_ACTION'
    | 'CONTROLLER_RESPONSE'
    | 'VERIFICATION_OBSERVATION'
    | 'TRANSITION'
    | 'EVIDENCE_ARTIFACT'
    | 'DEADLINE'
    | 'REAPPEARANCE'
    | 'HUMAN_GATE';
  readonly refId: string;
  readonly truthStateAfter: TruthStateToken;
  readonly summary: string;
  readonly correlationId: string;
}

/** SPEC-003 §5.13.1: a deadline, with the policy version and rule it was derived from. */
export interface WireDeadline {
  readonly deadlineId: string;
  readonly caseId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly derivedFrom: { readonly policyVersion: string; readonly ruleCode: string };
  readonly state: string;
  readonly satisfiedAt: string | null;
  readonly overdueSeconds: number;
}

/** SPEC-003 §5.9.2: a controller response row, whose only declared field is the claim flag. */
export interface WireControllerResponse {
  readonly controllerResponseId?: string;
  readonly claimedOutcome?: string;
  readonly claimedOutcomeIsObservation: boolean;
}

/** SPEC-003 §5.2.2: an authority grant row. `state` here is a validity classification, never a truth state. */
export interface WireAuthorityGrant {
  readonly authorityGrantId: string;
  readonly kind: 'SELF' | 'AGENT' | 'PARENT_GUARDIAN' | 'LEGAL_REPRESENTATIVE';
  readonly scope: readonly string[];
  readonly evidenceArtifactId: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly state: 'VALID' | 'EXPIRED' | 'REVOKED';
  readonly daysUntilExpiry: number;
}

/** SPEC-003 §5.12.1/§5.12.2: evidence metadata. NEVER content. */
export interface WireEvidenceArtifact {
  readonly evidenceArtifactId: string;
  readonly digest: string;
  readonly digestVerified: boolean;
  readonly kind: string;
  readonly storageRef: string;
  readonly capturedAt: string;
  /**
   * THE STORED TOKEN, DECLARED AS A STRING RATHER THAN A UNION, and that is a measured decision: §5.12.1 declares
   * `UNREDACTED|DLP_SCRUBBED` while the `evidence_artifact.redaction_state` CHECK constraint accepts
   * `NONE|SCRUBBED|DENIED` (recorded in ASSUMPTIONS §3.x and asserted by the EP-004 read route). A union here would
   * make the UI refuse a value the API legitimately returns; the surface renders the token verbatim and says what it
   * means, and `tests/contract/portal-api-contract.test.ts` records the conflict rather than hiding it.
   */
  readonly redactionState: string;
  readonly sizeBytes: number;
  readonly immutable: boolean;
  readonly linkedCaseIds: readonly string[];
  readonly linkedTraceability?: {
    readonly requirementIds: readonly string[];
    readonly caseIds: readonly string[];
    readonly transitionIds: readonly string[];
  };
}

/** SPEC-003 §5.1.3: the subject read the portal's header renders. */
export interface WireSubject {
  readonly subjectId: string;
  readonly displayRef: string;
  readonly jurisdiction: string;
  readonly authorityState: 'VALID' | 'EXPIRED' | 'REVOKED' | 'NONE';
  readonly openCaseCount: number;
  readonly aliasesCount: number;
  readonly identifiersCount: number;
}

/**
 * SPEC-003 §5.4.3: a discovery run, whose coverage block is what the coverage renderer consumes.
 *
 * THE NAMES ARE THE SPECIFICATION'S, INCLUDING THE ONE THAT IS EASY TO GET WRONG: the denominator is
 * `coverage.sourcesDeclared`, and this section declares NO `sourcesTotal` and NO catalogue version. The UI therefore
 * cannot invent either — see `ui/src/api/portal.ts`, which maps `sourcesDeclared` to the renderer's denominator and
 * passes `null` where the response declares nothing.
 */
export interface WireDiscoveryRun {
  readonly discoveryRunId: string;
  readonly runState: 'ACCEPTED' | 'RUNNING' | 'COMPLETED' | 'COMPLETED_PARTIAL' | 'FAILED' | 'HUMAN_REQUIRED';
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly coverage: {
    readonly sourcesDeclared: number;
    readonly sourcesAttempted: number;
    readonly sourcesSucceeded: number;
    readonly sourcesSkipped: readonly { readonly sourceId: string; readonly reason: string }[];
    readonly coverageBounds: { readonly complete: boolean; readonly checkedFraction: number };
  };
}

/** SPEC-003 §5.14.1's response: an appeal escalation that has created no external effect. */
export interface WireAppealEscalation {
  readonly appealEscalationId: string;
  readonly caseId: string;
  readonly kind: string;
  readonly requiresHumanReview: boolean;
  readonly reviewState: string;
  readonly artifactIds: readonly string[];
  readonly createdAt: string;
  readonly externalEffect: boolean;
}
