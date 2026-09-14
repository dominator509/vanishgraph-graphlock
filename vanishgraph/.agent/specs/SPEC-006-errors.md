# SPEC-006 — Error Taxonomy, Failure Classification, and Fail-Closed Handling

Status: SPECIFICATION (normative). Supersedes the stub of the same path.
Depends on: SPEC-000 (vocabulary lock, truth model, acceptance oracle), SPEC-001
(core domain, value objects, state machine), SPEC-003 (`/v1` API contracts — the
wire error envelope and code→status mapping adopted in §6), `ARCHITECTURE.md`,
`SECURITY.md`, `DATA_EGRESS_MATRIX.md`, and the DOD registry (DOD-014, DOD-024,
DOD-026, DOD-032, DOD-001, DOD-008, DOD-018, DOD-025, DOD-027).

SPEC-000 wins on any conflict. §6 adopts SPEC-003 §8.1/§8.2 for the `/v1` wire
surface; findings F-1 … F-6 in §12 record where SPEC-003 and this file had to be
reconciled and what remains open. This file defines **no** application code,
asserts **no** execution, and cites **no** result. Every statement here is a
normative requirement on a future implementation, not evidence that one exists.

Requirement-ID scheme for this file: `VG-ERR-<NNN>`. IDs are permanent, are never
reused or renumbered, and each carries exactly one acceptance oracle and exactly
one required negative case (DOD-001, DOD-008, DOD-014).

---

## 1. Scope and non-claims

This specification governs:

1. the **classification** of every non-success outcome the system can produce
   (§2, §3);
2. the **verification-status taxonomy** the harness must use for every accounted
   ID (§4);
3. the **domain error catalogue** — typed classes, retryability, classification,
   required fields, audit and telemetry behaviour (§5);
4. the **HTTP/API mapping** — envelope shape, stable codes, status codes, safe
   messages (§6);
5. **fail-closed rules** (DOD-014) for this product's specific trust boundaries
   (§7);
6. **no-masking rules** (DOD-024) (§8);
7. **no-PII-in-errors rules** and the DLP pre-egress requirement (§9);
8. **retry, backoff, and the bounded same-signature ladder** (§10).

Nothing in this file may be cited as proof that any error path is implemented,
configured, exercised, or tested. A requirement is satisfied only by executed
evidence from the current candidate epoch, resolved through requirement ID →
test ID → command → observed sentinel/exit code → artifact digest → evidence path
(SPEC-000 §9.2). Reading this file is not evidence.

### 1.1 Import boundary

Per SPEC-001 §1, domain error classes are declared in the `domain` layer and
import only the standard library. HTTP status mapping (§6) lives in the `http`
layer. Therefore:

- **domain error classes never carry an HTTP status code, and never carry a
  human-facing message string**; they carry the fields in §5.1.
- the `http` layer owns the code→status→message table (§6.2) and renders the
  envelope (§6.1);
- an adapter that raises a domain error is asserting a *fact about the domain*,
  never inventing a transport translation.

---

## 2. The three-way distinction (classification law)

Every non-success event in this system is exactly one of three things. Conflating
them is a defect, not a style preference.

| # | Kind | Definition | Indicative examples | Where it is recorded | Metric effect |
|---|---|---|---|---|---|
| A | **Candidate/product outcome** | A legitimate result of a correct run. The system did its job; the honest answer is "this cannot be done (lawfully / by automation / at all)". | `NOT_REMOVABLE`, `HUMAN_REQUIRED`, `VERIFIED_NOT_PRESENT`, `SEARCH_DELISTED`, `NOT_APPLICABLE` | truth state on `Exposure`/`RequestCase`; outcome log; coverage report | eligibility denominator, never the error rate |
| B | **Candidate failure** | The system behaved correctly; the **outside world** did not cooperate. Our code is not broken. | controller refused; source unreachable; upstream rate limit; third-party 5xx; network timeout; response demanded a CAPTCHA; provider rejected the letter | failure record bound to the `ExternalAction`/case, with reconciliation or retry state | candidate-failure rate, per source/channel |
| C | **Harness/system ERROR** | Our own code, configuration, schema, contract, or infrastructure is broken or misconfigured. | unhandled exception; invariant violation; digest mismatch on readback; config missing; migration not applied; dependency unreachable in a way that indicates our setup | `ErrorEvent` (severity `ERROR`/`FATAL`) with `code`, `class`, `retryable`, `classification` | error rate; alerting; release-gate input |

### 2.1 Classification rules (binding)

1. A **candidate outcome is never an error**. `HUMAN_REQUIRED` and
   `NOT_REMOVABLE` must not be raised as exceptions, must not be written to the
   error log, must not carry severity `ERROR`, must not increment any error,
   incident, or failure metric, and must not decrement a success metric
   (SPEC-001 SM-5; SPEC-000 §7.6; VG-OBS-002).
2. A **candidate failure is not a system ERROR**. It is recorded against the case
   with the outside world named as the cause, and it must not be surfaced to
   operators as a defect in our software.
3. A **system ERROR is never dressed as a candidate result**. "We could not reach
   the policy store" is not `NOT_REMOVABLE`; "our DLP gate is down" is not
   `HUMAN_REQUIRED`; "the harness could not provision PostgreSQL" is not a
   candidate `FAIL` (DOD-033).
4. **Misclassification is itself a defect (DOD-032).** A wrong classification
   invalidates the affected row and every accounting total derived from it; it
   must be corrected before final accounting, and it is a critical process
   finding.
5. Classification is a **closed decision**. Every error class in §5 declares
   `classification ∈ {OUTCOME, CANDIDATE_FAILURE, SYSTEM}` and `retryable ∈
   {true, false}` as static metadata; runtime code may not re-decide it.
6. The classification of an event is derived from the **error class**, never from
   the call site, the HTTP transport, or a model's judgement.
7. A `HUMAN_REQUIRED` raised because a legitimate `HumanGate` was detected is an
   outcome (kind A). A `HUMAN_REQUIRED` produced because our recipe signature
   verification crashed is **not** — that is kind C, and the case must not be
   labelled `HUMAN_REQUIRED`.

### 2.2 Negative-test obligation

For every command that can legitimately produce kind A, the acceptance suite must
assert that the outcome path emits **zero** `ErrorEvent` rows and leaves the error
metric unchanged. Producing an error record for a legitimate outcome is a
completed negative case, not a warning (VG-ERR-002, DOD-032).

---

## 3. Where each kind lives in the domain

SPEC-001 §4.2 makes the state machine closed: an unlisted transition is refused
with a typed `IllegalTransition` and state is left unchanged. That refusal is a
**system/contract error** (kind C) when it indicates our own bug, and a
**request-level rejection** when an external caller asked for an illegal move —
in both cases the truth state does not move, and no outcome may be fabricated to
absorb it.

**Outcome fields.** `RequestCase` carries outcome attributes separately from
truth state:

| Field | Meaning | Allowed values |
|---|---|---|
| `outcomeClass` | kind A sub-classification | `REMOVED_VERIFIED`, `NOT_REMOVABLE`, `HUMAN_REQUIRED`, `NOT_PRESENT`, `SEARCH_DELISTED`, `REAPPEARED`, `IN_PROGRESS` |
| `outcomeBasis` | recorded reason required by §5 of SPEC-000 | reference to `PolicyDecision`, exemption basis, gate classification, or refusal basis |
| `outcomeRecordedAt` | timestamp of the outcome | ISO-8601 UTC |

`outcomeClass` is **never** a field of `ErrorEvent`, and `ErrorEvent` is never
used to carry `outcomeClass`. The two record types are structurally disjoint.

---

## 4. Verification status taxonomy (DOD-032)

Exactly one status applies to every accounted ID at any time. The vocabulary is
closed. Tokens not in §4.1 are forbidden in harness state, reports, issue text,
and release verdicts (DOD-026).

### 4.1 Canonical statuses

Required common fields for **every** status row (DOD-032 schema validation):
`id`, `status`, `reason` (non-empty), `evidencePath`, `updatedAt` (ISO-8601 UTC),
`epochId`, `nextAction`, `blockingDependency` (nullable; required non-null for
every `BLOCKED_*`). Status-specific fields are listed per row.

---

#### `PASS`

- **Exact definition:** The requirement's acceptance oracle was executed in the
  current candidate epoch against the pinned candidate/artifact identity, the
  observed sentinel/exit code matched the oracle's success condition, and the
  required negative case was executed and behaved as specified.
- **Correct choice when:** Executed evidence exists in this epoch, the oracle is
  unmodified, no masking pattern (§8) was involved, and the evidence digest is
  recorded.
- **Required fields:** common fields, plus `command`, `exitCode`, `sentinel`,
  `artifactDigest`, `testIds[]` (≥1), `evidenceDigest`, `epochId`.
- **Cleared/withdrawn by:** nothing external. It is **revoked** (not cleared) by
  any change invalidating the epoch (DOD-040), by discovery of a masking pattern
  (DOD-024), or by an oracle change (DOD-027).
- **Forbidden:** `PASS` for an abbreviated trial (DOD-038), for a mock-only proof
  of an integration claim (DOD-010), or for a category rather than an executed
  case.

#### `FAIL`

- **Exact definition:** The oracle executed successfully as a *harness* operation
  and the candidate's observed behavior was **wrong**: the requirement is not met.
- **Correct choice when:** The test ran, the environment was adequate, the
  observed result contradicts the oracle's success condition.
- **Required fields:** common fields, plus `command`, `exitCode`, `expected`,
  `actual`, `firstFailureLogPath`, `artifactDigest`.
- **Cleared by:** a code/spec fix plus a rerun of the affected epoch (implementer);
  never by editing the oracle (DOD-027).

#### `ERROR`

- **Exact definition:** The check could not produce a valid verdict because our
  own harness, script, configuration, schema, or fixture machinery broke — bad
  syntax, missing declared tool, unhandled exception in the runner, invalid
  manifest, DOD-007 zero-collection guard trip.
- **Correct choice when:** Nothing about the candidate's behavior was actually
  observed.
- **Required fields:** common fields, plus `command`, `exitCode`,
  `harnessStackRef`, `blockingDependency`, `firstFailureLogPath`.
- **Cleared by:** harness/configuration fix and rerun (harness owner). An `ERROR`
  **must not** be downgraded to `FAIL`; the correct repair is fixing the harness
  (DOD-033).
- **Explicitly not:** provisioning gaps that the harness adapter could fix — those
  are `ERROR` until the harness setup is corrected, at which point the case is
  rerun (DOD-033).

#### `BLOCKED_PREREQUISITE`

- **Exact definition:** A **declared dependency edge** exists from this ID to a
  prerequisite ID (or artifact) that is `FAIL`/`ERROR`/`INCOMPLETE`; the
  prerequisite is named and its own status is recorded.
- **Correct choice when:** The dependency edge is explicit in the dependency
  graph, and this test therefore cannot run meaningfully.
- **Required fields:** common fields, plus `blockingDependency` (prerequisite ID),
  `dependencyEdgeRef`, `lastRunnableAttempt` (nullable), `artifactDigest`
  (nullable when no artifact-dependent run occurred).
- **Cleared by:** the prerequisite reaching `PASS`, after which this ID reruns
  (implementer). Independent tests **continue** — blanket blocking is invalid
  (DOD-031, VG-REL-003).

#### `BLOCKED_ENVIRONMENT`

- **Exact definition:** The required environment class cannot exist here: no
  supported OS/kernel, no container runtime, no permitted network egress to the
  declared target, no browser sandbox, insufficient disk/memory. The limitation is
  environmental, not a product capability gap and not fixable by harness
  provisioning.
- **Correct choice when:** Evidence exists that the environment lacks the
  property, and the declared test environment manifest cannot supply it.
- **Required fields:** common fields, plus `environmentManifestRef`,
  `missingProperty`, `provisioningAttemptLogPath`.
- **Cleared by:** a conforming environment (human/operator or CI platform owner)
  plus a rerun. Never self-cleared by narrative.

#### `BLOCKED_CAPABILITY`

- **Exact definition:** The harness adapter **cannot** provision the declared
  infrastructure or execute the declared toolchain even though the environment
  permits it — e.g. no adapter exists for the declared service class, or the
  declared runner cannot drive the required worker model.
- **Correct choice when:** An adapter gap is demonstrated, not assumed, and the
  capability is genuinely absent from the current harness.
- **Required fields:** common fields, plus `missingCapability`,
  `adapterRefOrAbsent`, `requestedProvisioningLogPath`.
- **Cleared by:** implementing the adapter (harness owner) then rerunning; or by
  an approved, requirement-scoped waiver with owner, expiry, rationale, and
  compensating evidence (DOD-006). Waivers are recorded, never silent.
- **Explicitly not:** `BLOCKED_CAPABILITY` is invalid before the harness has
  attempted non-invasive provisioning (DOD-033).

#### `BLOCKED_CREDENTIALS`

- **Exact definition:** The test requires a credentialed external dependency —
  cloud/KMS/object store, postal provider, search API, controller portal account,
  OIDC realm — and the credential or entitlement is not provisioned.
- **Correct choice when:** The credential requirement is named, the probe for it
  fails, and no credential is available; the absence does not cause an inaccurate
  pass.
- **Required fields:** common fields, plus `credentialRef` (an **opaque
  environment-variable or probe name only** — never a secret value),
  `probeCommand`, `probeExitCode`, `provisioningDocRef` (`PREFLIGHT.md` row).
- **Cleared by:** the credential owner provisioning it, then a rerun. Errors must
  never be produced by substituting a default, a fake, or a cached value
  (DOD-014, §7).

#### `BLOCKED_SAFETY`

- **Exact definition:** Executing the test would violate a hard exclusion or
  safety control — SPEC-000 §3 non-goals, `VG-SCOPE-*`, tenant boundaries,
  production-write prohibition, real-person PII prohibition, live-fire against a
  third party without authorization.
- **Correct choice when:** The action is genuinely prohibited regardless of
  feasibility, and a safe substitute cannot exercise the same requirement.
- **Required fields:** common fields, plus `policyRef` (the specific `VG-SCOPE-*`
  / DOD / SECURITY clause), `prohibitedAction`, `safeSubstitute` (nullable),
  `safetyReviewer` (named human role, not an agent).
- **Cleared by:** a human authority authorizing a bounded, lawful substitute, or
  by the requirement being explicitly withdrawn (then `WITHDRAWN`).

#### `EXTERNAL_REQUIRED`

- **Exact definition:** The remaining work requires a real participant or an
  external authority that no automated system can impersonate: legal/counsel
  review, named human UAT, assistive-technology validation by a lived user,
  accredited assessment, written provider authorization, production deployment
  authorization.
- **Correct choice when:** SPEC-000 §11 or DOD-039 applies; the artifact to be
  signed is prepared and its digest pinned.
- **Required fields:** common fields, plus `externalPartyRole`,
  `requestedArtifactDigest`, `requestEvidencePath`, `requestedAt`,
  `ownerContactRef` (role mailbox, not a natural person's private contact).
- **Cleared by:** **only** the required real signatory, producing a named,
  scoped, dated sign-off (DOD-039). An agent may never clear this status, and
  `GO` is prohibited while a mandatory external gate is open.

#### `DEFERRED_LONG_RUNNING`

- **Exact definition:** The requirement specifies a duration or workload scale
  (soak, endurance, stress, fuzz corpus, recovery-time measurement) that is
  legitimately still in progress; the abbreviated or partial portion is reported
  **separately** and never as the full requirement.
- **Correct choice when:** The full-duration run is scheduled/underway with
  heartbeats, and the elapsed portion is honestly labeled.
- **Required fields:** common fields, plus `workload`, `plannedDuration`,
  `elapsedDuration`, `startedAt`, `heartbeatRef`, `partialResultPath`,
  `completionEta` (nullable).
- **Cleared by:** completion of the full duration/scale (harness/scheduler), then
  `PASS`/`FAIL` per result. An interrupted run reports interruption; it does not
  silently become `PASS` (DOD-038).

#### `INCONCLUSIVE`

- **Exact definition:** The test executed, but the evidence cannot support a
  verdict: nondeterministic outcome with no reproducible trigger, unverifiable
  identity binding (missing candidate/artifact pin, DOD-029), corrupted or
  unreadable artifact, missing evidence digest (DOD-025).
- **Correct choice when:** Something was observed but cannot be tied to a known
  identity or reproduced.
- **Required fields:** common fields, plus `attempts[]`, `observedVariation`,
  `missingIdentityField` (e.g. `candidateSha`, `artifactDigest`), `whyVerdictFails`.
- **Cleared by:** restoring identity/reproducibility and rerunning under a pinned
  epoch (release owner). It is never "rounded" to `PASS` or `FAIL`.

#### `PARTIAL`

- **Exact definition:** The requirement's oracle was executed and satisfied for a
  **proper subset** of its declared surface — some jurisdictions, channels,
  sources, artifact formats, or supported upgrade paths remain unexecuted.
- **Correct choice when:** Real executed evidence exists for part of the claim and
  the remainder is named.
- **Required fields:** common fields, plus `coveredSurface[]`,
  `uncoveredSurface[]` (non-empty), `coverageDenominator`, `evidenceDigest`.
- **Cleared by:** executing the uncovered surface (implementer) — which may raise
  the status to `PASS` — or by explicitly narrowing the published claim.
- **Forbidden:** a percentage without a denominator; `PARTIAL` presented as `PASS`
  in any summary, metric, or marketing copy (SPEC-000 §7.4).

#### `SIMULATED`

- **Exact definition:** The only available proof is a mock, fake, in-memory
  substitute, canned fixture, or recorded replay — not the real dependency class.
- **Correct choice when:** Isolation tests are appropriate (DOD-010 permits
  doubles for isolation) but no real/sandbox execution exists at the acceptance
  boundary; or a production path would resolve to a simulated adapter (DOD-020).
- **Required fields:** common fields, plus `substitutedDependency`,
  `doubleKind` (`mock`/`fake`/`in-memory`/`recorded`), `realPathPlanRef`.
- **Cleared by:** executing at least one real or sandbox dependency run at the
  final acceptance boundary (implementer), producing `PASS`/`FAIL`.
- **Never:** `SIMULATED` may not be counted as proof of an integration or
  production claim (DOD-010).

#### `UNVERIFIED`

- **Exact definition:** No executed evidence exists for this ID in the current
  epoch: not yet attempted, attempted without retained evidence, or evidence lost.
- **Correct choice when:** The honest state is "we have not checked".
- **Required fields:** common fields, plus `reasonUnverified`,
  `plannedCommand`, `owner`.
- **Cleared by:** executing the oracle with retained evidence (implementer).
- **Forbidden:** `UNVERIFIED` may not be summarized as "assumed working",
  "expected to pass", or omitted from accounting (DOD-030).

#### `NOT_APPLICABLE`

- **Exact definition:** An **individual, evidence-based applicability decision**
  concluded the ID does not apply to this candidate — the domain pack, entity,
  interface, or data class it targets is absent, demonstrated from repository
  evidence rather than assumption (DOD-041).
- **Correct choice when:** Repository evidence (architecture, schema, interfaces,
  dependency manifest) shows the targeted construct does not exist, or does exist
  but is unreachable from any production path.
- **Required fields:** common fields, plus `applicabilityEvidence[]` (≥1 concrete
  path/row reference), `decisionRuleRef`, `decidedBy`, `decidedAt`.
- **Cleared by:** a change that introduces the targeted construct, which
  invalidates the decision and forces a rerun (DOD-040). Assumption alone never
  clears it into `NOT_APPLICABLE`.

#### `WITHDRAWN`

- **Exact definition:** The requirement was formally retired by an authorized
  human decision. Its **row is retained** with its original ID; the ID is never
  reused, renumbered, or deleted (SPEC-000 §2).
- **Correct choice when:** A recorded decision (ADR / decision log entry) retires
  the requirement, and no open claim depends on it.
- **Required fields:** common fields, plus `withdrawnBy`, `withdrawnAt`,
  `decisionRef`, `supersededBy` (nullable ID), `affectedClaims[]` (explicitly
  enumerated, may be empty).
- **Cleared by:** nothing. A withdrawn requirement is never silently reinstated;
  reinstatement requires a new ID.

### 4.2 Taxonomy invariants

- **ST-1** Every accounted ID has exactly one current status; zero IDs are
  missing or duplicated (DOD-030, VG-REL-002).
- **ST-2** Status transitions are audited; a transition out of `PASS`/`FAIL`
  requires a recorded reason and an epoch-identity change (`.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl`).
- **ST-3** `BLOCKED_*` requires a non-null `blockingDependency` or an equally
  concrete limitation reference; a free-text excuse is invalid (DOD-032).
- **ST-4** No status may be changed by narrative, summary, or model output; only
  a recorded transition with evidence (DOD-026, DOD-027).
- **ST-5** The release verdict is one of `GO`, `NO_GO`,
  `CONDITIONAL_EXTERNAL_GATES`, `INCONCLUSIVE` (SPEC-000 §6.7, DOD-042) and is
  derived from these statuses; product-outcome vocabulary (`NOT_REMOVABLE`,
  `HUMAN_REQUIRED`, `SUCCESS`, `DONE`, `COMPLETE`, `REMOVED`) is forbidden in
  verdict and status fields (SPEC-000 §4).
- **ST-6** The **same token set** is used by harness state, issue text, PR
  descriptions, reports, and dashboards. A report that paraphrases a status
  ("mostly passing", "effectively complete") is a DOD-026 defect.

---

## 5. Domain error catalogue

### 5.1 Common error record (field allowlist)

Every domain error class in §5.3 must carry exactly these fields. Adding a field
requires an amendment to this specification (DOD-027 prohibits ad-hoc growth of
the error surface).

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | stable string (§5.2) | yes | machine-readable; the contract |
| `class` | class token (§5.3) | yes | the raised type |
| `category` | `OUTCOME` \| `CANDIDATE_FAILURE` \| `SYSTEM` | yes | §2; static per class |
| `severity` | `INFO` \| `WARN` \| `ERROR` \| `FATAL` | yes | `OUTCOME` ⇒ `INFO` only |
| `retryable` | boolean | yes | static per class (§10) |
| `tenantId` | `TenantId` | yes | opaque; never a name |
| `caseId` | `CaseId` \| null | yes | null only for pre-case errors |
| `subjectRef` | `SubjectId` \| null | yes | **opaque ID only**; never a `ProtectedSubject` name or identifier value |
| `correlationId` | opaque | yes | traverses discovery → action → verification (VG-OBS-001) |
| `ruleRef` | string \| null | yes | the violated rule, e.g. `SPEC-001:4.2:MATCH_CONFIRMED->REQUEST_SUBMITTED` |
| `retryAfterMs` | integer \| null | yes | non-null iff `retryable` is true |
| `attempt` | integer ≥1 | yes | attempt ordinal within the ladder |
| `occurredAt` | ISO-8601 UTC | yes | from injected `Clock` |
| `digest` | `EvidenceDigest` \| null | yes | where the error concerns an artifact |
| `ladderSignature` | string | yes | `class|code|ruleRef`; the bounded-ladder key (§10.3) |
| `details` | object \| null | yes | **allowlisted keys only** (§5.4) |

### 5.2 Forbidden field content (hard)

An error record, its log line, its telemetry attributes, and any issue text
derived from it must never contain:

- a `ProtectedSubject` name, alias value, email address, phone number, postal
  address, government identifier, date of birth, or free-text profile content;
- a raw `Identifier.valueEnc` value, decrypted or not;
- cookies, session IDs, bearer tokens, API keys, signatures, private keys,
  connection strings, or any `AUTH_SECRET`-class value;
- raw remote HTML, PDF text, `SourceRecord` body content, or `EvidenceArtifact`
  bytes;
- full request/response bodies from a `Controller` or provider;
- file paths that embed a tenant's or subject's name.

IDs, hashes, counts, enums, durations, class names, and `ruleRef` values are
permitted and are the only permitted content (§9).

### 5.3 Catalogue

Legend — **Cat**: `OUTCOME` (kind A) / `CF` (candidate failure, kind B) / `SYS`
(system ERROR, kind C). **Rty**: `Y` retryable, `N` never retryable. The
**Wire mapping** column is `HTTP status / wire code / envelope kind`; it is bound
by §6.2, which adopts the `/v1` contract of SPEC-003 §8.2 verbatim for every code
SPEC-003 enumerates. Codes marked *(domain-only)* have no `/v1` spelling of their
own; they are raised in the domain and, at the API boundary, are rendered as the
wire code that SPEC-003 does enumerate for the same condition.

| # | Class | `code` (domain) | Raised when | Cat | Rty | Wire mapping |
|---|---|---|---|---|---|---|
| 1 | `IllegalTransition` | `ILLEGAL_TRANSITION` | A transition not listed in SPEC-001 §4.1 was requested, or a listed transition's guard failed; `from`/`to` are unchanged. | SYS | N | `409` / `ILLEGAL_TRANSITION` / `error` |
| 2 | `AuthorityExpired` | `AUTHORITY_EXPIRED` | The `AuthorityGrant` bound to the case has `expiresAt ≤ now` at execution time, or was revoked (`revokedAt` non-null). | SYS | N | `409` / `AUTHORITY_EXPIRED` (or `AUTHORITY_REVOKED` when revoked) / `error` |
| 3 | `AuthorityMissing` | `AUTHORITY_MISSING` | No `AuthorityGrant` is bound, or the bound grant row is absent/unreadable. | SYS | N | `409` / `AUTHORITY_INVALID` / `error` |
| 4 | `AuthorityScopeViolation` | `AUTHORITY_SCOPE_VIOLATION` | The grant exists and is valid, but its `scope[]` does not cover the requested source, channel, or action (VG-AUTHZ-001). | SYS | N | `422` / `AUTHORITY_GRANT_SCOPE_INSUFFICIENT` / `error` |
| 5 | `PolicyUnresolved` | `POLICY_UNRESOLVED` | No `JurisdictionPolicy` row resolves for the `Jurisdiction` + effective date, or the `LegalBasis` is absent from the policy version in force (VG-POLICY-001/002). | SYS | N | `422` / `JURISDICTION_UNRESOLVED` (or `LEGAL_BASIS_NOT_IN_POLICY_VERSION`) / `error` |
| 6 | `NoLawfulBasis` | `NO_LAWFUL_BASIS` | Policy **resolved successfully** to "no lawful removal path exists" (exemption, public-interest, FCRA limit). | OUTCOME | N | `200` / `NOT_REMOVABLE` outcome envelope; `409` / `NO_LAWFUL_BASIS` *(domain-only)* only where an explicit refusal is required |
| 7 | `RecipeStale` | `RECIPE_STALE` | `RemovalRecipe.freshnessAt` is beyond its source-declared freshness window, or freshness cannot be established. | SYS | N | `409` / `RECIPE_STALE` / `error` |
| 8 | `RecipeUnsigned` | `RECIPE_UNSIGNED` | Signature verification of the `RemovalRecipe` failed or no signature is present (VG-CHANNEL-003). | SYS | N | `409` / `RECIPE_UNSIGNED` (or `RECIPE_SIGNATURE_INVALID` at ingestion) / `error` |
| 9 | `PermissionUnclear` | `PERMISSION_CLASS_UNCLEAR` | `Source.permissionClass` is `WRITE_UNCLEAR`, unknown, or absent at execution time (VG-CHANNEL-002). | SYS | N | `409` / `SOURCE_PERMISSION_UNCLEAR` / `error` |
| 10 | `IdempotencyConflict` | `IDEMPOTENCY_CONFLICT` | An `IdempotencyKey` already used for a different intended effect (different payload digest) on the same case/source. | SYS | N | `409` / `IDEMPOTENCY_KEY_REUSE` (or `IDEMPOTENCY_IN_FLIGHT`) / `error` |
| 11 | `AmbiguousExternalEffect` | `AMBIGUOUS_EXTERNAL_EFFECT` | A write attempt produced an indeterminate result (timeout, connection reset, no response, truncated response) so it is unknown whether the external effect occurred (VG-ACTION-002). | CF | N (reconcile) | `202` / `AMBIGUOUS_EXTERNAL_EFFECT` / `reconcile` |
| 12 | `BudgetExceeded` | `BUDGET_EXCEEDED` | A write-effect budget for subject × source × window is exhausted, or the attempt would exceed it (VG-ACTION-005). | OUTCOME | N | `409` / `EFFECT_BUDGET_EXCEEDED` / `error` |
| 13 | `TaintedContentRejected` | `TAINTED_CONTENT_REJECTED` | Content carrying `taint` (remote page, message body, PDF, model output) reached a decision or write path, or attempted to select a channel (VG-SEC-001). | SYS | N | `422` / `TAINTED_CONTENT_REJECTED` *(domain-only)* / `error` |
| 14 | `EgressDenied` | `EGRESS_DENIED` | The `EgressGate` refused the payload class (default deny for `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, `AUTH_SECRET`), or DLP scrubbing failed/was unavailable (VG-EGRESS-001/002). | SYS | N | `403` / `EGRESS_DENIED` *(domain-only)* / `error` |
| 15 | `DigestMismatch` | `DIGEST_MISMATCH` | A stored `EvidenceArtifact` readback digest differs from its recorded digest, or a computed digest fails format validation (VG-EVIDENCE-001). | SYS | N | `409` / `EVIDENCE_INTEGRITY_FAILURE` on read; `422` / `EVIDENCE_DIGEST_MISMATCH` (or `EVIDENCE_DIGEST_MALFORMED`) at ingestion / `error` |
| 16 | `TenantViolation` | `TENANT_SCOPE_VIOLATION` | A caller's tenant does not match the row/case tenant, a query would cross the isolation boundary, or RLS was bypassed/unset. | SYS | N | `404` / `RESOURCE_NOT_FOUND` (identical body to a genuinely absent resource; the domain code is audit-only) / `error` |
| 17 | `ObservationNotIndependent` | `OBSERVATION_NOT_INDEPENDENT` | The `VerificationObservation` path shares the acting path's session, credential, or client identity, or is the actor's own self-report (VG-VERIFY-001). | SYS | N | `422` / `OBSERVATION_PATH_NOT_INDEPENDENT` / `error` |
| 18 | `ObservationWindowNotMet` | `OBSERVATION_WINDOW_NOT_MET` | Elapsed time since the action is less than the recipe's `ObservationWindow.duration`; boundary is inclusive (elapsed ≥ window passes) (VG-VERIFY-002). | OUTCOME | Y | `422` / `OBSERVATION_WINDOW_NOT_MET` / `error` |
| 19 | `VerificationMethodMismatch` | `VERIFICATION_METHOD_MISMATCH` | The observation's method differs from the recipe's declared `verificationMethod`, or a search-engine observation is used to prove a source removal (VG-VERIFY-003; SPEC-001 §4.2). | SYS | N | `422` / `OBSERVATION_METHOD_MISMATCH` / `error` |
| 20 | `HumanGateRequired` | `HUMAN_GATE_REQUIRED` | A legitimate human/identity/legal/provider gate was detected and automation stops (CAPTCHA, OTP, ID verification, signed-instrument demand). **This is a legitimate outcome, never an error** (VG-DISC-004, SPEC-001 SM-5). | OUTCOME | N | `200` / outcome envelope with `truthState="HUMAN_REQUIRED"`; `422` / `HUMAN_GATE_OPEN` or `HUMAN_STEP_REQUIRED` only where the gate was already open on an unrelated guarded route |
| 21 | `InvalidValueObject` | `INVALID_VALUE_OBJECT` | Construction/parsing of a SPEC-001 §2 value object failed: empty ID, `Confidence` out of range or without `basis[]`, non-64-hex `EvidenceDigest`, `TruthState` not a member, `ChannelPriority` outside 1–8, `Jurisdiction` unresolvable, `ObservationWindow.duration ≤ 0`, float `Money`. | SYS | N | `422` / the field-specific wire code (`CONFIDENCE_BASIS_REQUIRED`, `CONFIDENCE_OUT_OF_RANGE`, `INVALID_TRUTH_STATE`, `EVIDENCE_DIGEST_MALFORMED`, …); `400` / `SCHEMA_VALIDATION_FAILED` for syntactic failures |
| 22 | `AuditUnavailable` | `AUDIT_UNAVAILABLE` | The `AuditSink` append failed or timed out. No state change may be committed without its `AuditEvent` (SPEC-001 SM-2, VG-EVIDENCE-003). | SYS | Y | `503` / `DEPENDENCY_UNAVAILABLE` / `error` |
| 23 | `StorageUnavailable` | `STORAGE_UNAVAILABLE` | The canonical store (PostgreSQL) or `EvidenceStore` is unreachable or rejecting writes; readiness is not satisfied (VG-OPS-001). | SYS | Y | `503` / `DEPENDENCY_UNAVAILABLE` / `error` |
| 24 | `DependencyUnavailable` | `DEPENDENCY_UNAVAILABLE` | A declared external dependency needed for the attempt is unreachable/unconfigured in a way that indicates our setup or the outside world being down — e.g. Temporal address unset, provider transport unreachable, OIDC unreachable. | SYS | Y | `503` / `DEPENDENCY_UNAVAILABLE` / `error` |
| 25 | `ExternalTimeout` | `EXTERNAL_TIMEOUT` | An outbound call exceeded its declared deadline. It is **not** on its own evidence of any external effect. | CF | Y | On a write path: `202` / `AMBIGUOUS_EXTERNAL_EFFECT`; on a read path: `503` / `DEPENDENCY_UNAVAILABLE` / `error` |

### 5.4 Required per-class fields, audit, and telemetry

Every class carries §5.1 plus the class-specific fields below. Every raise appends
one `AuditEvent` (action `DomainErrorRaised` or `HumanGateRaised` for class 20)
and emits one telemetry sample. Metric labels are restricted to `code`, `class`,
`category`, and `tenantId`; subject, case, and correlation IDs are trace/log
attributes only, never metric labels (they are high-cardinality and
`subjectRef`-adjacent PII risk).

| # | Class | Additional required fields | Audit action | Telemetry counters / signals |
|---|---|---|---|---|
| 1 | `IllegalTransition` | `transitionFrom`, `transitionTo`, `illegalRule` (the SPEC-001 §4.2 row, e.g. `REQUEST_SUBMITTED->VERIFIED_REMOVED`), `guardFailures[]` (each failed §4.1 guard) | `DomainErrorRaised` | `illegal_transition_total{from,to}`; **alert** — a hit indicates a defect or an unauthorised caller |
| 2 | `AuthorityExpired` | `authorityGrantId`, `expiresAt`, `revokedAt` | `DomainErrorRaised` | `authority_refused_total{reason="expired"}`; no external effect recorded |
| 3 | `AuthorityMissing` | `expectedScope[]`, `requiredKind` | `DomainErrorRaised` | `authority_refused_total{reason="missing"}` |
| 4 | `AuthorityScopeViolation` | `authorityGrantId`, `grantScope[]`, `requestedScope[]` | `DomainErrorRaised` | `authority_refused_total{reason="scope"}` |
| 5 | `PolicyUnresolved` | `jurisdiction`, `requestedLegalBasis`, `policyVersionSearched[]`, `effectiveAt` | `DomainErrorRaised` | `policy_unresolved_total{jurisdiction}` |
| 6 | `NoLawfulBasis` | `policyDecisionId`, `exemptionClass`, `basisRef` | `NotRemovable` | `outcome_total{outcome="NOT_REMOVABLE"}`; **must not** touch any error counter |
| 7 | `RecipeStale` | `recipeId`, `recipeVersion`, `freshnessAt`, `stalenessSeconds` | `DomainErrorRaised` | `recipe_refused_total{reason="stale"}`; recipe transitions to `enabled=false` |
| 8 | `RecipeUnsigned` | `recipeId`, `recipeVersion`, `verificationResult` | `DomainErrorRaised` | `recipe_refused_total{reason="unsigned"}`; **alert** — possible tampering |
| 9 | `PermissionUnclear` | `sourceId`, `permissionClassObserved` (or `absent`), `tosCheckedAt` | `DomainErrorRaised` | `write_refused_total{reason="permission_unclear"}`; source write path disabled |
| 10 | `IdempotencyConflict` | `idempotencyKeyRef` (key stored as a digest reference, never the raw key value in logs), `priorActionId`, `priorPayloadDigest`, `requestedPayloadDigest` | `DomainErrorRaised` | `idempotency_conflict_total`; second external effect **never** performed |
| 11 | `AmbiguousExternalEffect` | `actionId`, `channel`, `attempt`, `timeoutMs`, `reconciliationId` | `ActionAmbiguous` | `action_ambiguous_total{channel}`; **alert**; no blind retry |
| 12 | `BudgetExceeded` | `budgetId`, `budgetScope` (subject×source×window), `limit`, `consumed`, `windowResetAt` | `BudgetExceeded` | `budget_exceeded_total{scope}`; recorded as an honest outcome, not a failure |
| 13 | `TaintedContentRejected` | `sourceRecordId`, `taintOrigin` (URL class or message channel, no content), `attemptedEffect` | `DomainErrorRaised` | `taint_rejected_total`; **alert** — a reachable taint path is a security defect |
| 14 | `EgressDenied` | `egressClass`, `destinationClass`, `policyDecisionRef` (tenant policy row), `redactionEvidenceId` (nullable) | `DomainErrorRaised` | `egress_denied_total{egressClass}`; egress **not** attempted |
| 15 | `DigestMismatch` | `evidenceId`, `expectedDigest`, `observedDigest`, `storageRef` | `DomainErrorRaised` | `digest_mismatch_total`; **alert** + integrity incident; artifact quarantined |
| 16 | `TenantViolation` | `callerTenantId`, `targetTenantId`, `resourceClass`, `enforcementLayer` (`service` \| `rls` \| `both`) | `DomainErrorRaised` | `tenant_violation_total{layer}`; **alert**; client sees 404 `RESOURCE_NOT_FOUND` only (§7.1 #13, §6.2 H-9) |
| 17 | `ObservationNotIndependent` | `observationId`, `actingActorRef`, `observingActorRef`, `sharedPathRef`, `requiredDistinctness` | `VerificationFailed` | `observation_rejected_total{reason="not_independent"}`; case stays `ACKNOWLEDGED` |
| 18 | `ObservationWindowNotMet` | `observationId`, `actionAt`, `requiredWindowSeconds`, `elapsedSeconds`, `earliestEligibleAt` | `VerificationFailed` | `observation_deferred_total`; retryable at `earliestEligibleAt` |
| 19 | `VerificationMethodMismatch` | `observationId`, `requiredMethod`, `observedMethod`, `recipeId` | `VerificationFailed` | `observation_rejected_total{reason="method"}` |
| 20 | `HumanGateRequired` | `gateClass` (`CAPTCHA`\|`OTP`\|`ID_VERIFICATION`\|`SIGNED_INSTRUMENT`\|`LEGAL_REVIEW`\|`PROVIDER_ACCOUNT`), `sourceId`, `detectedAt`, `suggestedHumanStep` | `HumanGateRaised` | `outcome_total{outcome="HUMAN_REQUIRED"}`; **zero** error-counter increment; no solver invoked, no bypass attempted |
| 21 | `InvalidValueObject` | `valueObjectType`, `violatedRule` (SPEC-001 §2 row), `inputShape` (a type/shape description — **never** the input value) | `DomainErrorRaised` | `invalid_vo_total{valueObjectType}` |
| 22 | `AuditUnavailable` | `sinkClass`, `failedAttempts`, `lastErrorClass` | `DomainErrorRaised` | `audit_unavailable_total`; **alert**; the state change is abandoned, not committed |
| 23 | `StorageUnavailable` | `storeClass`, `operation`, `readyzRef` | `DomainErrorRaised` | `store_unavailable_total`; readiness flips false (VG-OPS-001) |
| 24 | `DependencyUnavailable` | `dependencyClass`, `probeRef`, `configured` (boolean) | `DomainErrorRaised` | `dependency_unavailable_total{dependencyClass}` |
| 25 | `ExternalTimeout` | `actionId` (or `observationId`), `channel`, `deadlineMs`, `observedMs` | `ActionAmbiguous` when the write outcome is unknown; `DomainErrorRaised` for reads | `external_timeout_total{channel}` |

### 5.5 Classification integrity rules

- **CE-1** A class whose `category` is `OUTCOME` must never be constructed with
  `severity > INFO`; the constructor refuses (negative case VG-ERR-041).
- **CE-2** `HumanGateRequired` must be handled on the success path of
  `RequestHumanGate` (SPEC-001 §6) and must not appear in an error-log sink.
- **CE-3** `NoLawfulBasis` and `BudgetExceeded` are outcomes that close or defer a
  case honestly; hiding them to improve apparent success rate is a VG-OBS-002 /
  DOD-027 defect.
- **CE-4** `IlegalTransition`-class refusals leave state unchanged and append
  audit; no outcome record is written.
- **CE-5** Every class in §5.3 has exactly one `code`. Two classes may not share a
  `code`, and a `code` may not be reused after a class is retired.

---

## 6. HTTP mapping

This section is the **taxonomy** side of the `/v1` error surface. The wire
envelope, the code set, and the code→status assignment for every code SPEC-003
enumerates are owned by SPEC-003 §8.1/§8.2 and are adopted **verbatim** here;
this section binds the domain classes of §5.3 to those codes and adds the
domain-only members SPEC-003 leaves to this file (SPEC-003 §8.4 grants SPEC-006
that authority). Where the two files disagree on a **status for an enumerated
code**, SPEC-003 §8.2 is the contract and this file must be corrected — that
divergence is registered as finding F-1 in §12 and is treated as a defect until
resolved.

### 6.1 Envelope

**Error envelope** — every non-2xx response has this body and only this body
(shape bound to SPEC-003 §8.1):

```json
{
  "error": {
    "code": "ILLEGAL_TRANSITION",
    "message": "The requested state change is not permitted from the current state.",
    "requestId": "req_01J9Z8W6YQ",
    "correlationId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "retryable": false,
    "occurredAt": "2026-09-08T12:00:00.000Z",
    "details": {
      "fromTruthState": "ACKNOWLEDGED",
      "toTruthState": "VERIFIED_REMOVED",
      "transitionCode": null,
      "ruleRef": "SPEC-001:4.2:ACKNOWLEDGED->VERIFIED_REMOVED"
    }
  }
}
```

**Outcome response** — a legitimate product result is **not** an error and carries
**no error envelope**. It is the route's normal `200` (or its documented success
status) with the honest body fields:

```json
{
  "caseId": "case_01J9Z8W6YR",
  "truthState": "HUMAN_REQUIRED",
  "outcomeBasis": "gateClass: CAPTCHA",
  "requiresHumanStep": true,
  "correlationId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

**Reconciliation response** — `202 Accepted`, indeterminate external effect
(SPEC-003 VG-API-021):

```json
{
  "externalActionId": "act_01J9Z8W6YU",
  "actionOutcome": "AMBIGUOUS",
  "reconciliationRequired": true,
  "reconciliationId": "recon_01J9Z8W6YT",
  "truthStateChanged": false,
  "correlationId": "4bf92f3577b34da6a3ce929d0e0e4736"
}
```

Envelope rules:

- **H-1** Every non-2xx response is an error envelope. Exactly one top-level key,
  `error`; an empty or absent body on a non-2xx response is a contract defect.
- **H-2** `code`, `message`, `requestId`, `correlationId`, `retryable`, and
  `occurredAt` are present on every error envelope. `details` is optional and is
  schema-validated per code (SPEC-003 §8.1).
- **H-3** `message` is a **fixed, non-interpolated string from the template table
  in §6.2 for its `code`**. It never contains an identifier, subject value, URL,
  or provider text. Per-code templates are permitted to name enum tokens and guard
  names (SPEC-003 §8.1 example); they are never permitted to embed request data.
  All dynamic, non-PII context goes in `details`.
- **H-4** `requestId` and `correlationId` are always present so support can join
  to an audit row without exchanging PII; `correlationId` is the same value used
  by audit, logs, and traces for the operation (VG-OBS-001, SPEC-003 VG-API-003).
- **H-5** Unknown extra fields are rejected by schema validation on the response
  contract (a response containing an unlisted field fails the contract test).
- **H-6** The domain-side fields of §5.1 that are **not** wire fields (`class`,
  `category`, `severity`, `tenantId`, `caseId`, `ruleRef`, `digest`,
  `ladderSignature`, `attempt`) are recorded in audit and telemetry only. Two of
  them — `category` and `ruleRef` — may additionally appear under `details`, where
  SPEC-003 §8.1 permits enum tokens and guard names.

### 6.2 Code → status → message → domain class

**Domain classes as rendered on `/v1`** (statuses and code strings adopted from
SPEC-003 §8.2; the domain `code` of §5.3 is also shown because it is the token
used in audit, telemetry, and the internal error registry):

| Domain `code` (§5.3) | Wire `code` (SPEC-003 §8.2) | HTTP | Message template (H-3) |
|---|---|---|---|
| `ILLEGAL_TRANSITION` | `ILLEGAL_TRANSITION` | 409 | `The requested state change is not permitted from the current state.` |
| `AUTHORITY_EXPIRED` | `AUTHORITY_EXPIRED` | 409 | `The authority grant for this case is no longer valid.` |
| `AUTHORITY_EXPIRED` (revoked) | `AUTHORITY_REVOKED` | 409 | `The authority grant for this case was revoked.` |
| `AUTHORITY_MISSING` | `AUTHORITY_INVALID` | 409 | `No valid authority grant is bound to this case.` |
| `AUTHORITY_SCOPE_VIOLATION` | `AUTHORITY_GRANT_SCOPE_INSUFFICIENT` | 422 | `The authority grant does not cover the requested action.` |
| `POLICY_UNRESOLVED` | `JURISDICTION_UNRESOLVED` | 422 | `No jurisdiction policy resolves for this request.` |
| `POLICY_UNRESOLVED` (basis) | `LEGAL_BASIS_NOT_IN_POLICY_VERSION` | 422 | `The requested legal basis does not exist in the policy version in force.` |
| `NO_LAWFUL_BASIS` *(domain-only)* | `NO_LAWFUL_BASIS` | 409 | `No lawful removal path exists for this record.` |
| `RECIPE_STALE` | `RECIPE_STALE` | 409 | `The removal recipe for this source is stale.` |
| `RECIPE_UNSIGNED` | `RECIPE_UNSIGNED` | 409 | `The removal recipe for this source failed signature verification.` |
| `RECIPE_UNSIGNED` (ingestion) | `RECIPE_SIGNATURE_INVALID` | 422 | `The submitted recipe signature could not be verified.` |
| `PERMISSION_CLASS_UNCLEAR` | `SOURCE_PERMISSION_UNCLEAR` | 409 | `The write permission class for this source is unclear; writes are disabled.` |
| `IDEMPOTENCY_CONFLICT` | `IDEMPOTENCY_KEY_REUSE` | 409 | `This idempotency key was already used for a different request.` |
| `IDEMPOTENCY_CONFLICT` (in flight) | `IDEMPOTENCY_IN_FLIGHT` | 409 | `A request with this idempotency key is still in flight.` |
| `IDEMPOTENCY_CONFLICT` (absent) | `IDEMPOTENCY_KEY_REQUIRED` | 400 | `An Idempotency-Key header is required for this operation.` |
| `AMBIGUOUS_EXTERNAL_EFFECT` | `AMBIGUOUS_EXTERNAL_EFFECT` *(domain-only spelling; the response is the 202 reconciliation body of §6.1)* | 202 | `The outcome of this external action is not yet known.` |
| `BUDGET_EXCEEDED` | `EFFECT_BUDGET_EXCEEDED` | 409 | `The action budget for this subject, source, and window is exhausted.` |
| `TAINTED_CONTENT_REJECTED` *(domain-only)* | `TAINTED_CONTENT_REJECTED` | 422 | `Untrusted content cannot direct this operation.` |
| `EGRESS_DENIED` *(domain-only)* | `EGRESS_DENIED` | 403 | `This data class may not leave the system under the current policy.` |
| `DIGEST_MISMATCH` (read) | `EVIDENCE_INTEGRITY_FAILURE` | 409 | `A stored artifact failed integrity verification.` |
| `DIGEST_MISMATCH` (ingestion) | `EVIDENCE_DIGEST_MISMATCH` | 422 | `The supplied digest does not match the received content.` |
| `DIGEST_MISMATCH` (format) | `EVIDENCE_DIGEST_MALFORMED` | 422 | `The supplied digest is not a valid SHA-256 value.` |
| `TENANT_SCOPE_VIOLATION` (audit-only) | `RESOURCE_NOT_FOUND` | 404 | `The requested resource was not found.` |
| `OBSERVATION_NOT_INDEPENDENT` | `OBSERVATION_PATH_NOT_INDEPENDENT` | 422 | `The observation does not use a path independent of the action.` |
| `OBSERVATION_WINDOW_NOT_MET` | `OBSERVATION_WINDOW_NOT_MET` | 422 | `The required observation window has not yet elapsed.` |
| `VERIFICATION_METHOD_MISMATCH` | `OBSERVATION_METHOD_MISMATCH` | 422 | `The observation method does not match the recipe's verification method.` |
| `HUMAN_GATE_REQUIRED` *(outcome)* | *(no error code; outcome body of §6.1)* | 200 | `A human step is required; automation has stopped.` |
| `HUMAN_GATE_REQUIRED` (gate already open) | `HUMAN_GATE_OPEN` | 422 | `A human gate is open for this case; automation cannot proceed.` |
| `HUMAN_GATE_REQUIRED` (human step needed) | `HUMAN_STEP_REQUIRED` | 422 | `A human step is required before this operation can continue.` |
| `INVALID_VALUE_OBJECT` (semantic) | field-specific code from SPEC-003 §8.2 (`CONFIDENCE_BASIS_REQUIRED`, `CONFIDENCE_OUT_OF_RANGE`, `INVALID_TRUTH_STATE`, `COVERAGE_BOUNDS_REQUIRED`, …) | 422 | the field-specific template for that code |
| `INVALID_VALUE_OBJECT` (syntactic) | `SCHEMA_VALIDATION_FAILED` | 400 | `The request body is malformed.` |
| `AUDIT_UNAVAILABLE` | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable; the operation was not performed.` |
| `STORAGE_UNAVAILABLE` | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable; the operation was not performed.` |
| `DEPENDENCY_UNAVAILABLE` | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable.` |
| `EXTERNAL_TIMEOUT` (write) | `AMBIGUOUS_EXTERNAL_EFFECT` (202 reconciliation body) | 202 | `The outcome of this external action is not yet known.` |
| `EXTERNAL_TIMEOUT` (read) | `DEPENDENCY_UNAVAILABLE` | 503 | `A required dependency is unavailable.` |

**Codes owned by SPEC-003 §8.2 with no domain class of their own** (transport,
authentication, concurrency, and ingestion guards). They are part of the closed
`/v1` set; the API layer raises them and they must not be re-spelled:

| Family | HTTP | Codes (representative, per SPEC-003 §8.2) | Raising layer |
|---|---|---|---|
| Malformed request / opaque-value validation | 400 | `SCHEMA_VALIDATION_FAILED`, `INVALID_CURSOR`, `INVALID_SORT_FIELD`, `UNKNOWN_QUERY_PARAMETER`, `INVALID_TRUTH_STATE`, `TIME_RANGE_REQUIRED`, `TIME_RANGE_TOO_WIDE`, `FILTER_TOO_BROAD`, `MISSING_REQUIRED_HEADER`, `IDEMPOTENCY_KEY_MALFORMED`, `WEBHOOK_NONCE_MISSING` | `http` |
| Authentication / webhook verification | 401 | `TOKEN_MISSING`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `TOKEN_INVALID_CLAIMS`, `TOKEN_AUDIENCE_MISMATCH`, `TOKEN_SCOPE_WILDCARD_FORBIDDEN`, `WEBHOOK_SIGNATURE_INVALID`, `WEBHOOK_KEY_UNKNOWN`, `WEBHOOK_TIMESTAMP_OUT_OF_WINDOW` | `http` / OIDC adapter |
| Authenticated but not permitted | 403 | `INSUFFICIENT_SCOPE`, `INSUFFICIENT_ROLE`, `STEP_UP_REQUIRED` | `http` |
| Absent or another tenant's resource | 404 | `RESOURCE_NOT_FOUND`, `WEBHOOK_BINDING_NOT_FOUND` | `http` (never distinguishes the cause — H-9) |
| Retention elapsed | 410 | `EVIDENCE_EXPIRED_RETENTION` | `http` |
| Concurrency token | 412 / 428 | `PRECONDITION_FAILED`, `PRECONDITION_REQUIRED` | `http` |
| Body size / media type | 413 / 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | `http` |
| Rate limiting | 429 | `RATE_LIMITED` (per-tenant and per-`(tenantId, sourceId)`; the source-scoped case additionally carries the source ID in `details`) | `http` |
| Unexpected server fault | 500 | `INTERNAL_ERROR` | composition root |
| Dependency unavailable | 503 | `DEPENDENCY_UNAVAILABLE` | adapters |

Mapping rules:

- **H-7** The `code` set is **closed and stable**. Adding a code to §6.2 requires
  an amendment to this file plus a SPEC-003 §8.2 row in the same change; renaming
  or removing a code SPEC-003 enumerates is a breaking `/v1` change (SPEC-003
  §2.1) and requires an ADR. **The two files must never list different statuses
  for the same code** — the contract test compares them and fails on divergence.
- **H-8** `INTERNAL_ERROR` may never substitute for a class in §5.3. If a durable
  error path exists for a condition, using `INTERNAL_ERROR` is a defect (DOD-032
  precision rule). Conversely, an unmapped exception becomes `INTERNAL_ERROR`
  **and** an alert with a server-side stack reference — never a product outcome.
- **H-9** `RESOURCE_NOT_FOUND` is the **only** permitted response for a
  cross-tenant access, and it is byte-identical to the response for a genuinely
  absent resource (SPEC-003 VG-API-012). The internal `TENANT_SCOPE_VIOLATION`
  code is audit- and telemetry-only and must never appear in a body, header, or
  timing signal.
- **H-10** 5xx is reserved for kind-C (`SYSTEM`) conditions. A kind-A outcome is
  never an error status, and a kind-B candidate failure never masquerades as a
  server fault. `OBSERVATION_WINDOW_NOT_MET` is deliberately `422` at the
  contract level (a state conflict on the observation route) while being a
  legitimate, non-error, retryable condition in the domain — the classification in
  §5.3 governs metrics and audit, and the status code governs the wire.
- **H-11** `Retry-After` (seconds or HTTP date) is mandatory on `429` and on
  retryable `503` responses; when `details` carries a `retryAfterMs`, the two must
  agree. The value equals the server's own computed retry decision (§10.2).
- **H-12** No `code` value may be an ad-hoc status token: `SUCCESS`, `DONE`,
  `COMPLETE`, `REMOVED`, `OK`, `NONE` are forbidden anywhere in an envelope or a
  response body (SPEC-000 §4, SPEC-003 §7.3).
- **H-13** `details` keys are restricted to the §5.1/§5.4 allowlist (rendered in
  `camelCase` where SPEC-003 names them so) and are validated against a per-code
  schema before the response is written. `details` never carries a request body, a
  PII-bearing field value, a stack trace, or a verbatim upstream provider body
  (SPEC-003 §8.1/§8.3, §9.1 here).
- **H-14** Provider error text is mapped to a code and logged only after DLP
  scrubbing; the caller receives an opaque `providerReference` in `details`, never
  the provider's text (SPEC-003 §8.3, VG-EGRESS-002).

---

## 7. Fail-closed rules (DOD-014)

Default posture: **when a precondition for a lawful, permitted, verified action
cannot be established, the system does not act, does not simulate, and does not
report success.** Accuracy of the failure is the requirement; a "working" demo on
missing credentials is a defect.

### 7.1 Trust-boundary fail-closed matrix

| # | Condition | Fail-closed behaviour | Code / outcome | Forbidden alternative |
|---|---|---|---|---|
| 1 | Wrong credentials / invalid OIDC token | Reject before domain entry; no state change | `TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_EXPIRED` / `TOKEN_INVALID_CLAIMS` (401) | Guest/anonymous fallback, dev bypass, default tenant |
| 2 | Revoked or expired `AuthorityGrant` | Refuse at execution time; no `ExternalAction` row | `AUTHORITY_EXPIRED` / `AUTHORITY_MISSING` (403) | Cached "previously valid" grant; reusing a grant from another case |
| 3 | Unknown `PermissionClass` (missing or unrecognized value) | **No write.** Source write path disabled until classified | `PERMISSION_CLASS_UNCLEAR` (503) | Treating unknown as `WRITE_PERMITTED`; assuming prior classification |
| 4 | `WRITE_UNCLEAR` | **No write** (SPEC-001 §3.2 invariant) | `PERMISSION_CLASS_UNCLEAR` (503) | Opportunistic attempt "to see if it works" |
| 5 | Unknown jurisdiction / no policy row | Stop and record a legitimate outcome; no model-invented basis | `HUMAN_REQUIRED` outcome via `HumanGateRequired` (gate `LEGAL_REVIEW`); `PolicyUnresolved` when the policy store itself is unavailable | Model-authored `LegalBasis`; defaulting to a "best guess" jurisdiction policy |
| 6 | Unknown recipe freshness (`freshnessAt` absent, unparseable, or clock unavailable) | Recipe treated as **disabled**; no write | `RECIPE_STALE` (503) | Assuming fresh; assuming freshness from an older successful run |
| 7 | Recipe signature unverifiable (KMS down, key rotated, malformed sig) | No write | `RECIPE_UNSIGNED` (503) | Skipping verification when the key service is down |
| 8 | Absent **independent** observation path | Case cannot reach `VERIFIED_REMOVED`, ever | `OBSERVATION_NOT_INDEPENDENT` (422); case remains `ACKNOWLEDGED` | Accepting the acting client's self-report; same-session recheck; controller claim as proof (SPEC-001 §4.2, VG-VERIFY-001) |
| 9 | Observation window not elapsed | Defer | `OBSERVATION_WINDOW_NOT_MET` (409), retryable at `earliestEligibleAt` | Immediate recheck promoted to `VERIFIED_REMOVED` (VG-VERIFY-002) |
| 10 | Verification method mismatch or search-result-as-source-proof | Observation invalid; no state change | `VERIFICATION_METHOD_MISMATCH` (422) | `SEARCH_DELISTED` recorded as `VERIFIED_REMOVED` (SPEC-000 §5.1) |
| 11 | `AuditSink` unavailable | **Abandon** the operation; no state change | `AUDIT_UNAVAILABLE` (503) | Commit state and "log later"; buffering an un-audited write |
| 12 | Canonical store / `EvidenceStore` unavailable | Readiness false; refuse new writes; serve no cached authoritative data | `STORAGE_UNAVAILABLE` (503) | In-memory fallback presented as durable (DOD-015/020) |
| 13 | RLS not enforced / session tenant unset | Refuse the query | internal `TENANT_SCOPE_VIOLATION`; client receives `404` / `RESOURCE_NOT_FOUND` only | Querying with RLS bypassed "for admin convenience" |
| 14 | `EgressGate` / DLP unavailable or scrubbing error | **Deny egress** | `EGRESS_DENIED` (403) | Sending unscrubbed data "because the scrubber is down" |
| 15 | Egress class is `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, or `AUTH_SECRET` without tenant policy + DPA + field allowlist | Deny | `EGRESS_DENIED` (403) | Default-allow by omission; implicit model egress |
| 16 | Secret resolution failure (KMS/Vault unavailable) for an outbound credential | No attempt is made | `DEPENDENCY_UNAVAILABLE` (503) | Falling back to a plaintext/`.env` value or an empty credential |
| 17 | Provider/postal/payment entitlement missing | Record honestly; do not advance state | `DEPENDENCY_UNAVAILABLE` (503) in run; harness reports `BLOCKED_CREDENTIALS` | Synthesizing a tracking number; marking `ACKNOWLEDGED` |
| 18 | Ambiguous write outcome | Reconcile; never blind-retry | `AMBIGUOUS_EXTERNAL_EFFECT` (202) + reconciliation record | Retrying a possibly-delivered mail piece / second form POST (VG-ACTION-002) |
| 19 | Same `IdempotencyKey`, different intent | Refuse | `IDEMPOTENCY_CONFLICT` (409) | Silently reusing the key for a different effect |
| 20 | Budget exhausted or unreadable budget state | Refuse; treat unreadable as exhausted | `BUDGET_EXCEEDED` (429) | Unbounded retry loop (VG-ACTION-005) |
| 21 | Untrusted content attempts to select a channel, target, or write | Reject the whole operation, keep the attempt on record | `TAINTED_CONTENT_REJECTED` (422) | Following page/message instructions (VG-SEC-001) |
| 22 | Outbound fetch target is private/link-local/metadata | Refuse | `DEPENDENCY_UNAVAILABLE`/`EgressDenied` as classified by the fetch boundary; never a successful fetch | Allowing `169.254.169.254` or `localhost` (VG-SEC-003) |
| 23 | Webhook signature, timestamp, or nonce invalid/replayed | Reject before any state change | `WEBHOOK_SIGNATURE_INVALID` / `WEBHOOK_KEY_UNKNOWN` / `WEBHOOK_TIMESTAMP_OUT_OF_WINDOW` (401); `WEBHOOK_NONCE_MISSING` (400); `WEBHOOK_NONCE_REPLAY` (409) | Processing the payload "since it parsed" (VG-SEC-004) |
| 24 | `Clock` unavailable | Freshness and expiry cannot be established ⇒ treat recipe as stale, grant as unverifiable ⇒ refuse | `RECIPE_STALE` / `AUTHORITY_EXPIRED` | Using process wall-clock as an authority for expiry semantics |
| 25 | Artifact readback digest mismatch | Quarantine artifact; integrity incident | `DIGEST_MISMATCH` (500) | Serving the artifact anyway; re-hashing until it matches |

### 7.2 Test-harness counterpart

The same posture binds the harness: absent credentials produce
`BLOCKED_CREDENTIALS`; absent capability after a real provisioning attempt
produces `BLOCKED_CAPABILITY`; a harness setup failure produces `ERROR`, not
`FAIL` (DOD-033). In no case may a missing dependency be resolved by pointing the
run at a mock and reporting `PASS` (DOD-010, DOD-020).

---

## 8. No-masking rules (DOD-024)

A masked failure converts a defect into fraudulent green status. The following
patterns are **forbidden in production paths, scripts, CI configuration, and
test harnesses**. Detection is by review of the raw exit code, first-failure log,
and status-transition audit — not by trusting the summary.

| # | Forbidden pattern | Concrete shapes (non-exhaustive) | Required correct behaviour |
|---|---|---|---|
| 1 | **Continue-on-error** | CI step `continue-on-error: true`; `\|\| true`; `set +e`; a runner flag that proceeds past a failed gate | Every gate step is fail-fast. A gate that must sometimes be non-fatal is **two** steps: a blocking one and an explicitly reported advisory one, each with its own status row |
| 2 | **Ignored exit codes** | Discarding `$?`; `cmd; echo done`; capturing output without checking status; piping through a formatter that masks the producer's code (use `set -o pipefail`) | Capture the raw exit code of the gate itself, propagate it, and record it in the evidence row (`exitCode`) |
| 3 | **Unconditional success** | `return true;`; `success: true` literal; a script with no failure path; a hard-coded success sentinel printed before the work | Success is emitted only on the success path, after the observed condition, and is bound to the run identity |
| 4 | **Swallowed exceptions** | `except Exception: pass`; `catch (e) {}`; `catch { }`; a bare `rescue` with no re-raise; an error handler that returns a default value | Catch only what is handled; every caught error is classified (§2), recorded with its class and `ruleRef`, and re-raised when unhandled |
| 5 | **Blanket catch** | A single top-level try/catch converting every exception into HTTP 200/`INTERNAL_ERROR` for the whole request surface | A closed exception→class mapping; unmapped exceptions become `INTERNAL_ERROR` **and** an alert with a stack reference; they are never converted into a product outcome |
| 6 | **All-retry policies** | Retrying every error class; infinite/uncapped retry; retrying non-idempotent classes; retrying `NoLawfulBasis`, `PermissionUnclear`, `TenantViolation`, `IllegalTransition`, `TaintedContentRejected`, `EgressDenied` | Retry only classes marked `retryable=true` (§10.1); every retry preserves one `IdempotencyKey` per intended effect |
| 7 | **Filtered output** | Grepping logs to drop failures; `head`/`tail` truncation that hides the first failure; suppressing stderr; a summary that omits failed rows | Preserve the full raw log as an evidence artifact; the **first failure** is always retained and linked; filters are additive views, never the record |
| 8 | **Baseline auto-acceptance** | Auto-updating a snapshot/golden file; auto-accepting lint/scan baselines; "expected failures" lists updated to match observed failures; auto-refreshed `--update` flags in CI | Baselines change only by reviewed human commit with a rationale; an unexpected baseline diff is `FAIL` (never auto-written); new findings are always surfaced |
| 9 | **Silent skip** | `test.skip`, `xfail`, `#[ignore]`, conditional early return that reports pass, zero-collection exit 0 | Skips require an approved requirement-scoped waiver with owner and expiry (DOD-006); zero/under-collection is `ERROR` (DOD-007) |
| 10 | **Simulated substitution in production mode** | Selecting a mock/in-memory adapter because a real one is unavailable; a "demo mode" flag that changes behavior silently | Production resolves only real adapters; a missing dependency fails closed (§7) (DOD-020) |

Self-check duties:

- **NM-1** Any script that emits a success sentinel must have at least one
  reachable failure path with a non-zero exit and a distinguishable message.
- **NM-2** Every gate step records its raw exit code and the path to its untruncated
  log in the evidence index (DOD-025).
- **NM-3** The status-transition audit is authoritative over summaries; a status
  that changed without a recorded transition is treated as `ERROR`.
- **NM-4** If a masking pattern is discovered after a `PASS` was awarded, that
  `PASS` is **revoked** and every dependent claim is invalidated (DOD-024,
  DOD-040).

---

## 9. No-PII-in-errors

### 9.1 Content rules

1. **Opaque IDs only.** Error records, logs, telemetry attributes, trace spans,
   issue titles/bodies, PR descriptions, repair capsules, and status reports
   carry `TenantId`, `CaseId`, `ExposureId`, `SourceId`, `RecipeId`, `ActionId`,
   `EvidenceId`, `correlationId` — never a name, email, phone, address,
   government identifier, DOB, or free-text profile content.
2. **No raw remote content.** No raw HTML, page text, PDF text, message bodies,
   cookies, headers, or full provider responses.
3. **No secrets.** No tokens, keys, signatures, connection strings, passwords, or
   `AUTH_SECRET`-class values (VG-SEC-002). Credential absence is reported by
   environment-variable name and probe exit code only.
4. **No identifiers by value.** `Identifier.valueEnc` never appears in an error,
   log, or trace, even encrypted or truncated.
5. **Validation errors describe shape, not value.** `InvalidValueObject` reports
   `valueObjectType` + `violatedRule` + an input *shape* description (e.g.
   "string, length 0"), never the offending value.
6. **Metric labels are enums.** Allowed labels: `code`, `class`, `category`,
   `tenantId`, and a small closed set of reason enums. Case/subject/action IDs and
   free text are forbidden as labels (cardinality + PII exposure).
7. **DLP before egress (VG-EGRESS-002).** Every telemetry event, issue body, PR
   description, repair capsule, and support artifact passes the DLP scrub before
   it leaves the trust boundary. The egress event records a
   `redactionEvidenceId` proving the scrub ran; the scrub is **fail-closed**
   (§7.1 #14). Telemetry destination class, retention, and field allowlist follow
   `DATA_EGRESS_MATRIX.md` (default deny for `CUSTOMER_PII`, `HIGH_RISK_PII`,
   `IDENTITY_DOCUMENT`, `AUTH_SECRET`).
8. **Error text is a closed set.** Because `message` is fixed per `code` (§6
   H-3), it cannot carry PII by construction; dynamic values are limited to
   `details` keys, which are validated against the §5.1/§5.4 allowlist.

### 9.2 Canary-based negative verification (required approach)

Critical proofs use runtime-generated unpredictable canaries, never fixtures
(SPEC-000 §9.5, DOD-013).

The required method is:

1. At run time, generate an unpredictable canary token set: a per-run random
   subject display name, a unique email-like local part on a reserved
   documentation domain, a unique phone-like digit string, and a unique
   `AUTH_SECRET`-shaped token. Record seed/source, the generated values, and their
   propagation trace in the evidence index — the canary values themselves live
   only in the evidence store, never in the emitted telemetry.
2. Drive every error path in scope (each §5.3 class at least once, plus the
   transport codes in §6.2) with a case whose data contains the canaries.
3. Independently observe the emitted telemetry, log stream, issue text, and error
   envelopes — via the external collector path, not by inspecting the emitter's
   own buffer.
4. Assert a **zero-match** condition for every canary value in every observed
   channel.
5. Record the propagation trace, the observation method, and the zero-match result
   as evidence. The metric `error_pii_leak_total` must be 0; any non-zero sample is
   a release blocker and an incident.
6. Include the **control direction**: a deliberately seeded leak in a canary
   fixture harness must be detected by the same check, proving the check
   discriminates (DOD-018).

Absence of a canary match proves only that this run's seeds did not leak; it is
never a general proof, and must be reported with its scope and seed count.

---

## 10. Retry, backoff, and the bounded ladder

### 10.1 Retry semantics per class

| Class | Retryable | Rationale | Maximum attempts | Base backoff | Notes |
|---|---|---|---|---|---|
| `IllegalTransition` | **No** | Deterministic contract violation; retrying cannot change it | 1 | — | Alert; fix the caller/guard |
| `AuthorityExpired` | **No** | Time/state based; requires a new grant | 1 | — | Escalate to a human step |
| `AuthorityMissing` | **No** | Requires provisioning a grant | 1 | — | |
| `AuthorityScopeViolation` | **No** | Requires a broader grant | 1 | — | |
| `PolicyUnresolved` | **No** | Requires a policy row or a human decision | 1 | — | Never model-generated |
| `NoLawfulBasis` | **No** | A lawful determination, not a transient fault | 1 | — | Outcome; hide-forbidden (VG-OBS-002) |
| `RecipeStale` | **No** | Requires recipe refresh/re-sign | 1 | — | Recipe disabled until refreshed |
| `RecipeUnsigned` | **No** | Security-relevant; may be tampering | 1 | — | Alert; no auto-unsigned fallback |
| `PermissionUnclear` | **No** | Requires a human permission classification | 1 | — | No write under any retry |
| `IdempotencyConflict` | **No** | Caller must use a new key for a new intent | 1 | — | Never silently replace the key |
| `AmbiguousExternalEffect` | **No** (reconcile instead) | Retry can duplicate a real effect | 1 | — | Reconciliation only (VG-ACTION-002) |
| `BudgetExceeded` | **No** | Bounded by policy, not by time | 1 | — | Outcome; retry only after `windowResetAt` under a new decision |
| `TaintedContentRejected` | **No** | Security boundary | 1 | — | Alert |
| `EgressDenied` | **No** | Policy boundary | 1 | — | |
| `DigestMismatch` | **No** | Integrity failure; retry cannot restore trust | 1 | — | Quarantine + incident; re-read once read-only to confirm, never to "fix" |
| `TenantViolation` | **No** | Isolation boundary | 1 | — | Alert |
| `ObservationNotIndependent` | **No** | Requires a genuinely different path | 1 | — | New observation with a distinct actor/session |
| `ObservationWindowNotMet` | **Yes** | Time-based precondition | 4 | `retryAfterMs` = `earliestEligibleAt − now` | Deterministic scheduling, not busy retry |
| `VerificationMethodMismatch` | **No** | Requires the recipe's declared method | 1 | — | |
| `HumanGateRequired` | **No** | Legitimate human step | 1 | — | Never automated around (VG-SCOPE-003) |
| `InvalidValueObject` | **No** | Input defect | 1 | — | |
| `AuditUnavailable` | **Yes** | Infrastructure transient | 4 | 250 ms | The operation is abandoned on each failure; retry re-attempts the *whole* operation under the same `IdempotencyKey` |
| `StorageUnavailable` | **Yes** | Infrastructure transient | 4 | 250 ms | Readiness false while degraded |
| `DependencyUnavailable` | **Yes** | External/transient | 4 | 500 ms | Honor `Retry-After` when present |
| `ExternalTimeout` | **Yes** | Network transient, **read path only** | 3 | 500 ms | On a write path, timeout ⇒ `AmbiguousExternalEffect` ⇒ reconcile, **never** blind retry |
| Transport `RATE_LIMITED` (per-tenant and per-`(tenantId, sourceId)`) | **Yes** | Explicit backpressure | 4 | server `Retry-After` else 2000 ms | Per-source limits are conservative (VG-DISC-003); the source-scoped case names the source in `details` |

**NR-1** `NoLawfulBasis`, `PermissionUnclear`, and `TenantViolation` **must not be
retried under any configuration**; a configuration that would retry them is a
defect detectable by inspecting the retry policy table at boot.
**NR-2** Retryability is a property of the class, not of the call site.
**NR-3** A retry never creates a second external effect: one intended effect
carries exactly one `IdempotencyKey` across all attempts (VG-ACTION-001).

### 10.2 Backoff

- Deterministic exponential backoff with full jitter:
  `delay(n) = min(base × 4^(n−1), 30 000 ms)`, then `delay × U(0.5, 1.0)`.
- An explicit `Retry-After`/`retryAfterMs` from the dependency **overrides** the
  computed delay (it is an instruction, not a hint).
- A retry budget caps total wall-clock: `min(4 attempts, job deadline, budget
  window)`. Exhaustion produces a terminal record, never a silent stop.

### 10.3 Bounded ladder for repeated same-signature failures

- The ladder key is `ladderSignature = class | code | ruleRef`.
- Three consecutive failures with the **same** signature terminate the ladder:
  no fourth attempt for that signature; the outcome is recorded as terminal
  (`FAIL`/`ESCALATED`) with all three attempt artifacts linked, and an alert is
  raised.
- Failure signatures must **differ** across retries for the ladder to continue;
  a changing signature (e.g. `EXTERNAL_TIMEOUT` → `AmbiguousExternalEffect`)
  escalates immediately to reconciliation rather than extending the ladder.
- Ladder state is durable (survives process restart) and tenant-scoped; in-memory
  ladder state is forbidden (a restart must not reset a bounded ladder).
- The ladder never converts a non-retryable class into a retryable one: for
  non-retryable classes the ladder has exactly one rung.

### 10.4 Recording

Each attempt records: `attempt`, `ladderSignature`, `delayMs`, `exitCode` or
transport result, `outcomeClass`, `evidencePath`, `correlationId`. The
first-failure log is preserved in full (NM-2); later attempts are additive.

---

## 11. Requirement catalogue

Each row: requirement → acceptance oracle (how a pass is judged) → required
negative case. **No row asserts implementation.** "Owning registry" names the
family expected to carry the row.

### 11.1 Classification law (§2)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-001 | Every non-success event is classified as exactly one of `OUTCOME`, `CANDIDATE_FAILURE`, `SYSTEM`, and the classification is static per error class. | For every class in §5.3 the static `category` metadata is retrievable, unique, and matches §5.3; a classification-completeness check enumerates all classes and fails on any unmapped class. | A class declared with two categories, or with no category, is rejected at construction and appears in the completeness report as a defect. |
| VG-ERR-002 | A legitimate candidate outcome raises no error: `NOT_REMOVABLE` and `HUMAN_REQUIRED` produce zero `ErrorEvent` rows, severity `INFO` at most, and no increment of any error/failure metric. | Drive the outcome paths (`RequestHumanGate`, policy-exemption path) and assert zero error rows and unchanged error counters. | Forcing `HUMAN_REQUIRED` through an exception-based error sink is detected by the check and reported as a DOD-032 misclassification. |
| VG-ERR-003 | A candidate failure is recorded against the case with the outside world named as cause, and is never surfaced as a defect in our software. | Failure record for a refused/unreachable source carries `category=CANDIDATE_FAILURE`, the external actor/source ID, and no system-error severity. | Re-labelling a controller refusal as `SYSTEM`/`ERROR` fails the classification assertion. |
| VG-ERR-004 | A system ERROR is never rendered as a product outcome (no `NOT_REMOVABLE`, no `HUMAN_REQUIRED`, no `VERIFIED_NOT_PRESENT` for our own breakage). | For each injected system fault (policy store down, DLP down, storage down) assert the resulting record is `SYSTEM` and no kind-A outcome row was written. | Presenting a dependency outage as a legitimate `HUMAN_REQUIRED` outcome fails the assertion. |
| VG-ERR-005 | Misclassification invalidates the affected accounting row and is recorded as a process defect before final accounting. | Inject a deliberately misclassified row; the accounting validator rejects it and reports it as a correction-required defect. | A run that totals a misclassified row into a summary without correction fails the validator. |
| VG-ERR-006 | The `outcomeClass` field is structurally disjoint from `ErrorEvent`; neither record type can carry the other's discriminator. | Schema validation rejects an `ErrorEvent` carrying `outcomeClass` and an outcome record carrying `severity ≥ ERROR`. | A record carrying both discriminators fails validation. |

### 11.2 Truth-model interaction (§3)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-007 | No error path moves a truth state, and no error may be recorded as a truth state; refusals leave state unchanged with an appended audit event. | For each §5.3 class raised mid-case, the persisted truth state equals the pre-raise state and exactly one audit event exists. | An error handler that writes an ad-hoc truth state (e.g. `DONE`, `SUCCESS`) fails the closed-enum validation. |
| VG-ERR-008 | `IllegalTransition` names `from`, `to`, and the specific illegal rule from SPEC-001 §4.2 that was violated (`ruleRef` in the form `SPEC-001:4.2:<from>-><to>`). | Every refusal carries populated `from`, `to`, and `illegalRule` matching a §4.2 row verbatim. | A refusal with a missing or invented `illegalRule` (not an existing §4.2 row) fails validation. |
| VG-ERR-009 | An error that is not retryable by class never causes a second external effect for the same intended action. | Count external effects for the same action/case across all attempts; the count is exactly 1 or 0. | Injecting a failure after the external effect but before commit, then retrying, must not yield a second effect — a duplicate effect fails the assertion (VG-ACTION-001/002). |

### 11.3 Verification-status taxonomy (§4, DOD-032)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-010 | Harness status values are drawn from the closed §4.1 set of 16 tokens; any other token is rejected. | Schema validation over the status store accepts all 16 and rejects unknown tokens, including `SUCCESS`, `DONE`, `COMPLETE`, `REMOVED`. | A row carrying a forbidden status token fails validation and is reported. |
| VG-ERR-011 | Every status row carries the common required fields, and every `BLOCKED_*` row carries a non-null concrete `blockingDependency`. | Schema validation over all rows passes with zero missing required fields; blocked rows without a dependency reference are reported. | A blocked row whose only explanation is free prose fails validation. |
| VG-ERR-012 | `FAIL`, `ERROR`, and the seven `BLOCKED_*`/`EXTERNAL_REQUIRED`/`DEFERRED_LONG_RUNNING` statuses each use their §4.1 definition and carry their status-specific fields. | Per-status field audit: `FAIL` has `expected`/`actual`/`firstFailureLogPath`; `ERROR` has `harnessStackRef`; each `BLOCKED_*` has its limitation field; `EXTERNAL_REQUIRED` has `externalPartyRole`+`requestedArtifactDigest`; `DEFERRED_LONG_RUNNING` has `plannedDuration`+`elapsedDuration`+`heartbeatRef`. | A `FAIL` missing `expected`/`actual`, or a `DEFERRED_LONG_RUNNING` with no partial-result path, fails validation. |
| VG-ERR-013 | `ERROR` is used only where no candidate behavior was observed; harness setup failures are never `BLOCKED_CAPABILITY` or candidate `FAIL` before a provisioning attempt. | Fault injection on the harness (missing adapter, broken manifest) yields `ERROR` before provisioning and `BLOCKED_CAPABILITY` only after a recorded, failed provisioning attempt. | Recording `BLOCKED_CAPABILITY` with no provisioning log fails the assertion (DOD-033). |
| VG-ERR-014 | `BLOCKED_CREDENTIALS` names the credential by environment-variable/probe reference only and never records a secret value. | Every blocked-credentials row contains a `credentialRef` that matches an `ENVIRONMENT.md`/`PREFLIGHT.md` name and no value-shaped string. | A row embedding a credential value or probe output body fails the secret scan. |
| VG-ERR-015 | `EXTERNAL_REQUIRED` is cleared only by a named, scoped, dated human sign-off, and no agent action transitions it to another status. | Attempted programmatic clearing is refused and audited; a human sign-off record with role/scope/date transitions the row. | A scripted status write of `EXTERNAL_REQUIRED` → `PASS` fails the authorization assertion (DOD-039). |
| VG-ERR-016 | `DEFERRED_LONG_RUNNING` never appears as `PASS`; the abbreviated portion is reported separately with its own status. | A partial soak run yields `DEFERRED_LONG_RUNNING` with distinct `partialResultPath` and no `PASS` row for the full requirement. | Promoting an interrupted long run to `PASS` fails the assertion (DOD-038). |
| VG-ERR-017 | `INCONCLUSIVE` is used when evidence exists but is unbound to a pinned identity or is unreproducible, and it is never rounded to `PASS`/`FAIL`. | Removing the candidate/artifact pin from a run yields `INCONCLUSIVE` with `missingIdentityField` populated. | Reporting such a run as `PASS` or `FAIL` fails the assertion (DOD-025/029). |
| VG-ERR-018 | `PARTIAL` enumerates both covered and uncovered surface, and every coverage number carries a denominator. | Coverage report contains non-empty `coveredSurface[]` and `uncoveredSurface[]` and an explicit `coverageDenominator`. | A percentage without a denominator, or a `PARTIAL` row promoted to `PASS`, fails the report validator (SPEC-000 §7.4). |
| VG-ERR-019 | `SIMULATED` is confined to proofs whose only evidence is a double, and it never supports an integration or production claim. | A mock-only run yields `SIMULATED` with `substitutedDependency` and `doubleKind`; a claim built on it is rejected by the claim-to-release validator. | A `SIMULATED` row counted as production proof fails the traceability validator (DOD-010/020). |
| VG-ERR-020 | `UNVERIFIED` rows are retained in accounting and never summarized as working or omitted. | Accounting totals include every `UNVERIFIED` row; the sum of all statuses equals the expected ID count. | Dropping an `UNVERIFIED` row from totals fails the accounting invariant (DOD-030). |
| VG-ERR-021 | `NOT_APPLICABLE` requires at least one concrete repository-evidence reference per decision, and a change that introduces the construct invalidates the decision. | Every `NOT_APPLICABLE` row resolves to an existing path/row reference; introducing the targeted construct flips the row out of `NOT_APPLICABLE`. | An applicability decision justified only by prose fails validation (DOD-041). |
| VG-ERR-022 | `WITHDRAWN` retains its row and ID, records who/why, and never permits ID reuse. | Withdrawal records `withdrawnBy`, `withdrawnAt`, `decisionRef`; ID uniqueness validation still counts the row. | Reusing a withdrawn ID, or deleting its row, fails the ID-integrity validator (SPEC-000 §2). |
| VG-ERR-023 | Status transitions are audited; leaving `PASS`/`FAIL` requires a recorded reason and a changed epoch identity. | The status-transition audit contains a row per change with prior/new status, reason, and epoch ID. | A status change with no audit row fails the validator (ST-2). |
| VG-ERR-024 | The same status tokens are used in harness state, reports, issue text, and dashboards; paraphrases are defects. | Token scan over generated reports and issue templates finds only the §4.1 vocabulary in status positions. | A report using "mostly passing"/"effectively complete" in a status position fails the scan (DOD-026). |

### 11.4 Domain error catalogue (§5)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-025 | Every class in §5.3 exists as a typed, constructible error carrying the §5.1 common fields, and no class carries a field outside the allowlist. | Reflection/schema check enumerates all 25 classes, constructs each with valid fields, and validates the field set exactly. | A class carrying an unlisted field, or missing a required common field, fails the check. |
| VG-ERR-026 | `code`↔`class` is one-to-one and `code` strings are stable, uppercase, and permanent. | Uniqueness check over §5.3 plus §6.2 finds no duplicate `code`; a rename attempt is detected as a contract change. | Two classes sharing a `code`, or a lowercase/non-ASCII `code`, fails validation. |
| VG-ERR-027 | `HumanGateRequired` is a success-path outcome: severity `INFO`, zero error-counter increment, no bypass attempt, and no solver invocation. | Detecting a gate produces one `HumanGateRaised` audit event, one outcome record, and zero error-log entries. | Any attempt to bypass or solve the gate (CAPTCHA/OTP/ID) is detected and recorded as a VG-SCOPE-003 violation (VG-DISC-004). |
| VG-ERR-028 | `NoLawfulBasis` resolves to the `NOT_REMOVABLE` outcome with a recorded basis and never to an error or a failure. | Policy-exemption path yields `outcomeClass=NOT_REMOVABLE` with `basisRef` and no error row. | Hiding a `NOT_REMOVABLE` outcome to improve apparent success rate fails the metric-integrity check (VG-OBS-002). |
| VG-ERR-029 | `AuthorityExpired` / `AuthorityMissing` / `AuthorityScopeViolation` are raised **at execution time**, refuse the write, and record the grant reference. | Execution with an expired/revoked/out-of-scope grant produces the refusal, carries `authorityGrantId`, and creates no `ExternalAction`. | Relying on a validation performed earlier in the request (rather than at the write) is detected by a time-shifted-grant test (VG-AUTHZ-001). |
| VG-ERR-030 | `PolicyUnresolved` is raised when no policy row/legal basis resolves, and `NoLawfulBasis` when policy resolves to "no path"; the two are never interchanged. | An unmapped jurisdiction yields `PolicyUnresolved`; a mapped jurisdiction with an exemption yields `NoLawfulBasis` + `NOT_REMOVABLE`. | Returning `NoLawfulBasis` for a missing policy row (or vice versa) fails the class-selection assertion. |
| VG-ERR-031 | `RecipeStale` and `RecipeUnsigned` disable the recipe and prevent any write; signature verification failure never falls back to an unsigned path. | With a stale or tampered recipe, the write is refused, `enabled=false` is persisted, and `recipe_refused_total` increments. | Proceeding to write when signature verification is unavailable fails the assertion (VG-CHANNEL-003). |
| VG-ERR-032 | `PermissionUnclear` blocks all writes for the source until a human classifies it; unknown/unrecognized classes are treated as unclear. | An unknown or missing `permissionClass` yields the refusal and a disabled write path. | Treating an unknown class as permitted fails the fail-closed assertion (VG-CHANNEL-002). |
| VG-ERR-033 | `IdempotencyConflict` is raised for same-key/different-intent and never produces a second external effect or a silent key replacement. | Replaying a key with a changed payload digest yields the conflict, preserves the original action, and performs no new effect. | Reusing the key for the new intent (or minting a new key silently) fails the assertion (VG-ACTION-001). |
| VG-ERR-034 | `AmbiguousExternalEffect` produces a reconciliation record and no retry of the write. | A simulated timeout on a write yields one reconciliation record, one `ActionAmbiguous` event, and exactly one attempt. | A blind retry producing two effects or two mail pieces fails the assertion (VG-ACTION-002). |
| VG-ERR-035 | `BudgetExceeded` refuses and audits, treats unreadable budget state as exhausted, and is recorded as an honest outcome rather than a failure. | Exceeding a configured per-subject/source/window budget yields the refusal with `limit`/`consumed`/`windowResetAt` recorded. | Continuing to write past the budget, or hiding the refusal, fails the assertion (VG-ACTION-005). |
| VG-ERR-036 | `TaintedContentRejected` refuses any operation directed by untrusted content and records the taint origin without storing the content. | An injection payload in fetched content cannot select a channel or trigger a write; the record carries origin class only. | Following an instruction embedded in fetched content to reach a write fails the assertion (VG-SEC-001). |
| VG-ERR-037 | `EgressDenied` blocks egress before the attempt, for policy denial and for DLP unavailability alike. | Denied egress produces no outbound request (verified by an independent network observation) and an audit entry. | A denied payload reaching the destination fails the assertion (VG-EGRESS-001/002). |
| VG-ERR-038 | `DigestMismatch` quarantines the artifact, raises an integrity incident, and never re-hashes to obtain a match. | Mutating a stored artifact yields the mismatch, quarantine, and incident record. | Serving the mutated artifact or regenerating its digest to match fails the assertion (VG-EVIDENCE-001). |
| VG-ERR-039 | `TenantViolation` is enforced independently in the service layer and in RLS, is alerted, and is never disclosed to the caller (404 only). | A cross-tenant attempt is refused by both layers independently, produces an alert, and returns the generic 404 envelope. | A response body or timing signal that reveals the existence of another tenant's resource fails the assertion (VG-TENANT-001/002). |
| VG-ERR-040 | `ObservationNotIndependent`, `ObservationWindowNotMet`, and `VerificationMethodMismatch` prevent any transition to `VERIFIED_REMOVED`. | Same-path re-observation, premature observation, and method mismatch each leave the case at `ACKNOWLEDGED` with a `VerificationFailed` event. | Reaching `VERIFIED_REMOVED` from a controller claim or a search delisting fails the assertion (VG-VERIFY-001/002/003, SPEC-001 §4.2). |
| VG-ERR-041 | `InvalidValueObject` rejects invalid SPEC-001 §2 input with the type, the violated rule, and a shape-only description; outcome-classed errors refuse severity above `INFO`. | Each §2 validation rule has a rejection case carrying `valueObjectType`+`violatedRule` and no input value; constructing an `OUTCOME` class with `ERROR` severity is refused. | Echoing the offending value back in the error fails the PII check; allowing `ERROR` severity on an outcome class fails the classification check. |
| VG-ERR-042 | The catalogue is complete: every refusal path in the domain raises a class from §5.3, and no unknown/generic error escapes the catalogue. | A generic-error detector flags any raised error whose class is not in §5.3 (including a bare language-level exception) as a defect with its call site; every wire code of §6.2 that is not transport-owned has a domain class or a documented raising layer. | A bare exception or string error reaching the API layer fails the assertion (H-7, H-8). |
| VG-ERR-043 | Classification, retryability, and severity are immutable static metadata per class and cannot be overridden at the call site. | Boot-time validation compares the static policy table to §5.3/§10.1 and fails on any divergence; call-site overrides are rejected. | A configuration that flips `TenantViolation` or `NoLawfulBasis` to retryable fails boot validation (NR-1). |

### 11.5 HTTP mapping (§6)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-044 | Every error response is the single SPEC-003 §8.1 envelope with all required fields of §6.1; no response carries two shapes; success, outcome, and reconcile responses never carry the error envelope. | Public-interface responses validate against the envelope schema for every code in §6.2; no response carries both `error` and success fields. | A non-2xx response lacking `code`, `requestId`, or `correlationId`, or a kind-A outcome returned as an `error` envelope, fails schema validation. |
| VG-ERR-045 | Non-2xx codes are the closed, stable §6.2 set; each code has exactly one status; the table is byte-identical to SPEC-003 §8.2 for every code SPEC-003 enumerates; and no domain class maps to `INTERNAL_ERROR`. | A generated comparison of §6.2 against SPEC-003 §8.2 finds zero divergent statuses; a matrix-completeness check fails on any §5.3 class with no mapping. | A known condition surfacing as `INTERNAL_ERROR`, or a code whose status differs between the two specifications, fails the contract test (H-7, H-8). |
| VG-ERR-046 | `message` is the invariant template string for its `code`, with no request data interpolated; only the immutable enum tokens named by the template may vary. | Byte-comparison of each observed `message` to its §6.2 template, with only declared enum placeholders substituted. | A message containing an ID, name, URL, provider text, or any dynamic value fails the assertion (H-3). |
| VG-ERR-047 | `details` keys are restricted to the §5.1/§5.4 allowlist and are schema-validated per code before the response is written; no request body, PII value, stack trace, or verbatim provider body appears. | Every observed `details` payload validates against its per-code key allowlist. | An unlisted key, a PII-shaped value, or an echoed provider body fails validation (H-13, H-14). |
| VG-ERR-048 | A legitimate outcome or a candidate failure is never returned as 5xx; 5xx is reserved for `SYSTEM` conditions. | Status-code audit: `NOT_REMOVABLE`/`HUMAN_REQUIRED` outcome routes and `AMBIGUOUS_EXTERNAL_EFFECT` never observed as 5xx. | Returning 500 for a legitimate outcome, or for a refused controller/source, fails the assertion (H-10). |
| VG-ERR-049 | `Retry-After` is present on every `429` and on every retryable `503`, and its value equals the server's own computed retry decision (§10.2). | Header presence and value checked per response against the recorded retry decision. | A `429` without `Retry-After`, or a header contradicting the server's backoff, fails the assertion (H-11). |
| VG-ERR-050 | No envelope or response body uses ad-hoc success or completion vocabulary in `code`, `message`, or field names. | Token scan over responses and generated DTOs rejects `SUCCESS`, `DONE`, `COMPLETE`, `REMOVED`, `OK`, `NONE` (SPEC-000 §4, SPEC-003 §7.3). | Any forbidden token in an envelope or DTO fails the vocabulary gate (H-12). |

### 11.6 Fail-closed (§7, DOD-014)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-051 | Default deny on unknown or missing `permissionClass`: no write is attempted and the source write path is disabled until classification. | Unknown-class fixture yields the refusal, a disabled write path, and a zero-write observation. | Any write attempt under an unknown class fails the assertion. |
| VG-ERR-052 | Unknown/unresolvable jurisdiction produces a legitimate `HUMAN_REQUIRED` outcome (or `PolicyUnresolved` when the policy store is unavailable), and never a model-invented legal basis. | Unmapped jurisdiction yields `HumanGateRequired` (gate `LEGAL_REVIEW`) with no external write and no model-authored `LegalBasis`. | A model-suggested basis reaching a `PolicyDecision` fails the assertion (VG-POLICY-001). |
| VG-ERR-053 | Unknown recipe freshness (absent, unparseable, or clock unavailable) disables the recipe and produces no write. | Removing/unparsing `freshnessAt` yields `RECIPE_STALE` and `enabled=false`, with zero writes. | Assuming freshness or reusing an older successful run's freshness fails the assertion. |
| VG-ERR-054 | Absent independent observation prevents `VERIFIED_REMOVED` under all circumstances, including controller claims and search delistings. | Every attempted promotion without a distinct-path observation leaves the case at `ACKNOWLEDGED` with a `VerificationFailed` event. | A claim-based promotion to `VERIFIED_REMOVED` fails the assertion (SPEC-001 §4.2, VG-VERIFY-001). |
| VG-ERR-055 | Credential and secret resolution failures fail closed: no attempt, no default credential, no cached value, no secret in output. | With the secret resolver unavailable, the operation is refused with `DEPENDENCY_UNAVAILABLE`, zero outbound attempts, and zero secret-shaped strings in logs. | Falling back to a `.env`/plaintext/empty credential fails the assertion (VG-SEC-002, §7.1 #16). |
| VG-ERR-056 | Dependency unavailability flips readiness false and refuses new writes; no in-memory or cached substitute is presented as durable. | Induced dependency failure flips `/readyz` to not-ready and refuses the write with a 503 envelope. | A static `200` readiness or an in-memory fallback presented as durable fails the assertion (VG-OPS-001, DOD-015/020). |
| VG-ERR-057 | An unavailable audit sink abandons the operation: no state change is committed without its audit event. | With the sink failing, the operation is refused, state is unchanged, and no "pending audit" buffer is presented as committed. | Committing state and deferring audit fails the assertion (SPEC-001 SM-2, VG-EVIDENCE-003). |
| VG-ERR-058 | Revoked/expired authority and replayed/invalid webhooks fail closed with no external effect and no state change. | Expired-grant and replayed-webhook fixtures produce the refusal, zero effects, and unchanged state. | A replayed webhook producing a second state change fails the assertion (VG-SEC-004). |

### 11.7 No-masking (§8, DOD-024)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-059 | No CI/script step uses continue-on-error, `\|\| true`, or equivalent for a gate; every gate step is fail-fast and reports its own status row. | Static scan of scripts and CI configuration finds zero masking constructs on gate steps; each gate has a distinct status row. | Introducing `continue-on-error` on a gate is detected by the scan and revokes dependent `PASS` rows. |
| VG-ERR-060 | Raw exit codes are captured, propagated, and recorded per gate; pipeline masks (missing `pipefail`) are prohibited. | Evidence rows contain the producer's exit code, and a failing producer through a pipeline still fails the step. | A failing command piped through a formatter that yields exit 0 is detected as a masking defect. |
| VG-ERR-061 | No production path returns unconditional success: every success sentinel is emitted only on the success path after the observed condition, bound to the run identity. | Sentinel-scan finds no pre-emptive or literal success emission; each sentinel is reachable only after the check. | A hard-coded success path fails the scan (DOD-019, DOD-024). |
| VG-ERR-062 | Swallowed exceptions and blanket catches are prohibited: every caught error is classified, recorded with class and `ruleRef`, and re-raised when unhandled. | Static scan finds no empty catch/pass-on-exception; runtime fault injection confirms a record exists for each handled fault. | A caught-and-ignored exception that changes observable behaviour silently fails the assertion. |
| VG-ERR-063 | Retry policies are allowlists: only classes marked retryable in §10.1 are retried, with the declared attempt caps. | Boot-time policy validation compares the runtime retry table to §10.1 and fails on any extra retryable class. | A configuration making `NoLawfulBasis`, `PermissionUnclear`, or `TenantViolation` retryable fails boot validation. |
| VG-ERR-064 | Output is never filtered to hide failure: the full raw log is an evidence artifact and the first failure is always retained and linked. | Log-preservation check confirms the untruncated artifact exists and the first failure is referenced before any summary view. | A run whose evidence contains only a filtered/truncated log fails the assertion. |
| VG-ERR-065 | Baselines are never auto-accepted: snapshot/lint/scan baselines change only by reviewed human commit with a rationale. | CI configuration contains no auto-update flag on a baseline-producing step; a baseline diff without a review record fails the gate. | An auto-updated snapshot that hides a regression fails the assertion. |
| VG-ERR-066 | A discovered masking pattern revokes prior `PASS` rows and invalidates dependent claims. | Injecting a masking pattern after a pass transitions the affected rows out of `PASS` and flags dependents. | Retaining a `PASS` produced under masking fails the accounting invariant (NM-4, DOD-040). |

### 11.8 No-PII-in-errors (§9, VG-EGRESS-002)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-067 | Error records, logs, traces, metrics, issue text, and PR text contain opaque IDs only — never subject names, aliases, emails, phones, addresses, government identifiers, DOB, or profile content. | Canary-driven run (§9.2) observes zero canary matches across all emissions in every channel. | A single canary match is a release blocker and revokes dependent claims. |
| VG-ERR-068 | Errors never contain raw remote content, cookies, headers, tokens, secrets, connection strings, or raw `SourceRecord`/document/artifact content. | Secret/PII scan over emitted errors and logs finds zero secret-shaped or content-shaped values; only class names, codes, and IDs appear. | An error embedding a token, cookie, or page excerpt fails the scan (VG-SEC-002). |
| VG-ERR-069 | Validation errors describe shape, not value: `InvalidValueObject` reports type, violated rule, and a shape description only. | Each validation rejection carries `valueObjectType`+`violatedRule`+shape text and no offending value. | Echoing the invalid value fails the assertion. |
| VG-ERR-070 | Metric labels are drawn from the closed enum set (`code`, `class`, `category`, `tenantId`, declared reason enums); case/subject/action IDs and free text are forbidden as labels. | Label-cardinality and enum audit over exported metrics finds no forbidden label keys. | A metric labelled with a `caseId` or free text fails the audit. |
| VG-ERR-071 | DLP scrubbing runs before every egress event (telemetry, issue, PR, repair capsule) and records redaction evidence; the scrub is fail-closed. | Every observed egress event carries a resolvable `redactionEvidenceId`; with the scrubber unavailable, egress is denied with zero outbound requests. | An egress event without redaction evidence, or egress attempted while the scrubber is down, fails the assertion (VG-EGRESS-002, §7.1 #14). |
| VG-ERR-072 | The canary check is discriminating and runtime-generated: a deliberately seeded leak is detected, and canaries are unpredictable per run. | The canary harness detects the seeded control leak and records seed/source, generated values, propagation trace, and the independent observation. | Static/hard-coded fixture values, or a check that misses the seeded control leak, fails the assertion (DOD-013, DOD-018). |

### 11.9 Retry and backoff (§10)

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-ERR-073 | Retry decisions are per class exactly as §10.1 declares; non-retryable classes attempt exactly once. | Runtime retry-policy table equals §10.1; attempt counts per class match the declared caps. | A non-retryable class retried a second time fails the assertion. |
| VG-ERR-074 | Backoff is deterministic exponential with jitter within declared bounds, and an explicit `Retry-After` overrides the computed delay. | Recorded delays match the formula within the jitter bound; a dependency-supplied `Retry-After` is honored exactly. | A fixed-interval or unbounded-delay schedule fails the assertion. |
| VG-ERR-075 | The bounded ladder terminates after three consecutive same-signature failures, escalates, and never extends; ladder state is durable and tenant-scoped. | Injecting a persistent same-signature fault yields exactly three attempts, a terminal record, and an alert; restart mid-ladder preserves the count. | A fourth attempt, or an in-memory ladder reset by restart, fails the assertion. |
| VG-ERR-076 | Retries preserve exactly one `IdempotencyKey` per intended external effect, and a write-path timeout escalates to reconciliation rather than retry. | Across all attempts of one intended effect the key is identical and the effect count is ≤1; a write timeout yields a reconciliation record and no retry. | A new key per attempt, or a blind write retry, fails the assertion (VG-ACTION-001/002, DOD-017). |

---

## 12. Conflicts and ambiguities recorded against SPEC-000/SPEC-001

Recorded here rather than resolved silently. Per SPEC-000, SPEC-000 wins; these
items require an authoritative decision (human or a SPEC-000 amendment) and are
open. Findings F-1 … F-6 concern the concurrent SPEC-003 (`/v1` API contracts)
revision, which already fixed parts of the error surface this file owns.

1. **`VG-ERR` is a new domain token.** SPEC-000 §2 fixes the scheme
   `VG-<DOMAIN>-<NNN>` but §6 does not enumerate an error domain. No existing ID
   collides (verified: zero `VG-ERR-` occurrences in the repository before this
   file). Registered here as a new domain.
2. **Forbidden-synonym pressure on requested identifiers.** SPEC-000 §4 lists
   `permission` as a forbidden synonym for both `AuthorityGrant` and `HumanGate`.
   The requested class name `PermissionUnclear` and SPEC-001 §2's own
   `PermissionClass` value object both use that token. This file uses the
   requested class name `PermissionUnclear` and the SPEC-001 token
   `PermissionClass`, and carries the §4 intent by never using "permission" to
   mean an authority grant or a human gate. SPEC-000 §4 does not list
   `PermissionClass`, so it is treated as a permitted technical enum, not a
   canonical concept term.
3. **`AuthorityMissing` vs `MissingAuthority`.** The requested class name is
   `AuthorityMissing`; this file adopts it. No conflict with SPEC-001, which
   names no error class.
4. **`HumanGateRequired` is not an error.** SPEC-000 §5 state 10 and SPEC-001
   SM-5 make `HUMAN_REQUIRED` a first-class outcome. The requested class name is
   retained as a **typed outcome signal** and classified `OUTCOME`; treating it
   as an exception-recorded failure is a DOD-032 defect (VG-ERR-002, VG-ERR-027).
5. **`NoLawfulBasis` is an outcome, not an error.** SPEC-000 §5 state 9 makes
   `NOT_REMOVABLE` "not failure, error, or an unfinished attempt". It is
   classified `OUTCOME` here (VG-ERR-028, VG-ERR-030). `BudgetExceeded` is
   likewise classified `OUTCOME`, since VG-ACTION-005 specifies refusal and
   audit, not an error.
6. **Status taxonomy source is split.** DOD-032 enumerates only nine statuses
   (`FAIL`, `ERROR`, the five `BLOCKED_*`, `EXTERNAL_REQUIRED`,
   `DEFERRED_LONG_RUNNING`) and mandates required fields for those. The additional
   seven required here — `PASS`, `INCONCLUSIVE`, `PARTIAL`, `SIMULATED`,
   `UNVERIFIED`, `NOT_APPLICABLE`, `WITHDRAWN` — are implied by DOD-005/007/010/
   012/013/020/025/026/029/030/038/041 and SPEC-000 §2, but DOD-032 does not name
   them or fix their required fields. §4.1 supplies those fields; DOD-032 should
   be read as covering the union.
7. **`EXPERIMENTAL` is unaccounted.** DOD-026's prose token list includes
   "experimental"; the required 16-status set has no such member. This file maps
   an experimental result to `SIMULATED` (with an explicit `doubleKind`) or
   `PARTIAL`, whichever reflects the evidence. A distinct `EXPERIMENTAL` status
   would need a DOD-032 amendment.
8. **`ERROR` vs `FAIL` boundary for provenance defects.** DOD-029 makes missing
   candidate/artifact identity `INCONCLUSIVE`; DOD-007 makes zero collection
   `ERROR`. A run that collects zero tests **and** lacks a pinned candidate is
   asserted as `ERROR` here (harness breakage dominates); this precedence is not
   stated in the DOD registry.
9. **No SPEC-001 command raises ambiguity.** SPEC-001 §6 defines `ExecuteAction`
   → `ActionSubmitted` and §7 lists `ActionAmbiguous`, but §4.1 contains no
   transition for an ambiguous action. `AmbiguousExternalEffect` is therefore
   bound to the `ActionAmbiguous` event with the case **unchanged** (no
   transition), which is consistent with §4.2 but means the reconcile state is not
   represented in the truth model. A `RECONCILING` state would require a
   SPEC-000 §5 amendment; none is proposed here.
10. **`BudgetExceeded` is both an event and an error class.** SPEC-001 §7 lists
    `BudgetExceeded` as a domain event; this file's class of the same name emits
    that event (VG-ERR-035). Naming collision is intentional and must not be
    duplicated into two unrelated concepts.
11. **`TenantViolation` vs RLS zero-row semantics.** SPEC-000 VG-TENANT-001
    requires a cross-tenant read to return **zero rows** at the database layer.
    A raised error is observable. This file therefore requires the *client-facing*
    response to be the generic 404 (§7.1 #13, VG-ERR-039) so that no existence
    signal leaks, while the domain still raises `TenantViolation` for audit and
    alerting. The interaction between "zero rows" and "typed error" is not
    addressed by SPEC-000.
12. **F-1 — SPEC-003 §8.2 was authored concurrently and is now the contract.** At
    the time this file was drafted, SPEC-003 (`SPEC-003-api-contracts.md`) was a
    155-byte stub; it was written in full by another actor while this file was
    being written, and already fixes the `/v1` error envelope (§8.1), the code set,
    and the code→status mapping (§8.2). §6 here therefore **adopts SPEC-003 §8.2
    verbatim** for every code SPEC-003 enumerates and defers to it on status codes,
    and it registers the domain-only codes SPEC-003 leaves to this file. Concretely,
    this file's earlier draft values were revised to match SPEC-003:
    `RECIPE_STALE` 503→409, `RECIPE_UNSIGNED` 503→409, `PERMISSION_CLASS_UNCLEAR`
    503→`SOURCE_PERMISSION_UNCLEAR` 409, `AUTHORITY_EXPIRED`/`AUTHORITY_MISSING`
    403→`AUTHORITY_EXPIRED`/`AUTHORITY_INVALID`/`AUTHORITY_REVOKED` 409,
    `AUTHORITY_SCOPE_VIOLATION` 403→`AUTHORITY_GRANT_SCOPE_INSUFFICIENT` 422,
    `OBSERVATION_WINDOW_NOT_MET` 409→422, `BUDGET_EXCEEDED` 429→
    `EFFECT_BUDGET_EXCEEDED` 409, `DIGEST_MISMATCH`→`EVIDENCE_INTEGRITY_FAILURE`
    409 on read / `EVIDENCE_DIGEST_MISMATCH` 422 at ingestion, `EXTERNAL_TIMEOUT`
    504→`AMBIGUOUS_EXTERNAL_EFFECT` 202 on write / `DEPENDENCY_UNAVAILABLE` 503 on
    read, and `HUMAN_GATE_REQUIRED` 409→`200` outcome body.
    **Residual tension:** SPEC-003 §8.2 states its codes "may not be renamed or
    removed" without a breaking-change process, while SPEC-003 §8.4 states that
    "where SPEC-006 later defines a code that overlaps one of these, SPEC-006
    governs the spelling and this file must be updated to match". Those two
    sentences disagree about which file wins on spelling. This file resolves the
    ambiguity conservatively for the wire (adopting SPEC-003's spellings and
    statuses unchanged) and keeps its own internal domain codes, which are what
    audit and telemetry record. A human decision is still required on which file
    owns the wire spelling.
13. **F-2 — SPEC-003 is a moving target.** SPEC-003 was rewritten again after §6
    was reconciled against it. Any change to its §8.1/§8.2 invalidates §6.2 here
    and must invalidate the mapping tests (VG-ERR-045), exactly as VG-REL-004
    invalidates dependent evidence. §6.2 records the reconciliation as a
    **reviewed point-in-time adoption**, not a permanent guarantee; the contract
    test that compares the two files is what keeps them aligned.
14. **F-3 — `NO_LAWFUL_BASIS`, `TAINTED_CONTENT_REJECTED`, and `EGRESS_DENIED` are
    domain-only wire codes.** SPEC-003 §8.2 does not enumerate them. They are
    required by SPEC-000 §5 state 9, VG-SEC-001, and VG-EGRESS-001 respectively, so
    §5.3 keeps them and §6.2 marks them *(domain-only)*. SPEC-003 should add rows
    rather than have these conditions be re-spelled by an implementer.
15. **F-4 — `SEARCH_DELISTED`-class and legal-determination errors are outcome
    codes, not error codes.** SPEC-003 §10.10 forbids any route performing a legal
    determination, and SPEC-000 §7.6 forbids hiding `NOT_REMOVABLE` and
    `HUMAN_REQUIRED`. This file therefore renders those conditions as 200 outcome
    bodies and reserves error codes for refusals. If SPEC-003 later adds a
    `requiresCounselReview` refusal code, it must be added to §6.2's transport
    table, not re-mapped onto an existing domain class.
16. **F-5 — two `DEPENDENCY_UNAVAILABLE` consumers.** `AuditUnavailable` and
    `StorageUnavailable` are distinct domain classes (different retry semantics,
    different readiness effects, different alerts) that collapse to one wire code.
    That collapse is intentional and correct for clients — the distinction belongs
    in `details.reason` and in telemetry — but it means a client cannot tell an
    audit-store outage from a database outage. SPEC-003 §8.2 should note the
    `details` discriminator if client-visible differentiation is ever required.
17. **F-6 — `HumanGate` status.** SPEC-003 sets the human-gate route to `200` with
    `truthState: "HUMAN_REQUIRED"` (VG-API-040), which this file adopts: the
    legitimate outcome is a success response carrying an honest state, not an error.
    `HUMAN_GATE_OPEN`/`HUMAN_STEP_REQUIRED` (`422`) are retained only for the
    different case where an already-open gate blocks an unrelated guarded route.
    This resolves the earlier draft's `409 HUMAN_GATE_REQUIRED` mapping, which is
    withdrawn.

---

## 13. Acceptance for this specification

This specification is satisfied when, for error handling alone:

1. Every class in §5.3 exists with §5.1 fields, the declared classification, and
   the declared retryability (VG-ERR-025, VG-ERR-043).
2. Every code in §6.2 maps to exactly one HTTP status and one invariant message
   template, the mapping agrees with SPEC-003 §8.2 for every code SPEC-003
   enumerates, and envelope schema validation passes for every code
   (VG-ERR-044 … VG-ERR-050).
3. Every fail-closed row in §7.1 has an executed negative case proving
   **no external effect and no fabricated success** (VG-ERR-051 … VG-ERR-058,
   DOD-014).
4. Every masking pattern in §8 has a detection check that fails when the pattern
   is introduced (VG-ERR-059 … VG-ERR-066, DOD-024).
5. The canary harness reports zero PII/secret matches and detects its own seeded
   control leak (VG-ERR-067 … VG-ERR-072, DOD-013, VG-EGRESS-002).
6. The bounded ladder terminates in three same-signature attempts and survives
   restart (VG-ERR-075).
7. At least one controlled defect per error class causes the relevant test to
   fail, and the domain's import boundary and the harness's taxonomy validator both
   hold (DOD-018, SPEC-001 §8).

Items 1–7 are unit- and integration-testable without external credentials for the
domain and mapping portions; items touching real dependencies remain
`BLOCKED_CREDENTIALS`/`EXTERNAL_REQUIRED` until those gates are supplied
(SPEC-000 §11) — never `PASS` by substitution.
