# SPEC-001 — Core Domain Model, Invariants, and Removal State Machine

Status: SPECIFICATION (normative).
Depends on: SPEC-000 (vocabulary lock and truth model). SPEC-000 wins on conflict.

This file defines the domain layer. Per `ARCHITECTURE.md` code law, the domain
layer imports **only the standard library** — no framework, no database client,
no HTTP, no model SDK. Domain rules are pure and independently testable.

---

## 1. Layer contract

| Layer | May import | Must not import |
|---|---|---|
| `domain` | standard library only | application, adapters, infrastructure, frameworks |
| `application` | domain | adapters, infrastructure, HTTP, DB drivers |
| `adapters` | domain, application ports | concrete infrastructure composition |
| `http` / `ui` / `mcp` | application contracts | domain internals, adapters directly |
| `infrastructure` | everything (composition root) | — |

Enforcement: an import-boundary test fails the build when a lower layer imports
a higher one (VG-REL-004). This is a hard gate, not a convention.

## 2. Value objects

Immutable, self-validating, equality by value. Construction of an invalid value
throws a typed domain error (SPEC-006) rather than coercing.

| Value object | Shape | Validation |
|---|---|---|
| `SubjectId`, `TenantId`, `CaseId`, `ExposureId`, `SourceId`, `RecipeId`, `ActionId`, `EvidenceId` | opaque string | non-empty, canonical format; never a raw PII value |
| `Confidence` | decimal 0.00–1.00 | in range; carries a non-empty `basis[]` |
| `IdempotencyKey` | string | non-empty, stable across retries, unique per intended effect |
| `TruthState` | enum of the 11 SPEC-000 §5 states | must be a member; no ad-hoc values |
| `ChannelPriority` | integer 1–8 | must match SPEC-000 §8 |
| `PermissionClass` | enum `READ_ONLY`, `WRITE_PERMITTED`, `WRITE_UNCLEAR`, `PROHIBITED` | — |
| `EgressClass` | enum `NONE`, `OPAQUE_ID`, `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, `AUTH_SECRET` | — |
| `EvidenceDigest` | SHA-256 hex | 64 lowercase hex chars |
| `Jurisdiction` | ISO 3166-2 code | uppercase; must resolve to a policy row |
| `LegalBasis` | enum from versioned policy data | must exist in the policy version in force |
| `ObservationWindow` | duration + method | method non-empty; duration > 0 |
| `Money` | minor units + currency | no float arithmetic |

**Rule:** `Confidence` cannot exist without a `basis`. A score with no recorded
basis is unrepresentable, which makes VG-IDENT-003 true by construction.

## 3. Entities

The 28 entities from the research brief, grouped by aggregate. Every entity is
tenant-scoped except `Tenant` itself.

### 3.1 Identity aggregate
| Entity | Key fields | Invariants |
|---|---|---|
| `Tenant` | id, name, policy refs, status | one tenant per isolation boundary |
| `ProtectedSubject` | id, tenantId, displayRef, jurisdiction, isMinor, status | requires ≥1 valid `AuthorityGrant` (VG-IDENT-001); `isMinor` forces the strict lane (VG-POLICY-004) |
| `AuthorityGrant` | id, subjectId, kind, scope[], evidenceId, issuedAt, expiresAt, revokedAt | unexpired at use (VG-AUTHZ-001); `AGENT` kind requires signed instrument (VG-AUTHZ-002) |
| `Alias` | id, subjectId, value, provenance, method, addedAt | one subject per alias or quarantined (VG-IDENT-002) |
| `Identifier` | id, subjectId, kind, valueEnc, provenance | encrypted at rest; never logged |
| `LocationHistory` | id, subjectId, jurisdiction, from, to, provenance | drives jurisdiction policy resolution |

### 3.2 Source aggregate
| Entity | Key fields | Invariants |
|---|---|---|
| `Source` | id, name, class, jurisdiction, permissionClass, freshnessAt | `WRITE_UNCLEAR` ⇒ no writes (VG-CHANNEL-002) |
| `SourceCatalogEntry` | id, sourceId, category, coverageNotes, provenance, license | licence recorded (LICENSE_POLICY) |
| `RemovalRecipe` | id, sourceId, version, signature, channel, verificationMethod, freshnessAt, enabled | signed + fresh to write (VG-CHANNEL-003) |
| `SourceRecord` | id, sourceId, rawRef, observedAt, contentHash, taint | tainted if from untrusted content (VG-SEC-001) |
| `Exposure` | id, subjectId, sourceRecordId, confidence, truthState, caseId | confidence with basis; one current truth state |

### 3.3 Policy aggregate
| Entity | Key fields | Invariants |
|---|---|---|
| `JurisdictionPolicy` | id, jurisdiction, version, effectiveFrom, effectiveTo, rules[] | versioned data; model output cannot author it (VG-POLICY-001) |
| `PolicyDecision` | id, caseId, jurisdiction, legalBasis, channel, policyVersion, reasons[], decidedAt | all four fields present (VG-POLICY-002) |
| `Controller` | id, name, kind, jurisdiction, contactRefs[] | — |

### 3.4 Action aggregate
| Entity | Key fields | Invariants |
|---|---|---|
| `RequestCase` | id, subjectId, exposureId, sourceId, truthState, authorityGrantId, policyDecisionId | state machine governs transitions |
| `ExternalAction` | id, caseId, channel, idempotencyKey, attempt, status, ambiguity | exactly one key (VG-ACTION-001); ambiguity ⇒ reconcile (VG-ACTION-002) |
| `EmailThread` | id, caseId, messageIds[], direction, receivedAt | threading preserved for deadline logic |
| `MailPiece` | id, caseId, templateVersion, templateHash, provider, trackingId, deliveryStatus | hash + tracking required (VG-ACTION-004) |
| `Deadline` | id, caseId, kind, dueAt, source, satisfiedAt | derived from policy version, not hard-coded |
| `ControllerResponse` | id, caseId, kind, bodyRef, receivedAt, claimedOutcome | a claim, not an observation (VG-VERIFY-004) |
| `VerificationObservation` | id, caseId, method, observedAt, actorIdentity, finding, evidenceId | independent path + method match (VG-VERIFY-001/003) |
| `AppealEscalation` | id, caseId, kind, requiresHumanReview, artifactIds[] | human/counsel review required (VG-CHANNEL-001 #7) |
| `Reappearance` | id, exposureId, priorRemovedEventId, observedAt, evidenceId | links to prior `VERIFIED_REMOVED` (VG-REAPPEAR-001) |

### 3.5 Evidence, audit, operations
| Entity | Key fields | Invariants |
|---|---|---|
| `EvidenceArtifact` | id, caseId, kind, digest, storageRef, capturedAt, redactionState | content-addressed, immutable (VG-EVIDENCE-001) |
| `AuditEvent` | id, tenantId, actor, action, target, at, correlationId | append-only (VG-EVIDENCE-003) |
| `ProviderTransportRun` | id, provider, authMode, egressClass, startedAt, outcome, costRef | official transports only (ADR-004) |
| `RepairCapsule` | id, fingerprint, sanitizedEvidence, expected, actual, prRef | DLP-scrubbed before egress (VG-EGRESS-002) |

**Raw PII is never a primary key, never a log field, and never a metric label.**
Entities reference PII by encrypted `Identifier` rows or opaque IDs.

## 4. The Universal Removal State Machine

One machine governs `Exposure` and `RequestCase`. Transitions are **explicit and
closed**: any transition not listed in §4.1 is illegal and must be refused with a
typed `IllegalTransition` error, leaving state unchanged.

### 4.1 Legal transitions

| # | From | To | Guard (all must hold) | Evidence produced |
|---|---|---|---|---|
| T1 | *(new)* | `DISCOVERED_CANDIDATE` | record retrieved from a permitted read path | `SourceRecord` + observation |
| T2 | *(new)* | `VERIFIED_NOT_PRESENT` | valid, complete-enough scan observed no confirmed listing | coverage bounds + scan evidence |
| T3 | `DISCOVERED_CANDIDATE` | `MATCH_CONFIRMED` | `Confidence` ≥ policy threshold **and** basis recorded, **or** human approval | match basis record |
| T4 | `DISCOVERED_CANDIDATE` | `VERIFIED_NOT_PRESENT` | assessment disproved subject match | disproof record |
| T5 | `MATCH_CONFIRMED` | `REQUEST_READY` | authority valid + `PolicyDecision` complete + recipe signed & fresh + channel permitted | `PolicyDecision` |
| T6 | `MATCH_CONFIRMED` | `NOT_REMOVABLE` | exemption/public-record/FCRA limit recorded | exemption basis |
| T7 | `MATCH_CONFIRMED` | `HUMAN_REQUIRED` | legitimate human/identity gate detected | gate classification |
| T8 | `REQUEST_READY` | `REQUEST_SUBMITTED` | `IdempotencyKey` assigned, budget available, authority re-asserted at execution | `ExternalAction` |
| T9 | `REQUEST_READY` | `HUMAN_REQUIRED` | gate or authority defect found at execution time | gate record |
| T10 | `REQUEST_READY` | `NOT_REMOVABLE` | policy re-resolution finds no lawful path | basis |
| T11 | `REQUEST_SUBMITTED` | `ACKNOWLEDGED` | provider/controller response received (may be a claim only) | `ControllerResponse` |
| T12 | `REQUEST_SUBMITTED` | `HUMAN_REQUIRED` | response demands human/legal step | gate record |
| T13 | `REQUEST_SUBMITTED` | `NOT_REMOVABLE` | lawful refusal with recorded basis | refusal basis |
| T14 | `ACKNOWLEDGED` | `VERIFIED_REMOVED` | independent observation, required window elapsed, method matches recipe, record not found | `VerificationObservation` |
| T15 | `ACKNOWLEDGED` | `NOT_REMOVABLE` | controller refusal is lawful and final | refusal basis |
| T16 | `ACKNOWLEDGED` | `HUMAN_REQUIRED` | controller requires human step | gate record |
| T17 | `VERIFIED_REMOVED` | `REAPPEARED` | scheduled re-observation finds the record again | `Reappearance` + evidence |
| T18 | `REAPPEARED` | `REQUEST_READY` | fresh authority + fresh policy + fresh recipe | new `PolicyDecision` |
| T19 | `REAPPEARED` | `NOT_REMOVABLE` | no lawful path on re-attempt | basis |
| T20 | `SEARCH_DELISTED` | `REAPPEARED` | search result returns again | search observation |
| T21 | `MATCH_CONFIRMED` | `SEARCH_DELISTED` | search-engine source and delisting observed | search observation |

### 4.2 Explicitly illegal transitions

These must never succeed (each has a dedicated negative test — DOD-018):

| Illegal transition | Why it is forbidden |
|---|---|
| `REQUEST_SUBMITTED` → `VERIFIED_REMOVED` | No acknowledgment or observation; would be removal theater (VG-VERIFY-004). |
| `REQUEST_READY` → `VERIFIED_REMOVED` | No action was taken. |
| `ACKNOWLEDGED` → `VERIFIED_REMOVED` without `VerificationObservation` | Controller claim treated as proof. |
| `MATCH_CONFIRMED` → `REQUEST_SUBMITTED` | Skips authority/policy gate. |
| `DISCOVERED_CANDIDATE` → `REQUEST_READY` | Skips identity confirmation. |
| `SEARCH_DELISTED` → `VERIFIED_REMOVED` | Collapses search and source effects (SPEC-000 §5.1). |
| `VERIFIED_REMOVED` → `VERIFIED_REMOVED` (re-observation by the acting path) | Acting path cannot verify itself (VG-VERIFY-001). |
| `VERIFIED_NOT_PRESENT` → `VERIFIED_REMOVED` | Nothing was removed. |
| Any transition while authority is expired/revoked | VG-AUTHZ-001. |
| Any write transition while recipe is stale/unsigned | VG-CHANNEL-003. |

### 4.3 State machine invariants

- **SM-1** Exactly one current truth state per exposure at any time.
- **SM-2** Every transition appends an `AuditEvent` (append-only).
- **SM-3** Every transition carries the evidence named in §4.1 or it is refused.
- **SM-4** Terminal-for-now states: `VERIFIED_REMOVED`, `VERIFIED_NOT_PRESENT`,
  `NOT_REMOVABLE`. They remain re-observable; `VERIFIED_REMOVED` is revocable by
  `REAPPEARED`, which is the point of monitoring.
- **SM-5** `HUMAN_REQUIRED` is not a failure state and must not decrement
  success metrics (VG-OBS-002).
- **SM-6** No state may be set directly by an adapter, HTTP handler, or model
  output; only a domain command may transition state.

## 5. Domain ports (implemented by adapters in later nodes)

Interfaces only — the domain declares them; infrastructure satisfies them.

| Port | Responsibility |
|---|---|
| `Clock` | injectable time; enables deterministic window tests |
| `IdGenerator` | opaque ID creation |
| `EvidenceStore` | content-addressed put/get with digest verification |
| `SourceReader` | read-only observation of a `Source` |
| `ChannelWriter` | perform one `ExternalAction` under a recipe + idempotency key |
| `IndependentObserver` | observation via a path distinct from the acting path |
| `PolicyRepository` | versioned jurisdiction policy lookup |
| `AuditSink` | append-only event sink |
| `EgressGate` | classify and gate data before any egress |
| `SecretResolver` | secret access without DB persistence |

`Clock` and `IdGenerator` are injected so that VG-VERIFY-002 (observation
window) and VG-REAPPEAR-001 (scheduled re-observation) are testable without
sleeping and without real network — while still being *real* logic, not mocks of
the thing under test (DOD-010 permits doubles for isolation, not as final proof).

## 6. Domain commands

| Command | Effect | Emits |
|---|---|---|
| `RegisterSubject` | validate authority → create subject | `SubjectRegistered` |
| `AttachAlias` | attach or quarantine alias | `AliasAttached` / `AliasQuarantined` |
| `RecordSourceRecord` | create observation | `SourceRecordObserved` |
| `AssessMatch` | score with basis → T3/T4 | `MatchConfirmed` / `MatchDisproved` |
| `ResolvePolicy` | jurisdiction + basis + channel → `PolicyDecision` | `PolicyResolved` |
| `PrepareRequest` | T5 guard evaluation | `RequestReady` |
| `ExecuteAction` | idempotent external effect → T8 | `ActionSubmitted` |
| `RecordControllerResponse` | → T11/T12/T13 | `Acknowledged` / `HumanGateRaised` / `Refused` |
| `RecordVerification` | independent observation → T14 or refusal | `VerifiedRemoved` / `VerificationFailed` |
| `DetectReappearance` | → T17 | `Reappeared` |
| `RequestHumanGate` | → any `HUMAN_REQUIRED` transition | `HumanRequired` |

Each command: validates preconditions, applies exactly one transition, appends
audit, and is idempotent where it has an external effect.

## 7. Domain events

Immutable facts, past tense, carrying `correlationId` and `tenantId`:
`SubjectRegistered`, `AuthorityGranted`, `AuthorityRevoked`, `AliasAttached`,
`AliasQuarantined`, `SourceRecordObserved`, `MatchConfirmed`, `MatchDisproved`,
`PolicyResolved`, `RequestReady`, `ActionSubmitted`, `ActionAmbiguous`,
`Acknowledged`, `Refused`, `HumanRequired`, `VerifiedRemoved`,
`VerificationFailed`, `Reappeared`, `NotRemovable`, `SearchDelisted`,
`EvidenceStored`, `BudgetExceeded`.

Events are the only channel by which the application layer reacts to domain
change; the domain never calls outward.

## 8. Acceptance for this specification

This spec is satisfied when, for the domain layer alone:

1. Every value object rejects invalid input with a typed error (§2).
2. Every legal transition (T1–T21) succeeds with its guard satisfied.
3. Every illegal transition (§4.2) is refused and leaves state unchanged.
4. SM-1 … SM-6 hold as executable assertions.
5. The import-boundary test proves the domain imports only the standard library.
6. A mutation of any guard causes at least one test to fail (DOD-018).

Items 1–4 and 6 are unit-testable without infrastructure, which is why EP-002
precedes EP-003/EP-004. Item 5 is enforced by a static check in `lint`.
