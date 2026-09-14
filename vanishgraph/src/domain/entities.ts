/**
 * Domain entities (SPEC-001 §3).
 *
 * Every entity is an immutable value-shaped record created through a validating factory.
 * The factories exist so that the invariant column of SPEC-001 §3 is enforced at the only
 * moment it can be enforced cheaply: construction. A `ProtectedSubject` without a valid
 * `AuthorityGrant` is not a subject with a warning attached — it is unrepresentable.
 *
 * Everything here is pure: no I/O, no clock reads, no randomness, no persistence. Time is
 * always passed in, which is what makes observation windows and reappearance testable
 * without sleeping (SPEC-001 §5).
 *
 * Naming note (see EP-002 §4): SPEC-001 §3.4/§3.5 name a `provider` field, while
 * SPEC-000 §4 lists `provider` as a forbidden synonym for `Source`. The mandated entity
 * name `ProviderTransportRun` is kept; the ambiguous bare field is `transportName` (the
 * postal or transport service, which is not a `Source`).
 */

import {
  AuthorityExpired,
  AuthorityMissing,
  HumanGateRequired,
  InvalidValueObject,
} from './errors.ts';
import {
  ActionId,
  CaseId,
  EvidenceId,
  ExposureId,
  RecipeId,
  SourceId,
  SubjectId,
  TenantId,
} from './identifiers.ts';
import type { TruthState } from './truth-state.ts';
import {
  Confidence,
  EvidenceDigest,
  IdempotencyKey,
  Jurisdiction,
  LegalBasis,
  Money,
  containsApparentPii,
  permitsAutomatedWrite,
  type ChannelName,
  type EgressClass,
  type PermissionClass,
} from './values.ts';

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

function freeze<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function requireText(kind: string, field: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidValueObject(kind, `${field} must be a non-empty string`);
  }
}

function requireExact(kind: string, field: string, value: string): void {
  requireText(kind, field, value);
  if (value !== value.trim()) {
    throw new InvalidValueObject(kind, `${field} must not have surrounding whitespace`);
  }
}

function requireOneOf<T extends string>(
  kind: string,
  field: string,
  value: string,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidValueObject(
      kind,
      `${field} must be one of ${allowed.join(', ')}; received ${String(value)}`,
    );
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Identity aggregate (SPEC-001 §3.1)
// ---------------------------------------------------------------------------

export type TenantStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type SubjectStatus = 'ACTIVE' | 'ARCHIVED' | 'ERASED';
export type AuthorityKind = 'SELF' | 'AGENT' | 'PARENT_GUARDIAN' | 'LEGAL_REPRESENTATIVE';

export interface Tenant {
  readonly id: TenantId;
  readonly name: string;
  /** One tenant is one isolation boundary; policy references are versioned data. */
  readonly status: TenantStatus;
  readonly policyRefs: readonly string[];
}

export interface AuthorityGrant {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly kind: AuthorityKind;
  readonly scope: readonly string[];
  readonly evidenceId: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly revokedAtMs: number | null;
  readonly signedInstrument: boolean;
}

export interface ProtectedSubject {
  readonly id: SubjectId;
  readonly tenantId: TenantId;
  /** Opaque label only: never a raw name (SPEC-001 §3 closing rule). */
  readonly displayRef: string;
  readonly jurisdiction: Jurisdiction;
  readonly isMinor: boolean;
  readonly status: SubjectStatus;
  readonly authorityGrantIds: readonly string[];
}

export interface Alias {
  readonly id: string;
  readonly tenantId: TenantId;
  /** `null` means quarantined: an ambiguous alias is never auto-attached (VG-IDENT-002). */
  readonly subjectId: string | null;
  readonly valueEncRef: string;
  readonly valueHmac: string;
  readonly provenance: string;
  readonly method: string;
  readonly quarantined: boolean;
  readonly addedAtMs: number;
}

export interface Identifier {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly kind: string;
  /** A storage reference to ciphertext, never the cleartext value. */
  readonly valueEncRef: string;
  readonly keyVersion: number;
  readonly provenance: string;
}

export interface LocationHistory {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly jurisdiction: Jurisdiction;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number | null;
  readonly provenance: string;
}

// ---------------------------------------------------------------------------
// Source aggregate (SPEC-001 §3.2)
// ---------------------------------------------------------------------------

export interface Source {
  readonly id: SourceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly class: string;
  readonly jurisdiction: Jurisdiction | null;
  readonly permissionClass: PermissionClass;
  readonly permissionCheckedAtMs: number | null;
}

export interface SourceCatalogEntry {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly category: string;
  readonly coverageNotes: string;
  readonly provenance: string;
  readonly license: string;
}

export interface RemovalRecipe {
  readonly id: RecipeId;
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly version: number;
  readonly signature: string;
  readonly channel: ChannelName;
  readonly verificationMethod: string;
  readonly freshnessAtMs: number;
  readonly enabled: boolean;
}

export interface SourceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly sourceId: SourceId;
  readonly rawRef: string;
  readonly observedAtMs: number;
  readonly contentHash: EvidenceDigest;
  /** Untrusted remote content is tainted by default (VG-SEC-001). */
  readonly tainted: boolean;
}

export interface Exposure {
  readonly id: ExposureId;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly sourceRecordId: string;
  readonly confidence: Confidence;
  readonly truthState: TruthState;
  readonly caseId: string | null;
}

// ---------------------------------------------------------------------------
// Policy aggregate (SPEC-001 §3.3)
// ---------------------------------------------------------------------------

export type ControllerKind =
  | 'PLATFORM'
  | 'PUBLISHER'
  | 'REGISTRY'
  | 'GOVERNMENT_AGENCY'
  | 'OTHER_CONTROLLER';

/** Who authored a jurisdiction policy. Model output is not on the list (VG-POLICY-001). */
export type PolicyProvenance = 'COUNSEL_REVIEWED' | 'OPERATOR_ENTERED';

export interface JurisdictionPolicy {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly jurisdiction: Jurisdiction;
  readonly version: number;
  readonly effectiveFromMs: number;
  readonly effectiveToMs: number | null;
  readonly rules: readonly string[];
  readonly provenance: PolicyProvenance;
}

export interface PolicyDecision {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: string;
  readonly jurisdiction: Jurisdiction;
  readonly legalBasis: LegalBasis;
  readonly channel: ChannelName;
  readonly policyVersion: number;
  readonly reasons: readonly string[];
  readonly decidedAtMs: number;
}

export interface Controller {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly kind: ControllerKind;
  readonly jurisdiction: Jurisdiction | null;
  readonly contactRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Action aggregate (SPEC-001 §3.4)
// ---------------------------------------------------------------------------

export type ExternalActionStatus = 'PREPARED' | 'SUBMITTED' | 'AMBIGUOUS' | 'REFUSED';
export type ObservationFinding = 'PRESENT' | 'ABSENT' | 'INCONCLUSIVE';
export type DeliveryStatus = 'NOT_SENT' | 'SENT' | 'DELIVERED' | 'RETURNED' | 'UNKNOWN';

export interface RequestCase {
  readonly id: CaseId;
  readonly tenantId: TenantId;
  readonly subjectId: SubjectId;
  readonly exposureId: ExposureId;
  readonly sourceId: SourceId;
  readonly authorityGrantId: string;
  readonly policyDecisionId: string | null;
  readonly truthState: TruthState;
}

export interface ExternalAction {
  readonly id: ActionId;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly channel: ChannelName;
  readonly idempotencyKey: IdempotencyKey;
  readonly attempt: number;
  readonly status: ExternalActionStatus;
  /** An ambiguous result must be reconciled, never blindly retried (VG-ACTION-002). */
  readonly ambiguous: boolean;
  readonly submittedAtMs: number | null;
}

export interface EmailThread {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly messageIds: readonly string[];
  readonly direction: 'OUTBOUND' | 'INBOUND';
  readonly receivedAtMs: number | null;
}

export interface MailPiece {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly templateVersion: number;
  readonly templateHash: EvidenceDigest;
  /** SPEC-001 §3.4 calls this field `provider`; see the naming note at the top. */
  readonly transportName: string;
  readonly trackingId: string | null;
  readonly deliveryStatus: DeliveryStatus;
}

export interface Deadline {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly kind: string;
  readonly dueAtMs: number;
  /** Derived from a policy version, never hard-coded (SPEC-001 §3.4). */
  readonly derivationRef: string;
  readonly satisfiedAtMs: number | null;
}

export interface ControllerResponse {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly kind: string;
  readonly bodyRef: string;
  readonly receivedAtMs: number;
  /** A claim, not an observation. It can never satisfy a removal (VG-VERIFY-004). */
  readonly claimedOutcome: TruthState | null;
}

export interface VerificationObservation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly method: string;
  readonly observedAtMs: number;
  readonly actorIdentity: string;
  readonly actingIdentity: string;
  readonly finding: ObservationFinding;
  readonly evidenceId: EvidenceId;
}

export interface AppealEscalation {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly caseId: CaseId;
  readonly kind: string;
  readonly requiresHumanReview: boolean;
  readonly artifactIds: readonly string[];
}

export interface Reappearance {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly exposureId: ExposureId;
  /** The audit event that recorded the prior VERIFIED_REMOVED transition. */
  readonly priorRemovedEventId: string;
  readonly observedAtMs: number;
  readonly evidenceId: EvidenceId;
}

// ---------------------------------------------------------------------------
// Evidence, audit and operations (SPEC-001 §3.5)
// ---------------------------------------------------------------------------

export type RedactionState = 'NONE' | 'SCRUBBED' | 'DENIED';
export type AuthMode = 'OFFICIAL_API' | 'OFFICIAL_FORM' | 'OFFICIAL_MAIL';

export interface EvidenceArtifact {
  readonly id: EvidenceId;
  readonly tenantId: TenantId;
  readonly caseId: string | null;
  readonly kind: string;
  readonly digest: EvidenceDigest;
  readonly storageRef: string;
  readonly egressClass: EgressClass;
  readonly redactionState: RedactionState;
  readonly capturedAtMs: number;
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly actor: string;
  readonly action: string;
  readonly targetKind: string;
  readonly targetId: string | null;
  readonly correlationId: string;
  readonly atMs: number;
  /** Opaque scalars only; apparent PII is refused (VG-SEC-002). */
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProviderTransportRun {
  readonly id: string;
  readonly tenantId: TenantId;
  /** SPEC-001 §3.5 calls this field `provider`; see the naming note at the top. */
  readonly transportName: string;
  readonly authMode: AuthMode;
  readonly egressClass: EgressClass;
  readonly startedAtMs: number;
  readonly outcome: string;
  readonly costRef: Money | null;
}

export interface RepairCapsule {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly fingerprint: string;
  /** DLP-scrubbed before egress: apparent PII is refused at construction (VG-EGRESS-002). */
  readonly sanitizedEvidence: string;
  readonly expected: string;
  readonly actual: string;
  readonly prRef: string | null;
}

// ---------------------------------------------------------------------------
// Factories: the invariant column of SPEC-001 §3, enforced at construction
// ---------------------------------------------------------------------------

export function createTenant(input: {
  id: TenantId;
  name: string;
  status: TenantStatus;
  policyRefs?: readonly string[];
}): Tenant {
  requireText('Tenant', 'name', input.name);
  return Object.freeze({
    id: input.id,
    name: input.name,
    status: requireOneOf('Tenant', 'status', input.status, [
      'ACTIVE',
      'SUSPENDED',
      'CLOSED',
    ] as const),
    policyRefs: freeze(input.policyRefs ?? []),
  });
}

export function createAuthorityGrant(input: {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  kind: AuthorityKind;
  scope: readonly string[];
  evidenceId: string | null;
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  signedInstrument: boolean;
}): AuthorityGrant {
  requireExact('AuthorityGrant', 'id', input.id);
  const kind = requireOneOf('AuthorityGrant', 'kind', input.kind, [
    'SELF',
    'AGENT',
    'PARENT_GUARDIAN',
    'LEGAL_REPRESENTATIVE',
  ] as const);
  if (input.scope.length === 0) {
    throw new InvalidValueObject('AuthorityGrant', 'scope must contain at least one entry');
  }
  if (!Number.isInteger(input.issuedAtMs) || !Number.isInteger(input.expiresAtMs)) {
    throw new InvalidValueObject('AuthorityGrant', 'issuedAtMs and expiresAtMs must be integers');
  }
  if (input.expiresAtMs <= input.issuedAtMs) {
    throw new InvalidValueObject('AuthorityGrant', 'expiresAtMs must be after issuedAtMs');
  }
  // VG-AUTHZ-002: an authorized-agent action needs a signed instrument plus evidence.
  if (kind === 'AGENT' && (!input.signedInstrument || input.evidenceId === null)) {
    throw new InvalidValueObject(
      'AuthorityGrant',
      'kind AGENT requires a signed instrument and a linked EvidenceArtifact (VG-AUTHZ-002)',
    );
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    kind,
    scope: freeze(input.scope),
    evidenceId: input.evidenceId,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
    revokedAtMs: input.revokedAtMs,
    signedInstrument: input.signedInstrument,
  });
}

/** VG-AUTHZ-001: an expired or revoked grant is refused at use. */
export function assertAuthorityUsableAt(grant: AuthorityGrant, atMs: number): void {
  if (grant.revokedAtMs !== null && grant.revokedAtMs <= atMs) {
    throw new AuthorityExpired(grant.id, String(atMs));
  }
  if (atMs >= grant.expiresAtMs) {
    throw new AuthorityExpired(grant.id, String(atMs));
  }
}

/** VG-IDENT-001: a subject cannot be created without a valid grant. */
export function createProtectedSubject(input: {
  id: SubjectId;
  tenantId: TenantId;
  displayRef: string;
  jurisdiction: Jurisdiction;
  isMinor: boolean;
  status: SubjectStatus;
  authority: AuthorityGrant;
  atMs: number;
}): ProtectedSubject {
  requireText('ProtectedSubject', 'displayRef', input.displayRef);
  if (containsApparentPii(input.displayRef)) {
    throw new InvalidValueObject(
      'ProtectedSubject',
      'displayRef must be an opaque label, never a raw name or contact value',
    );
  }
  if (input.authority.subjectId.value !== input.id.value) {
    throw new AuthorityMissing(input.id.value);
  }
  assertAuthorityUsableAt(input.authority, input.atMs);
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    displayRef: input.displayRef,
    jurisdiction: input.jurisdiction,
    isMinor: input.isMinor,
    status: requireOneOf('ProtectedSubject', 'status', input.status, [
      'ACTIVE',
      'ARCHIVED',
      'ERASED',
    ] as const),
    authorityGrantIds: freeze([input.authority.id]),
  });
}

/** VG-POLICY-004: a minor subject cannot enter an automated write lane. */
export function assertStrictLaneForMinor(subject: ProtectedSubject): void {
  if (subject.isMinor) {
    throw new HumanGateRequired(
      'minor subject requires review-required handling',
      'MINOR_REVIEW_LANE',
    );
  }
}

/** SPEC-002 §2: encrypted columns hold ciphertext references, never cleartext. */
function requireEncryptedRef(kind: string, value: string): void {
  requireText(kind, 'valueEncRef', value);
  if (!value.startsWith('enc:')) {
    throw new InvalidValueObject(
      kind,
      'valueEncRef must reference ciphertext (prefix "enc:"); raw PII must not enter the domain',
    );
  }
}

export function createAlias(input: {
  id: string;
  tenantId: TenantId;
  subjectId: string | null;
  valueEncRef: string;
  valueHmac: string;
  provenance: string;
  method: string;
  addedAtMs: number;
}): Alias {
  requireExact('Alias', 'id', input.id);
  requireText('Alias', 'valueHmac', input.valueHmac);
  requireText('Alias', 'provenance', input.provenance);
  requireText('Alias', 'method', input.method);
  requireEncryptedRef('Alias', input.valueEncRef);
  // VG-IDENT-002 / VG-DATA-012: quarantine is exactly the absence of a subject link.
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    subjectId: input.subjectId,
    valueEncRef: input.valueEncRef,
    valueHmac: input.valueHmac,
    provenance: input.provenance,
    method: input.method,
    quarantined: input.subjectId === null,
    addedAtMs: input.addedAtMs,
  });
}

export function createIdentifier(input: {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  kind: string;
  valueEncRef: string;
  keyVersion: number;
  provenance: string;
}): Identifier {
  requireExact('Identifier', 'id', input.id);
  requireText('Identifier', 'kind', input.kind);
  requireText('Identifier', 'provenance', input.provenance);
  requireEncryptedRef('Identifier', input.valueEncRef);
  if (!Number.isInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new InvalidValueObject(
      'Identifier',
      'keyVersion must be a positive integer so rotation does not rewrite history',
    );
  }
  return Object.freeze({ ...input });
}

export function createLocationHistory(input: {
  id: string;
  tenantId: TenantId;
  subjectId: SubjectId;
  jurisdiction: Jurisdiction;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  provenance: string;
}): LocationHistory {
  requireExact('LocationHistory', 'id', input.id);
  requireText('LocationHistory', 'provenance', input.provenance);
  if (input.effectiveToMs !== null && input.effectiveToMs <= input.effectiveFromMs) {
    throw new InvalidValueObject(
      'LocationHistory',
      'effectiveToMs must be after effectiveFromMs when present',
    );
  }
  return Object.freeze({ ...input });
}

export function createSource(input: {
  id: SourceId;
  tenantId: TenantId;
  name: string;
  class: string;
  jurisdiction: Jurisdiction | null;
  permissionClass: PermissionClass;
  permissionCheckedAtMs: number | null;
}): Source {
  requireText('Source', 'name', input.name);
  requireText('Source', 'class', input.class);
  return Object.freeze({ ...input });
}

export function createSourceCatalogEntry(input: {
  id: string;
  tenantId: TenantId;
  sourceId: SourceId;
  category: string;
  coverageNotes: string;
  provenance: string;
  license: string;
}): SourceCatalogEntry {
  requireExact('SourceCatalogEntry', 'id', input.id);
  requireText('SourceCatalogEntry', 'category', input.category);
  requireText('SourceCatalogEntry', 'coverageNotes', input.coverageNotes);
  requireText('SourceCatalogEntry', 'provenance', input.provenance);
  // LICENSE_POLICY: a catalogue entry without a recorded licence is incomplete.
  requireText('SourceCatalogEntry', 'license', input.license);
  return Object.freeze({ ...input });
}

export function createRemovalRecipe(input: {
  id: RecipeId;
  tenantId: TenantId;
  sourceId: SourceId;
  version: number;
  signature: string;
  channel: ChannelName;
  verificationMethod: string;
  freshnessAtMs: number;
  enabled: boolean;
}): RemovalRecipe {
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new InvalidValueObject('RemovalRecipe', 'version must be a positive integer');
  }
  requireText('RemovalRecipe', 'signature', input.signature);
  requireText('RemovalRecipe', 'verificationMethod', input.verificationMethod);
  return Object.freeze({ ...input });
}

/** VG-CHANNEL-003: a recipe must be enabled, signed, and fresh in order to write. */
export function assertRecipeUsableAt(recipe: RemovalRecipe, atMs: number): void {
  if (!recipe.enabled) {
    throw new InvalidValueObject('RemovalRecipe', `recipe ${recipe.id.value} is disabled`);
  }
  if (typeof recipe.signature !== 'string' || recipe.signature.trim().length === 0) {
    throw new InvalidValueObject('RemovalRecipe', `recipe ${recipe.id.value} is unsigned`);
  }
  if (atMs > recipe.freshnessAtMs) {
    throw new InvalidValueObject(
      'RemovalRecipe',
      `recipe ${recipe.id.value} is stale (fresh as of ${recipe.freshnessAtMs}, now ${atMs})`,
    );
  }
}

export function createSourceRecord(input: {
  id: string;
  tenantId: TenantId;
  sourceId: SourceId;
  rawRef: string;
  observedAtMs: number;
  contentHash: EvidenceDigest;
  tainted: boolean;
}): SourceRecord {
  requireExact('SourceRecord', 'id', input.id);
  requireText('SourceRecord', 'rawRef', input.rawRef);
  if (!Number.isInteger(input.observedAtMs)) {
    throw new InvalidValueObject('SourceRecord', 'observedAtMs must be an integer');
  }
  return Object.freeze({ ...input });
}

/** VG-SEC-001: tainted remote content can never direct an action. */
export function assertUntainted(record: SourceRecord, action: string): void {
  if (record.tainted) {
    throw new InvalidValueObject(
      'SourceRecord',
      `tainted content cannot direct ${action} (VG-SEC-001)`,
    );
  }
}

export function createExposure(input: {
  id: ExposureId;
  tenantId: TenantId;
  subjectId: SubjectId;
  sourceRecordId: string;
  confidence: Confidence;
  truthState: TruthState;
  caseId: string | null;
}): Exposure {
  requireExact('Exposure', 'sourceRecordId', input.sourceRecordId);
  return Object.freeze({ ...input });
}

export function createJurisdictionPolicy(input: {
  id: string;
  tenantId: TenantId;
  jurisdiction: Jurisdiction;
  version: number;
  effectiveFromMs: number;
  effectiveToMs: number | null;
  rules: readonly string[];
  provenance: PolicyProvenance;
}): JurisdictionPolicy {
  requireExact('JurisdictionPolicy', 'id', input.id);
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new InvalidValueObject('JurisdictionPolicy', 'version must be a positive integer');
  }
  if (input.rules.length === 0) {
    throw new InvalidValueObject('JurisdictionPolicy', 'rules must not be empty');
  }
  // VG-POLICY-001: a model cannot author a legal basis, so it cannot author a policy.
  const provenance = requireOneOf('JurisdictionPolicy', 'provenance', input.provenance, [
    'COUNSEL_REVIEWED',
    'OPERATOR_ENTERED',
  ] as const);
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    jurisdiction: input.jurisdiction,
    version: input.version,
    effectiveFromMs: input.effectiveFromMs,
    effectiveToMs: input.effectiveToMs,
    rules: freeze(input.rules),
    provenance,
  });
}

/** VG-POLICY-002: all four fields are required before a case may progress. */
export function createPolicyDecision(input: {
  id: string;
  tenantId: TenantId;
  caseId: string;
  jurisdiction: Jurisdiction;
  legalBasis: LegalBasis;
  channel: ChannelName;
  policyVersion: number;
  reasons: readonly string[];
  decidedAtMs: number;
}): PolicyDecision {
  requireExact('PolicyDecision', 'id', input.id);
  requireExact('PolicyDecision', 'caseId', input.caseId);
  if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
    throw new InvalidValueObject('PolicyDecision', 'policyVersion must be a positive integer');
  }
  if (input.legalBasis.policyVersion !== input.policyVersion) {
    throw new InvalidValueObject(
      'PolicyDecision',
      'legalBasis.policyVersion must equal the decision policyVersion',
    );
  }
  return Object.freeze({ ...input, reasons: freeze(input.reasons) });
}

export function createController(input: {
  id: string;
  tenantId: TenantId;
  name: string;
  kind: ControllerKind;
  jurisdiction: Jurisdiction | null;
  contactRefs: readonly string[];
}): Controller {
  requireExact('Controller', 'id', input.id);
  requireText('Controller', 'name', input.name);
  return Object.freeze({ ...input, contactRefs: freeze(input.contactRefs) });
}

export function createRequestCase(input: {
  id: CaseId;
  tenantId: TenantId;
  subjectId: SubjectId;
  exposureId: ExposureId;
  sourceId: SourceId;
  authorityGrantId: string;
  policyDecisionId: string | null;
  truthState: TruthState;
}): RequestCase {
  requireExact('RequestCase', 'authorityGrantId', input.authorityGrantId);
  return Object.freeze({ ...input });
}

export function createExternalAction(input: {
  id: ActionId;
  tenantId: TenantId;
  caseId: CaseId;
  channel: ChannelName;
  idempotencyKey: IdempotencyKey;
  attempt: number;
  status: ExternalActionStatus;
  ambiguous: boolean;
  submittedAtMs: number | null;
}): ExternalAction {
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new InvalidValueObject('ExternalAction', 'attempt must be a positive integer');
  }
  const status = requireOneOf('ExternalAction', 'status', input.status, [
    'PREPARED',
    'SUBMITTED',
    'AMBIGUOUS',
    'REFUSED',
  ] as const);
  if (status === 'AMBIGUOUS' && !input.ambiguous) {
    throw new InvalidValueObject(
      'ExternalAction',
      'status AMBIGUOUS requires ambiguous = true so reconciliation is mandatory (VG-ACTION-002)',
    );
  }
  return Object.freeze({ ...input, status });
}

export function createEmailThread(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  messageIds: readonly string[];
  direction: 'OUTBOUND' | 'INBOUND';
  receivedAtMs: number | null;
}): EmailThread {
  requireExact('EmailThread', 'id', input.id);
  if (input.messageIds.length === 0) {
    throw new InvalidValueObject(
      'EmailThread',
      'messageIds must not be empty; threading is needed for deadline logic',
    );
  }
  return Object.freeze({ ...input, messageIds: freeze(input.messageIds) });
}

export function createMailPiece(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  templateVersion: number;
  templateHash: EvidenceDigest;
  transportName: string;
  trackingId: string | null;
  deliveryStatus: DeliveryStatus;
}): MailPiece {
  requireExact('MailPiece', 'id', input.id);
  if (!Number.isInteger(input.templateVersion) || input.templateVersion < 1) {
    throw new InvalidValueObject('MailPiece', 'templateVersion must be a positive integer');
  }
  requireText('MailPiece', 'transportName', input.transportName);
  return Object.freeze({ ...input });
}

/** VG-ACTION-004: without transport tracking, mail cannot reach ACKNOWLEDGED. */
export function mailCanReachAcknowledged(piece: MailPiece): boolean {
  return piece.trackingId !== null && piece.deliveryStatus !== 'NOT_SENT';
}

export function createDeadline(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  kind: string;
  dueAtMs: number;
  derivationRef: string;
  satisfiedAtMs: number | null;
}): Deadline {
  requireExact('Deadline', 'id', input.id);
  requireText('Deadline', 'kind', input.kind);
  if (!input.derivationRef.startsWith('policy:')) {
    throw new InvalidValueObject(
      'Deadline',
      'derivationRef must name the policy version the deadline derives from (for example policy:7); hard-coded deadlines are refused',
    );
  }
  return Object.freeze({ ...input });
}

export function createControllerResponse(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  kind: string;
  bodyRef: string;
  receivedAtMs: number;
  claimedOutcome: TruthState | null;
}): ControllerResponse {
  requireExact('ControllerResponse', 'id', input.id);
  requireText('ControllerResponse', 'kind', input.kind);
  requireExact('ControllerResponse', 'bodyRef', input.bodyRef);
  return Object.freeze({ ...input });
}

/**
 * VG-VERIFY-001 / VG-VERIFY-003 / VG-DATA-008: an observation is only valid when it
 * comes from a path distinct from the acting path and uses the recipe's method.
 */
export function createVerificationObservation(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  method: string;
  observedAtMs: number;
  actorIdentity: string;
  actingIdentity: string;
  finding: ObservationFinding;
  evidenceId: EvidenceId;
}): VerificationObservation {
  requireExact('VerificationObservation', 'id', input.id);
  requireText('VerificationObservation', 'method', input.method);
  requireExact('VerificationObservation', 'actorIdentity', input.actorIdentity);
  requireExact('VerificationObservation', 'actingIdentity', input.actingIdentity);
  if (input.actorIdentity === input.actingIdentity) {
    throw new InvalidValueObject(
      'VerificationObservation',
      'the acting path cannot verify itself; actorIdentity must differ from actingIdentity (VG-VERIFY-001)',
    );
  }
  const finding = requireOneOf('VerificationObservation', 'finding', input.finding, [
    'PRESENT',
    'ABSENT',
    'INCONCLUSIVE',
  ] as const);
  return Object.freeze({ ...input, finding });
}

export function createAppealEscalation(input: {
  id: string;
  tenantId: TenantId;
  caseId: CaseId;
  kind: string;
  requiresHumanReview: boolean;
  artifactIds: readonly string[];
}): AppealEscalation {
  requireExact('AppealEscalation', 'id', input.id);
  requireText('AppealEscalation', 'kind', input.kind);
  if (!input.requiresHumanReview) {
    throw new InvalidValueObject(
      'AppealEscalation',
      'an appeal or regulator packet always requires human or counsel review (SPEC-000 §8.7)',
    );
  }
  return Object.freeze({ ...input, artifactIds: freeze(input.artifactIds) });
}

/** VG-REAPPEAR-001: a first-ever discovery is never labelled Reappearance. */
export function createReappearance(input: {
  id: string;
  tenantId: TenantId;
  exposureId: ExposureId;
  priorRemovedEventId: string;
  priorState: TruthState;
  observedAtMs: number;
  evidenceId: EvidenceId;
}): Reappearance {
  requireExact('Reappearance', 'id', input.id);
  requireExact('Reappearance', 'priorRemovedEventId', input.priorRemovedEventId);
  if (input.priorState !== 'VERIFIED_REMOVED') {
    throw new InvalidValueObject(
      'Reappearance',
      `Reappearance requires a prior VERIFIED_REMOVED event; received ${input.priorState} (VG-REAPPEAR-001)`,
    );
  }
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    exposureId: input.exposureId,
    priorRemovedEventId: input.priorRemovedEventId,
    observedAtMs: input.observedAtMs,
    evidenceId: input.evidenceId,
  });
}

export function createEvidenceArtifact(input: {
  id: EvidenceId;
  tenantId: TenantId;
  caseId: string | null;
  kind: string;
  digest: EvidenceDigest;
  storageRef: string;
  egressClass: EgressClass;
  redactionState: RedactionState;
  capturedAtMs: number;
}): EvidenceArtifact {
  requireText('EvidenceArtifact', 'kind', input.kind);
  requireExact('EvidenceArtifact', 'storageRef', input.storageRef);
  return Object.freeze({ ...input });
}

/** VG-EVIDENCE-003 / VG-SEC-002: append-only events that carry no apparent PII. */
export function createAuditEvent(input: {
  id: string;
  tenantId: TenantId;
  actor: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  correlationId: string;
  atMs: number;
  payload: Readonly<Record<string, string | number | boolean | null>>;
}): AuditEvent {
  requireExact('AuditEvent', 'id', input.id);
  requireExact('AuditEvent', 'actor', input.actor);
  requireExact('AuditEvent', 'action', input.action);
  requireExact('AuditEvent', 'targetKind', input.targetKind);
  requireExact('AuditEvent', 'correlationId', input.correlationId);
  for (const [key, value] of Object.entries(input.payload)) {
    if (typeof value === 'string' && containsApparentPii(value)) {
      throw new InvalidValueObject(
        'AuditEvent',
        `payload.${key} appears to contain personal data; audit payloads carry opaque identifiers only (VG-SEC-002)`,
      );
    }
  }
  return Object.freeze({ ...input, payload: Object.freeze({ ...input.payload }) });
}

/** ADR-004: official transports only. No scraping, cookie, or session-reuse modes. */
export function createProviderTransportRun(input: {
  id: string;
  tenantId: TenantId;
  transportName: string;
  authMode: AuthMode;
  egressClass: EgressClass;
  startedAtMs: number;
  outcome: string;
  costRef: Money | null;
}): ProviderTransportRun {
  requireExact('ProviderTransportRun', 'id', input.id);
  requireText('ProviderTransportRun', 'transportName', input.transportName);
  requireText('ProviderTransportRun', 'outcome', input.outcome);
  const authMode = requireOneOf('ProviderTransportRun', 'authMode', input.authMode, [
    'OFFICIAL_API',
    'OFFICIAL_FORM',
    'OFFICIAL_MAIL',
  ] as const);
  return Object.freeze({ ...input, authMode });
}

/** VG-EGRESS-002: a repair capsule is DLP-scrubbed before it can leave the boundary. */
export function createRepairCapsule(input: {
  id: string;
  tenantId: TenantId;
  fingerprint: string;
  sanitizedEvidence: string;
  expected: string;
  actual: string;
  prRef: string | null;
}): RepairCapsule {
  requireExact('RepairCapsule', 'id', input.id);
  requireExact('RepairCapsule', 'fingerprint', input.fingerprint);
  for (const field of ['sanitizedEvidence', 'expected', 'actual'] as const) {
    if (containsApparentPii(input[field])) {
      throw new InvalidValueObject(
        'RepairCapsule',
        `${field} still contains apparent personal data; scrub it before egress (VG-EGRESS-002)`,
      );
    }
  }
  return Object.freeze({ ...input });
}

/** VG-CHANNEL-002 helper kept next to the entity it constrains. */
export function sourceMayBeWritten(source: Source): boolean {
  return permitsAutomatedWrite(source.permissionClass);
}
