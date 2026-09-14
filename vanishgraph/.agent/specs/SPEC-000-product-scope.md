# SPEC-000 — Product Scope, Vocabulary Lock, and Acceptance Oracle

Status: SPECIFICATION (normative). Supersedes the stub of the same path.
Authority: This document is the oracle for every other SPEC. Where any other
document, comment, prompt, roadmap entry, or model output contradicts this file,
**this file wins**. Contradiction is a defect (DOD-027).

Requirement-ID scheme: `VG-<DOMAIN>-<NNN>`. IDs are permanent. An ID is never
reused, renumbered, or deleted; a withdrawn requirement moves to status
`WITHDRAWN` and retains its row. Every ID has exactly one acceptance oracle and
exactly one required negative case (DOD-001, DOD-008, DOD-014).

---

## 1. Purpose

VanishGraph Privacy Removal OS is a multi-tenant, evidence-first privacy-removal
service. It discovers public exposure for **verified subjects**, determines
**lawful and provider-permitted** channels, records durable requests and
evidence, **independently verifies** source and search outcomes, and monitors
reappearance.

VanishGraph is a system of record for *evidence about removal attempts*. It is
not a claim engine, not a scraping service, and not an agent that asserts rights
on a subject's behalf without proven authority.

## 2. Scope

In scope for v1:

- Subject-bound discovery across declared, recipe-covered sources.
- Independent identity matching with recorded confidence and provenance.
- Jurisdiction-aware policy resolution held in **versioned data**, not prompts.
- Multi-channel external action: official self-service, privacy email,
  authorized-agent request, California DROP, search-engine removal, certified
  mail, appeal/regulator packet, and honest non-removability.
- Durable case state with typed transitions and append-only audit.
- Independent post-action verification via a second observation path.
- Reappearance monitoring and re-removal.
- Tenant-isolated evidence with independent readback.
- Honest coverage reporting that states what was *not* checked.

## 3. Non-goals (hard exclusions)

These are prohibited regardless of user request, commercial pressure, or
apparent technical feasibility. Implementing any of them is a release blocker.

| ID | Prohibited behavior |
|---|---|
| VG-SCOPE-001 | Stalking, harassment, or surveillance of any person. |
| VG-SCOPE-002 | Campaigns against subjects who are not the tenant's verified subject or an authorized dependent. |
| VG-SCOPE-003 | Bypassing CAPTCHA, OTP, phone/ID verification, paywalls, or access controls. |
| VG-SCOPE-004 | Cookie, session, or token theft; undocumented or private provider endpoints. |
| VG-SCOPE-005 | False or unsupported legal claims, citations, or regulator threats. |
| VG-SCOPE-006 | Suppression of public-interest, newsworthy, or lawful speech. |
| VG-SCOPE-007 | Sale, resale, brokerage, or enrichment of subject PII. |
| VG-SCOPE-008 | Training external models on raw customer PII (see SPEC-007 egress classes). |
| VG-SCOPE-009 | Autonomous production deployment. |
| VG-SCOPE-010 | Consumer-subscription pooling or resale without written provider authorization. |

## 4. Vocabulary lock

These terms are **canonical**. Code identifiers, API fields, UI copy, logs,
metrics, ledger entries, and test names must use exactly these tokens. The
"forbidden synonym" column lists tokens that must not appear in production
paths; the anti-gaming and vocabulary gates reject them.

| Canonical term | Meaning | Forbidden synonyms |
|---|---|---|
| `ProtectedSubject` | The natural person whose exposure is being addressed. | client, target, victim, user_profile |
| `AuthorityGrant` | Typed, evidenced proof that the tenant may act for a subject. | consent, permission, approval |
| `Source` | A public location class (broker site, registry, search engine). | site, vendor, provider |
| `RemovalRecipe` | Versioned, signed procedure for acting on one Source. | scraper, script, bot, automation |
| `SourceRecord` | One observed public record on a Source. | hit, listing, result, lead |
| `Exposure` | A `SourceRecord` assessed as belonging to a `ProtectedSubject`. | match, finding, compromise |
| `Confidence` | Calibrated 0.00–1.00 score with recorded basis. | score, probability, certainty |
| `PolicyDecision` | Recorded resolution of jurisdiction + channel + legal basis. | ruling, verdict |
| `RequestCase` | The durable unit of work for one subject × source × exposure. | ticket, job, task |
| `ExternalAction` | A write to the outside world (form, email, mail, portal). | request, submission |
| `IdempotencyKey` | Stable key making one external effect happen at most once. | dedupe_key, nonce |
| `VerificationObservation` | An independent re-observation after an action. | check, recheck, confirmation |
| `Reappearance` | A prior `VERIFIED_REMOVED` exposure observed again. | relapse, regression |
| `EvidenceArtifact` | Immutable, hashed proof bound to a case. | attachment, file, screenshot |
| `Controller` | The organization legally responsible for the data. | broker, company, entity |
| `HumanGate` | A legitimate human step the system must not bypass. | blocker, captcha_wall |
| `DLP` | Data-loss-prevention scrub before any egress. | sanitizer, cleaner |

**Truth-state tokens are reserved.** The eleven states in §5 are the only
permitted terminal-status vocabulary for exposure and case lifecycle. Ad-hoc
statuses (e.g. `DONE`, `COMPLETE`, `SUCCESS`, `REMOVED`) are forbidden —
`SUCCESS` is not a truth state because it asserts an outcome without evidence.

## 5. Product truth model

Every exposure and case resolves to exactly one current truth state. These are
**not** progress indicators and are **not** interchangeable. Collapsing any two
of them is a fabrication defect (DOD-027).

| # | State | Precise meaning | Explicitly does **not** mean |
|---|---|---|---|
| 1 | `DISCOVERED_CANDIDATE` | A record was retrieved that may relate to the subject. | Subject match, contactability, or removability. |
| 2 | `MATCH_CONFIRMED` | Recorded evidence supports subject identity above policy threshold. | Removal is possible or lawful. |
| 3 | `REQUEST_READY` | Valid authority + policy decision + fresh recipe all exist. | Any external action has occurred. |
| 4 | `REQUEST_SUBMITTED` | A channel accepted the action (HTTP 2xx, mail accepted, email queued). | Controller received, read, or will act. |
| 5 | `ACKNOWLEDGED` | The controller or provider responded acknowledging the request. | Deletion occurred. |
| 6 | `VERIFIED_REMOVED` | Independent re-observation no longer finds the record **via the recipe's required verification method**, meeting the observation window. | Deletion from backups, downstream copies, or other sources. |
| 7 | `SEARCH_DELISTED` | A search engine no longer returns the result. | Source-page deletion. Search and source are separate effects. |
| 8 | `VERIFIED_NOT_PRESENT` | A valid scan observed no confirmed listing. | That none ever existed. |
| 9 | `NOT_REMOVABLE` | A lawful/public-interest/technical limit prevents removal, with recorded basis. | Failure, error, or an unfinished attempt. |
| 10 | `HUMAN_REQUIRED` | A legitimate human, identity, legal, or provider gate blocks automation. | A defect or an error. |
| 11 | `REAPPEARED` | A previously `VERIFIED_REMOVED` exposure is observed again. | That the earlier verification was necessarily wrong. |

### 5.1 Non-collapse rules

- `REQUEST_SUBMITTED` ⇒ never render as "removed" in UI, API, metric, or log.
- `ACKNOWLEDGED` ⇒ never satisfy a removal acceptance criterion.
- `SEARCH_DELISTED` ⇒ never increments the source-removal metric.
- `VERIFIED_REMOVED` ⇒ requires a linked `VerificationObservation` from a
  **different** observation path than the one that performed the action
  (DOD-012). Same-session, same-client self-report is insufficient.
- `VERIFIED_NOT_PRESENT` ⇒ requires a valid, in-scope scan; if coverage is
  partial the state must be reported with coverage bounds, not as absence.

## 6. Requirement catalogue

Each requirement carries an acceptance oracle (how a pass is judged) and a
required negative case (DOD-014). `Test` names the owning registry family.

### 6.1 Identity and exposure graph

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-IDENT-001 | A `ProtectedSubject` is created only with a verified `AuthorityGrant`. | Attempted creation without authority is rejected and audited. | Forged/expired grant rejected; no subject row created. |
| VG-IDENT-002 | Aliases and historical identifiers attach to one subject with provenance. | Each alias row records source, method, and timestamp. | Ambiguous alias that matches two subjects is quarantined, not auto-attached. |
| VG-IDENT-003 | `Confidence` is calibrated and its basis is recorded. | Score plus recorded feature basis retrievable for every match. | A match with no recorded basis fails validation. |
| VG-IDENT-004 | `SEARCH_HIT` is never treated as `SUBJECT_MATCH`. | Type system prevents a search result from entering a removal path. | Name-only collision must not reach `MATCH_CONFIRMED`. |

### 6.2 Discovery

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-DISC-001 | Discovery is read-only by default. | Discovery actors hold no write recipe capability. | A discovery run attempting a write is denied and audited. |
| VG-DISC-002 | Discovery declares its coverage surface and reports what was **not** checked. | Coverage report lists attempted, succeeded, and skipped sources with reasons. | Partial run cannot report "no exposure found" unqualified. |
| VG-DISC-003 | Rate limits are per-source, conservative, and enforced. | Exceeding configured rate is refused client-side. | Burst test shows refusal, not silent overrun. |
| VG-DISC-004 | Human/provider gates produce `HUMAN_REQUIRED`, never a bypass attempt. | Gate detection classified and recorded; no solver invoked. | CAPTCHA fixture yields `HUMAN_REQUIRED`. |

### 6.3 Authority and policy

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-AUTHZ-001 | Every external write requires a valid, unexpired, scoped `AuthorityGrant`. | Write path asserts grant scope + expiry at execution time. | Expired grant ⇒ refused, no external effect. |
| VG-AUTHZ-002 | Authorized-agent action requires recorded, signed authority evidence. | Signed instrument stored as `EvidenceArtifact` with hash. | Missing/unsigned instrument ⇒ `HUMAN_REQUIRED`. |
| VG-AUTHZ-003 | Self-service action requires subject identity verification proportionate to risk. | Verification method and result recorded per case. | Unverified self-claim cannot reach `REQUEST_READY`. |
| VG-POLICY-001 | Jurisdiction rules live in versioned data, not prompts or model output. | Policy rows carry effective dates and version; a model cannot author a legal basis. | Model-suggested basis without a matching policy row is rejected. |
| VG-POLICY-002 | Each `PolicyDecision` records jurisdiction, legal basis, channel, and effective-date version. | Decision retrievable with all four fields for every case. | Missing any field ⇒ case cannot progress past `REQUEST_READY`. |
| VG-POLICY-003 | Public-record, FCRA, and exemption limits are evaluated before action. | Exemption evaluation recorded; exempt outcomes become `NOT_REMOVABLE`. | Exempt fixture must not produce an external write. |
| VG-POLICY-004 | Minor subjects follow a stricter lane. | Minors route to review-required handling. | Minor subject cannot enter an automated write lane. |

### 6.4 Channel and action

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-CHANNEL-001 | Channel selection follows the documented priority order (§8). | Chosen channel plus rejected alternatives with reasons are recorded. | A lower-priority channel cannot be selected while a lawful higher one is available. |
| VG-CHANNEL-002 | Writes require current official permission for that source. | Permission/TOS class and freshness timestamp checked at execution. | Stale or unclear permission ⇒ recipe auto-disables. |
| VG-CHANNEL-003 | `RemovalRecipe` is signed, versioned, and quarantined on staleness. | Signature verified before use; stale recipe cannot write. | Tampered/stale recipe ⇒ execution refused. |
| VG-ACTION-001 | Every external write carries exactly one `IdempotencyKey`. | Duplicate submission with same key yields one external effect. | Replay yields no second letter/form submission. |
| VG-ACTION-002 | Ambiguous results (timeout, no response) reconcile rather than retry blindly. | Reconciliation record created; no duplicate effect. | Simulated timeout must not produce two mail pieces. |
| VG-ACTION-003 | Every external effect is independently read back. | Second connection/provider API confirms the effect (DOD-012). | Primary-only self-report cannot satisfy acceptance. |
| VG-ACTION-004 | Certified-mail pieces preserve template version, hash, and delivery evidence. | Template hash + provider tracking + delivery status stored. | Missing tracking ⇒ case cannot reach `ACKNOWLEDGED` via mail. |
| VG-ACTION-005 | Write effect budgets bound volume per subject, source, and window. | Budget exceeded ⇒ refuse and audit. | Unbounded loop attempt is capped and recorded. |

### 6.5 Verification, reappearance, evidence

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-VERIFY-001 | Verification uses a path independent of the acting path. | Observation records distinct method/identity from the action. | Re-using the actor's own session fails acceptance. |
| VG-VERIFY-002 | Required observation window is met before `VERIFIED_REMOVED`. | Timestamps prove the minimum window elapsed. | Immediate same-second recheck insufficient. |
| VG-VERIFY-003 | Verification is method-specific per recipe and recorded. | Recipe declares its verification method; observation matches. | Mismatched method ⇒ observation invalid. |
| VG-VERIFY-004 | A failed verification does not regress to a success state. | State machine refuses illegal transition; case stays honest. | Controller claiming deletion without observation ⇒ `ACKNOWLEDGED`, not removed. |
| VG-REAPPEAR-001 | Reappearance is detected by scheduled re-observation of removed exposures. | `REAPPEARED` rows link to the prior `VERIFIED_REMOVED` event. | A first-ever discovery is never labelled `REAPPEARED`. |
| VG-REAPPEAR-002 | Reappearance re-enters the case flow with preserved history. | Prior evidence retained; new attempt is a new `ExternalAction`. | History overwrite fails validation. |
| VG-EVIDENCE-001 | Every `EvidenceArtifact` is content-addressed and immutable. | SHA-256 recorded; mutation detected on read. | Altered artifact ⇒ integrity failure raised. |
| VG-EVIDENCE-002 | Every claim links requirement → case → artifact → digest. | Traceability row resolvable to a stored artifact hash. | Dangling evidence path ⇒ claim rejected. |
| VG-EVIDENCE-003 | Audit trail is append-only. | Update/delete on audit store is impossible by construction. | Attempted audit mutation fails. |

### 6.6 Tenancy, privacy, security

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-TENANT-001 | Every row is tenant-scoped and enforced by PostgreSQL RLS. | Cross-tenant query returns zero rows at the database layer. | Cross-tenant read attempt returns nothing, even with a valid token. |
| VG-TENANT-002 | Authorization is enforced in the service layer *and* RLS (defense in depth). | Both layers independently reject the same unauthorized access. | Bypassing one layer still fails the other. |
| VG-EGRESS-001 | Default deny for `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, `AUTH_SECRET`. | Egress attempted without tenant policy ⇒ refused. | Raw identity document cannot reach any model. |
| VG-EGRESS-002 | Telemetry, issues, and PRs pass DLP scrubbing before egress. | Redaction evidence recorded per egress event. | Seeded canary PII must not appear in emitted telemetry. |
| VG-SEC-001 | Untrusted remote content is tainted and cannot direct actions. | Taint propagates; tainted content cannot select a channel or write. | Prompt-injection payload in a fetched page cannot cause a write. |
| VG-SEC-002 | Secrets never enter application databases or logs. | Secret scan on logs/telemetry passes. | Seeded secret never appears in output. |
| VG-SEC-003 | Outbound fetches are restricted (SSRF controls). | Private/link-local targets refused. | `169.254.169.254` fetch refused. |
| VG-SEC-004 | Webhooks are authenticated and replay-protected. | Signature + timestamp/nonce verified. | Replayed webhook is rejected once. |

### 6.7 Operations, honesty, release

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| VG-OPS-001 | Health, readiness, and liveness endpoints reflect real dependency state. | Induced dependency failure flips readiness. | Static `200` while dependencies are down fails acceptance. |
| VG-OBS-001 | Every critical workflow emits correlated logs, metrics, and traces. | Correlation ID traverses discovery → action → verification. | Broken correlation ⇒ observability gate fails. |
| VG-OBS-002 | Removal-effectiveness metric is independently verified removals ÷ eligible confirmed matches, with denominator and interval. | Metric emits numerator, denominator, and confidence interval. | Requests-sent or "permanent deletion" metrics are rejected. |
| VG-REL-001 | The final verdict is machine-produced: `GO`, `NO_GO`, `CONDITIONAL_EXTERNAL_GATES`, or `INCONCLUSIVE`. | Release gate artifact validates against schema. | Free-form completion language fails the gate. |
| VG-REL-002 | All 484 registry IDs receive an individual applicability decision. | Zero unaccounted or duplicated IDs. | A missing ID fails harness validation. |
| VG-REL-003 | A failed prerequisite blocks only declared dependents. | Independent tests continue and record results. | Blanket blocking fails the accounting validator. |
| VG-REL-004 | Candidate epochs are immutable; any change invalidates affected evidence. | Change invalidation graph lists reruns. | Reusing pre-change evidence fails validation. |

## 7. Coverage-honesty rules

1. Never claim universal crawling. Report `sources_attempted` vs `sources_total`
   against a declared catalogue, and name the unchecked remainder.
2. Never claim permanent deletion. The strongest available state is
   `VERIFIED_REMOVED`, scoped to one source and one observation window.
3. Never present a request count as a removal count.
4. Every coverage number carries its denominator; a percentage without a
   denominator is a defect.
5. Uncertainty is reported, not smoothed. `Confidence` is shown with basis.
6. `NOT_REMOVABLE` and `HUMAN_REQUIRED` are first-class results and must not be
   hidden to improve apparent success rate (VG-OBS-002).

## 8. Channel priority model

Selection is policy-driven over **versioned data**. An LLM may recommend; it may
not invent a legal basis or override policy (VG-POLICY-001).

1. Official self-service privacy/opt-out form — only where automation is
   permitted by current source terms.
2. Official privacy/DPO/controller contact.
3. Authorized-agent request with signed authority evidence.
4. Centralized government channel (e.g. California DROP) where the subject is
   eligible.
5. Search-engine personal-information / outdated-content / legal removal —
   tracked as `SEARCH_DELISTED`, never as source deletion.
6. Certified postal mail — where stronger proof or a mail-only process applies.
7. Appeal / escalation / regulator packet — requires human or counsel review.
8. Transparent `NOT_REMOVABLE` / exempt outcome where no lawful path exists.

A lower-priority channel may be chosen only when each higher-priority channel is
recorded as unavailable, unlawful, or gated, with a reason (VG-CHANNEL-001).

## 9. Acceptance oracle rules

These rules govern how any requirement is judged, and they bind the test suite,
the harness, and every human reading a report.

1. A requirement is satisfied only by **executed** evidence from the current
   candidate epoch. Reading a script, recalling a prior run, or reasoning about
   intent is not evidence.
2. Any claim must resolve to: requirement ID → test ID → command → observed
   sentinel/exit code → artifact digest → evidence path (DOD-025, VG-EVIDENCE-002).
3. Mocks may isolate units but may never be the sole proof of an integration or
   production claim (DOD-010).
4. Black-box acceptance uses public interfaces only (DOD-011).
5. Critical proofs use runtime-generated canaries, not fixtures (DOD-013).
6. An unmet condition is reported using the exact taxonomy and is never promoted
   by narrative (DOD-026).
7. Weakening a gate or oracle to obtain a pass is prohibited; the correct action
   is to record the item incomplete (DOD-027).

## 10. Traceability requirements

- Every requirement ID in §6 appears in `REQUIREMENT_TRACEABILITY.csv` and at
  least one row of `FUNCTIONAL_PROOF_MATRIX.csv`.
- Every `LIVE-FIRE-PROOF-*` outcome maps to one or more `VG-*` requirements.
- `CLAIM_TO_RELEASE_TRACEABILITY.csv` must contain a row per claimed capability
  with linked test and evidence. Empty or narrative-only rows are invalid.
- Any change to this file invalidates downstream evidence (VG-REL-004).

## 11. Open items requiring human authority

Recorded honestly; these are **not** satisfiable by an agent:

- Counsel review of CCPA/CPRA, California DROP timelines, other supported
  jurisdictions, authorized-agent evidence rules, public-record exceptions,
  minors, DPA/transfer terms, letter templates, regulator escalation, mail use,
  and product marketing claims (`LEGAL_REVIEW_REQUIRED.md`).
- Named human UAT and assistive-technology validation (DOD-039).
- Cloud/KMS/object-store credentials and provider entitlements (PREFLIGHT.md).
- Production deployment authorization (manual only, VG-SCOPE-009).

Until these are supplied, affected requirements are `EXTERNAL_REQUIRED` or
`BLOCKED_CREDENTIALS`, and the ship verdict cannot exceed
`CONDITIONAL_EXTERNAL_GATES`.
