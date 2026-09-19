# SPEC-007 — Observability, Telemetry Safety, Alerting, and SLOs

Status: SPECIFICATION (normative). Supersedes the 155-byte stub previously at this path.
Depends on: SPEC-000 (product scope, vocabulary lock, truth model), SPEC-001 (core domain,
ports, state machine). **SPEC-000 wins on any conflict**; contradiction is a defect (DOD-027).

Requirement-ID scheme: `VG-OBS-<NNN>` for observability, `VG-SLO-<NNN>` for service-level
objectives. IDs are permanent and never reused, renumbered, or deleted. `VG-OBS-001` and
`VG-OBS-002` are owned by SPEC-000 §6.7 and are **not** restated, superseded, or contradicted
here; this file continues the observability namespace from `VG-OBS-003`. `VG-SLO-001` opens a
new namespace. Every requirement in §12 carries exactly one acceptance oracle and exactly one
required negative case (DOD-001, DOD-008, DOD-014).

**Implementation status of this document: NOT IMPLEMENTED.** Every pipeline, metric, endpoint,
dashboard, SLO evaluator, and alert named here is a *specified* artifact. No part of this file
is evidence that anything is built, wired, or tested, and no result, digest, or measurement is
claimed by this file. Reading this file is not evidence under SPEC-000 §9.1.

---

## 1. Purpose and scope

VanishGraph is a system of record for **evidence about removal attempts**. Telemetry is
therefore part of the evidence surface, not a side channel. This specification binds every
service, worker, worker pod, job, migration, and CLI entry point in the repository, and it
applies equally to production, staging, preview, and local runs — the differences between
those environments are declared in resource attributes, never in whether the rules apply.

Three laws govern everything below.

- **L1 — Truthfulness.** A signal may never assert a state the domain did not reach
  (SPEC-000 §5, SPEC-001 §4.3, DOD-037). Optimistic telemetry is a fabrication defect.
- **L2 — Egress safety.** No telemetry, issue, log, metric, trace, or PR text leaves the trust
  boundary before DLP scrubbing (SPEC-000 VG-EGRESS-002, VG-EGRESS-001). Redaction is proven by
  executed tests, never asserted by prose or by convention.
- **L3 — Identity.** Every signal is bound to a candidate epoch and artifact digest so that
  evidence cannot drift across code (DOD-029, VG-REL-004).

### 1.1 Out of scope for this file

The append-only audit store's schema and retention are governed by SPEC-001 §3.5
(`AuditEvent`) and SPEC-002. The evidence store's content-addressing is governed by
VG-EVIDENCE-001. Customer-facing coverage reporting is governed by SPEC-000 §7. This file
specifies only the operational telemetry plane and its safety, correlation, alerting, and
objective contracts.

---

## 2. Signal architecture

### 2.1 Canonical resource attributes

Every trace span, every log record, and every metric sample must carry the following
resource attributes with non-empty values. These are the **only** canonical telemetry
resource keys; producers must not invent alternatives, aliases, or abbreviations.

| Canonical key | Type | Allowed values / form | Source of truth |
|---|---|---|---|
| `service.name` | string | One of the declared service names in §2.2. Never dynamic, never per-tenant. | Deployment manifest |
| `service.version` | string | Release version of the artifact. | Build output |
| `deployment.environment.name` | string | `local`, `ci`, `preview`, `staging`, `production` | Deployment manifest |
| `vanishgraph.tenant.class` | enum | `INTERNAL`, `TEST`, `PILOT_TENANT`, `PRODUCTION_TENANT`, `EXTERNAL_REQUIRED` | Tenant policy data |
| `vanishgraph.candidate_epoch` | string | The pinned candidate epoch identifier for the running artifact. | `RUN_MANIFEST` (DOD-029) |
| `vanishgraph.artifact.digest` | string | Release artifact digest of the running artifact. | Build/release output (DOD-003, DOD-029) |
| `vanishgraph.build.inputs_digest` | string | Digest over the declared build inputs. | Build output |
| `vanishgraph.policy.version` | string | Jurisdiction-policy version set loaded at runtime. | Versioned policy data (VG-POLICY-001) |
| `vanishgraph.recipe.set_digest` | string | Digest over the loaded signed `RemovalRecipe` set. | Recipe registry (VG-CHANNEL-003) |

Rules:

1. **No telemetry record may be emitted with a missing or empty value for any of the nine
   keys above.** A producer that cannot resolve one of them fails closed: it refuses to emit,
   records the refusal as a local structured error, and increments the telemetry-egress
   failure counter. It must not substitute a placeholder such as `unknown`, `n/a`, `latest`,
   or a zero digest.
2. **Artifact identity propagates.** Any telemetry-derived claim resolves to
   (`vanishgraph.candidate_epoch`, `vanishgraph.artifact.digest`) so that a change in the
   candidate invalidates dependent telemetry evidence exactly as VG-REL-004 requires for every
   other evidence class.
3. `vanishgraph.tenant.class` is an **enum**, never a tenant identifier. Per-tenant
   telemetry is produced by per-tenant recording scopes, not by a tenant label (§6.2).
4. Resource attributes are attached by the telemetry SDK resource configuration, not by
   individual call sites, so that a new call site cannot omit them by accident.

### 2.2 Declared services

`service.name` must be exactly one of: `vanishgraph-api`, `vanishgraph-web`,
`vanishgraph-worker-discovery`, `vanishgraph-worker-action`, `vanishgraph-worker-verify`,
`vanishgraph-scheduler`, `vanishgraph-mcp`. A process that cannot map itself to this list
fails startup rather than emitting unattributed telemetry.

### 2.3 Signal inventory and transport

| Signal | Producer | Transport | Store / backend | Declaration |
|---|---|---|---|---|
| Traces | OTel SDK in every service | OTLP/gRPC to the collector | Trace backend behind the collector | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_EXPORTER=otlp` |
| Logs (structured) | Application logger, JSON lines to stdout | Platform log agent → collector → store | Log store, indexed by `correlationId`, `tenantId`, `severity` | `VANISHGRAPH_LOG_FORMAT=json` |
| Metrics | Prometheus client registry in every service | Scrape of `GET /metrics` | Prometheus-compatible TSDB + recording rules | `VANISHGRAPH_METRICS_PATH=/metrics` |
| Errors | Application error reporter (GlitchTip-compatible) | Scrubbed event POST, DSN from `SecretResolver` | GlitchTip project per environment | `VANISHGRAPH_ERROR_REPORTING_DSN` (secret) |

Rules:

1. Standard output is the only log sink. A service must not open its own file, socket, or
   remote log destination; that would create an unscrubbed egress path.
2. `GET /metrics` is served on the process's metrics listener and is **cluster-internal
   only**. It must be unreachable from the public ingress; exposure is a security defect,
   because raw metric series disclose tenant shape and operational state.
3. Metric samples may carry **exemplars** to join to traces. Exemplars are scrubbed under
   the same DLP rules as every other payload (§4) and must never carry raw identifiers.
4. High-cardinality identifiers (`caseId`, `exposureId`, `actionId`, `evidenceId`,
   `sourceId`, `recipeId`, `ProtectedSubject` references, tenant IDs) belong in **span
   attributes, log fields, or exemplars only**. They must never appear as metric label
   values (§6.2).

---

## 3. Trace model

### 3.1 Span naming and required attributes

Span names use `vanishgraph.<aggregate>.<operation>` with canonical tokens only, e.g.
`vanishgraph.exposure.assess_match`, `vanishgraph.request_case.prepare_request`,
`vanishgraph.external_action.execute`, `vanishgraph.verification_observation.record`.

Every span in a critical workflow carries:

| Attribute | Required | Notes |
|---|---|---|
| `vanishgraph.correlation_id` | always | §5 |
| `vanishgraph.tenant_id` | always | opaque `TenantId` |
| `vanishgraph.case_id` | where a `RequestCase` is in scope | opaque `CaseId` |
| `vanishgraph.exposure_id` | where an `Exposure` is in scope | opaque `ExposureId` |
| `vanishgraph.action_id` | where an `ExternalAction` is in scope | opaque `ActionId` |
| `vanishgraph.truth_state.from` / `vanishgraph.truth_state.to` | on transition spans | exactly one of the eleven tokens, never collapsed |
| `vanishgraph.transition_id` | on transition spans | `T1`…`T21` per SPEC-001 §4.1 |
| `vanishgraph.idempotency_key` | on external-effect spans | never a secret; it is a stable opaque key |
| `vanishgraph.egress.class` | on any egress span | an `EgressClass` member |

**Prohibited span attributes:** any subject name, email address, telephone number, postal
address, page content, raw HTML, cookie value, token, form value, image payload, or
identity-document field. A span attribute whose *name* is not on the telemetry attribute
allowlist is rejected at the SDK processor boundary (§4.3).

### 3.2 Truth-state spans

A truth-state transition emits one span with `vanishgraph.truth_state.from`,
`vanishgraph.truth_state.to`, `vanishgraph.transition_id`, the evidence reference
(`vanishgraph.evidence.id` plus `vanishgraph.evidence.digest`) required by SPEC-001 §4.1, and
`vanishgraph.verification.observation_id` **only** when the destination is
`VERIFIED_REMOVED`. The absence of `vanishgraph.verification.observation_id` on a
`VERIFIED_REMOVED` transition is an alertable condition, not a tolerated gap (§8, A-01).

---

## 4. DLP-safe telemetry (VG-EGRESS-002 — hard requirement)

### 4.1 Mandatory scrubbing stage

A single scrubbing stage sits between every producer and every egress sink:

```
producer → telemetry.record(...) → EgressGate.classify → scrub (deny-by-default) →
  [accepted payload + scrub token] → sink adapter → egress
```

- There are exactly **five** egress sinks: the OTLP trace exporter, the collector-bound log
  forwarder, the GlitchTip error reporter, the PR/issue text exporter (`RepairCapsule`
  egress), and any debug bundle exporter.
- A sink adapter's send function requires an accepted-payload token produced by the scrub
  stage. Reaching a sink without a token is a compile-time/type-level impossibility in
  addition to a runtime refusal.
- The scrub stage is **deny-by-default**: an input that is not explicitly permitted by the
  telemetry allowlist is denied. New field names are denied until they are added to the
  allowlist with an `EgressClass` classification and a test.
- The scrub stage never mutates state in place and never "best-effort cleans". Outcomes are
  exactly: `ALLOWED_OPAQUE`, `REDACTED`, `DENIED`, `FAILED`. `FAILED` behaves as `DENIED`.
- A denial or a failure emits **no payload at all** to the sink, increments
  `vanishgraph_dlp_scrub_outcome_total`, and (for `DENIED`/`FAILED`) increments
  `vanishgraph_dlp_egress_denied_total` and raises an alert (§8, A-06).

### 4.2 Data classes that must never leave

The following classes must never appear in any telemetry, issue text, PR text, debug bundle,
or dashboard payload, in any encoding (plain, base64, URL-encoded, truncated prefix, hashed
with a reversible or guessable scheme, or embedded in an identifier):

| Prohibited class | Examples of prohibited payload | Required representation |
|---|---|---|
| Subject names and aliases | Given/family names, maiden names, usernames | `ProtectedSubject` opaque ID only |
| Email addresses | Any `local@domain` form, including in headers or bodies | `EmailThread` opaque ID or digest |
| Telephone numbers | Any dialable form, including E.164 and formatted | `Identifier` opaque ID |
| Postal addresses | Street, unit, city/postal combinations tied to a person | `LocationHistory` opaque ID, or `Jurisdiction` code when only the jurisdiction is needed |
| Raw HTML | Fetched markup, DOM dumps, inline scripts | `EvidenceArtifact` digest plus a redacted excerpt summary that itself contains no class member |
| Page content | Text bodies, titles containing subject data, PDF text | `EvidenceArtifact` digest plus `contentHash` |
| Cookies and session values | `Set-Cookie`, `Cookie`, session IDs, CSRF values | Never represented; the field does not exist |
| Tokens and secrets | Bearer tokens, API keys, DSNs, private keys, passwords, OTPs | `SecretResolver` reference name only (VG-SEC-002) |
| Identity-document content | Document numbers, scans, images, extracted MRZ text | `IDENTITY_DOCUMENT` class: denied unconditionally, no representation permitted |
| Form values | Any value typed into a third-party form, including the request body | `ExternalAction` opaque ID plus the recipe field identifier |
| Sensitive screenshots | Screenshots containing any class above, browser chrome, or a logged-in session | `EvidenceArtifact` digest; screenshots are never attached to telemetry or issues |
| Free-text operator notes | Notes that quote any class above | Opaque note ID; notes are stored in the case store, not telemetry |

Raw PII is never a primary key, never a log field, and never a metric label
(SPEC-001 §3.5).

### 4.3 `EgressClass` model and default posture

`EgressClass` is the SPEC-001 §2 value object: `NONE`, `OPAQUE_ID`, `CUSTOMER_PII`,
`HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, `AUTH_SECRET`. Its use in this plane:

| `EgressClass` | Telemetry disposition | Rationale |
|---|---|---|
| `NONE` | Permitted: structural data with no data-subject relationship (timings, counts, enum values, byte sizes, error codes). | No privacy surface. |
| `OPAQUE_ID` | Permitted: `TenantId`, `CaseId`, `ExposureId`, `SourceId`, `RecipeId`, `ActionId`, `EvidenceId`, `correlationId`, `trace_id`, `span_id`, `IdempotencyKey`, `EvidenceDigest`. | Non-reversible references; they join to PII inside the tenant-scoped store, not in telemetry. |
| `CUSTOMER_PII` | **Denied by default.** Permitted only with a tenant policy row explicitly allowing that field class for that tenant, a recorded field allowlist entry, and an unconditional deterministic redaction pass that leaves only the opaque reference. | VG-EGRESS-001 default deny. |
| `HIGH_RISK_PII` | **Denied**, no exception for telemetry. | VG-EGRESS-001. |
| `IDENTITY_DOCUMENT` | **Denied unconditionally**, including for model egress and for issues/PRs. | VG-EGRESS-001; VG-SCOPE-003. |
| `AUTH_SECRET` | **Denied unconditionally.** Secret values are never telemetry; only the `SecretResolver` reference *name* may appear. | VG-SEC-002. |

The classification of every emitted field is **data, not code comment**: the telemetry
allowlist is versioned configuration containing `field_path → EgressClass → disposition`, and
it is validated in CI. A field with no entry is `DENIED` at runtime.

### 4.4 Canary proof that redaction works

Redaction is verified by executed tests, never asserted.

1. **Runtime-generated.** The canary generator produces unpredictable values at test time
   from a declared seed, and the run records the seed and a digest over the emitted bundle
   (DOD-013). Static fixtures may exist for unit isolation but may not be the acceptance
   proof.
2. **Realistic shape, safe domain.** Canary values carry the *shape* of each prohibited
   class while remaining non-live: names from a generated token set, addresses using
   reserved example domains (`.invalid`, `.example`), and telephone numbers from the
   reserved fictitious range. No real person's data is used to prove redaction.
3. **Propagation.** Canary values are injected where PII would naturally flow: into the
   `ProtectedSubject` reference chain, an email-thread body fixture, a fetched page body, a
   form submission payload, a screenshot artifact, and a secret-shaped environment value.
   The full discovery → action → verification path runs.
4. **Assertion.** The test exports the *actual* telemetry payloads from all five sinks — the
   OTLP exporter output, the log forwarder output, the error-reporter payload, the
   PR/issue text, and the debug bundle — and asserts that **none** of the canary values
   occur as a substring, as a decoded form, or as a token in any field, attribute, label,
   resource attribute, or exemplar. The assertion operates on exported bytes, not on the
   in-process object graph.
5. **Negative control.** The same test run must also prove it can fail: with exactly one
   redaction rule class disabled, the test must fail and must name the offending rule class
   and field path. A canary test that cannot fail is not a test.
6. **Recording.** Each run produces a redaction-evidence artifact: canary seed, canary
   bundle digest, sink list, exported-payload digest per sink, and the pass/fail verdict.
   This artifact is the redaction evidence referenced by VG-EGRESS-002.

---

## 5. Structured log contract

### 5.1 Format and severity

Logs are single-line JSON objects, one record per line, UTF-8, no embedded newlines, emitted
to stdout. Severity values are an **uppercase closed enum**, in ascending order:

`TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.

- `ERROR` means an operation failed and the failure is visible to a caller or a workflow.
- `FATAL` means the process cannot continue and is terminating; it is not a synonym for a
  serious `ERROR`.
- `WARN` means a degraded-but-correct condition (for example: telemetry sink unreachable
  while the request path is unaffected).
- A log record's severity must correspond to domain reality. Logging `INFO "removal complete"` for a
  case in `ACKNOWLEDGED` is a truthfulness defect (L1), independent of any user-visible
  wording.

### 5.2 Mandatory fields on every record

| Field | Type | Required | Content rule |
|---|---|---|---|
| `timestamp` | string | always | RFC 3339 with millisecond precision and explicit UTC offset, e.g. `2026-02-14T09:31:07.412Z` |
| `severity` | enum | always | §5.1 values |
| `service` | string | always | Equals the `service.name` resource attribute (§2.2) |
| `correlationId` | string | always | §5.3; opaque, stable across the whole case flow |
| `tenantId` | string | always | Opaque `TenantId`; never a tenant name, domain, or billing label |
| `caseId` | string | where a `RequestCase` is in scope | Opaque `CaseId` |
| `exposureId` | string | where an `Exposure` is in scope | Opaque `ExposureId` |
| `actionId` | string | where an `ExternalAction` is in scope | Opaque `ActionId` |
| `event` | string | always | Canonical event name (§5.4) |
| `outcome` | enum | always | `SUCCEEDED`, `REFUSED`, `FAILED`, `AMBIGUOUS`, `GATED` |
| `message` | string | always | Human-readable, content-free template text; must not interpolate any §4.2 class |
| `candidateEpoch` | string | always | Mirrors `vanishgraph.candidate_epoch` |
| `artifactDigest` | string | always | Mirrors `vanishgraph.artifact.digest` |

Conditional-required means: if the field's entity exists anywhere in the current operation's
scope, the field is mandatory. A record that omits a conditional-required field when the
entity is in scope is invalid and is rejected by the log schema validator before the record
leaves the process.

### 5.3 Optional fields that are permitted

`traceId`, `spanId` (OTel identifiers), `traceFlags`, `sourceId`, `recipeId`,
`recipeVersion`, `channel`, `truthStateFrom`, `truthStateTo`, `transitionId`,
`policyVersion`, `jurisdiction`, `evidenceId`, `evidenceDigest`, `idempotencyKey`,
`attempt`, `latencyMs`, `dependencyKey`, `reasonCode`, `gateKind`, `egressClass`,
`redactionRuleClass`, `redactionCount`, `budgetKey`, `costMinorUnits`, `currency`,
`humanMinutes`, `errorType`, `errorCode`, `retryable`.

Every optional field must be on the telemetry allowlist with an `EgressClass`. The following
field **names** are prohibited anywhere in a log record, at any nesting depth:
`name`, `fullName`, `firstName`, `lastName`, `email`, `emailAddress`, `phone`,
`phoneNumber`, `address`, `street`, `postalCode`, `zip`, `ssn`, `dob`, `dateOfBirth`,
`documentNumber`, `idNumber`, `body`, `html`, `content`, `pageContent`, `raw`, `payload`,
`cookie`, `setCookie`, `sessionId`, `token`, `accessToken`, `refreshToken`, `apiKey`,
`password`, `secret`, `otp`, `formValues`, `screenshot`, `imageBase64`, `attachment`.
These names are rejected by the log schema validator and by the telemetry allowlist checker;
the name check is a second line of defence behind the deny-by-default allowlist.

### 5.4 Event names

`event` uses canonical names from SPEC-000 §4 and SPEC-001 §7 (`SourceRecordObserved`,
`MatchConfirmed`, `PolicyResolved`, `RequestReady`, `ActionSubmitted`, `ActionAmbiguous`,
`Acknowledged`, `Refused`, `HumanRequired`, `VerifiedRemoved`, `VerificationFailed`,
`Reappeared`, `NotRemovable`, `SearchDelisted`, `EvidenceStored`, `BudgetExceeded`) plus a
declared operational set (`ReadinessChanged`, `DependencyProbeFailed`, `EgressDenied`,
`EgressScrubbed`, `AlertFired`, `AlertResolved`, `SloBreachDetected`,
`TelemetryIdentityMissing`, `StaleRecipeRefused`, `DuplicateEffectDetected`,
`CrossTenantAccessRefused`). Ad-hoc event strings are rejected.

### 5.5 Opaque-identifier rule

**Logs carry opaque identifiers only.** A log field value must be one of: an opaque ID, a
digest, an enum token, a number, a boolean, a duration, a currency amount, a version string,
a jurisdiction code, or a content-free message template already validated as containing no
§4.2 class member. Raw text that originated outside the trust boundary — fetched page text,
controller reply bodies, email bodies, form values, provider error strings — is **never**
logged verbatim. Controller and provider text is logged as a length, a digest, a classified
`reasonCode`, and an `EvidenceArtifact` reference. This is enforced by three independent
mechanisms: the deny-by-default field allowlist, the prohibited-field-name list, and the
runtime canary test of §4.4.

### 5.6 Example record (illustrative shape, no live values)

```json
{
  "timestamp": "2026-02-14T09:31:07.412Z",
  "severity": "INFO",
  "service": "vanishgraph-worker-verify",
  "event": "VerifiedRemoved",
  "outcome": "SUCCEEDED",
  "correlationId": "corr-7Q2F4M8ZC1",
  "tenantId": "ten-4KQ7",
  "caseId": "case-9F3B21",
  "exposureId": "exp-5T8N40",
  "actionId": "act-2W6Y77",
  "truthStateFrom": "ACKNOWLEDGED",
  "truthStateTo": "VERIFIED_REMOVED",
  "transitionId": "T14",
  "evidenceId": "evd-8H1K52",
  "evidenceDigest": "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0",
  "verificationObservationId": "ver-3P7L19",
  "verificationMethod": "INDEPENDENT_OBSERVER_HTTP",
  "observationWindowSeconds": 1209600,
  "candidateEpoch": "GENERATION",
  "artifactDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "latencyMs": 1841,
  "message": "independent observation completed for exposure"
}
```

---

## 6. Metrics

### 6.1 Namespace, types, and units

All metric names begin with `vanishgraph_`. Names use `lower_snake_case`, end in `_total` for
counters, `_seconds` for durations, `_ratio` for dimensionless ratios, `_bytes` for sizes,
and carry their unit in the metric metadata. Every metric must be registered with: type,
unit, label set, owner service, and a one-line meaning. Unregistered metric names are
rejected by the metrics registration check and fail lint.

Canonical label names: `environment`, `tenant_class`, `truth_state`, `transition_id`,
`channel`, `source_class`, `recipe_id`, `provider`, `outcome`, `severity`, `dependency_key`,
`egress_class`, `rule_class`, `window`. No other label name is permitted without a
specification change.

### 6.2 Label cardinality and privacy rule

**`tenantId` is NOT a permitted metric label.** The prohibited label names are `tenantId`,
`tenant_id`, `tenant`, `caseId`, `case_id`, `exposureId`, `actionId`, `evidenceId`,
`sourceId`, `recipeInstanceId`, `correlationId`, `trace_id`, `subjectId`, and any label whose
value set is not a bounded enum declared in versioned configuration. Reasons:

1. **Cardinality:** tenant count and case count grow without bound; per-tenant or per-case
   series make the TSDB the largest store in the platform and make queries unreliable exactly
   when incidents make them necessary.
2. **Privacy:** a tenant label on a per-source or per-effect series discloses which
   organization is removing what, and when. Tenant identity attached to removal activity is
   itself sensitive commercial and personal context.

**Safe alternative (mandatory):** bounded `tenant_class` on shared series, plus a
**per-tenant recording scope** in the metrics registry for any number a tenant must see about
itself. Per-tenant numbers are surfaced through tenant-scoped read APIs and per-tenant
recording rules evaluated with the tenant scope resolved from the request's authorization
context — never by adding a tenant label to the shared series. Dashboards that must show a
tenant-specific value read from the tenant-scoped view, and the view's data source is
access-controlled under §11.

### 6.3 Effectiveness metric (VG-OBS-002)

The primary effectiveness metric is:

```
independently verified removals ÷ eligible confirmed matches
```

| Metric name | Type | Unit | Labels | Notes |
|---|---|---|---|---|
| `vanishgraph_removal_effectiveness_events_total` | counter | count | `environment`, `tenant_class`, `source_class`, `window`, `component` ∈ {`numerator`, `denominator`, `excluded_not_removable`, `excluded_human_required`} | Raw event counts. The exclusion components are mandatory so exclusions are visible, never silent. |
| `vanishgraph_removal_effectiveness_ratio` | recording rule (gauge) | ratio | same as above minus `component`, plus `ci` ∈ {`point`, `lower`, `upper`} | Wilson score interval at 95% confidence, computed by recording rule from the raw counters. |

Definitions, binding on implementation and on every dashboard:

- **Denominator — eligible confirmed match:** aligned with the SPEC-003 §5.16.3 public
  contract (`denominatorDefinedAs`: "exposures at `MATCH_CONFIRMED` or beyond within the
  interval that were eligible for a lawful channel"): an `Exposure` that reached
  `MATCH_CONFIRMED` or a later state within the measurement interval and for which a complete
  `PolicyDecision` in force exists (jurisdiction, legal basis, channel, policy version —
  VG-POLICY-002) and an enabled fresh signed `RemovalRecipe` exists. The denominator is
  counted once per exposure per measurement interval. The metric plane and the API must use
  this one definition; a second, divergent denominator definition anywhere is a defect.
  Exposures whose truthful path closed as `NOT_REMOVABLE` on an exemption or public-record
  basis are disclosed in the mandatory `excluded_not_removable` / `excluded_human_required`
  components rather than being dropped silently.
- **Numerator — independently verified removal:** an exposure in the denominator that reached
  `VERIFIED_REMOVED` with a linked `VerificationObservation` produced by a path distinct from
  the acting path (VG-VERIFY-001), with the required observation window elapsed (VG-VERIFY-002)
  and the recipe's declared verification method satisfied (VG-VERIFY-003). Each exposure
  contributes at most once per observation window; a removal after `REAPPEARED` is a new
  event in a new window.
- **Emitted together, always:** numerator, denominator, and interval. A ratio without its
  denominator is a defect (SPEC-000 §7.4). If the denominator is zero, the interval is not
  computed and the series is reported as `no_data` with the denominator present; a bare `0%`
  or `100%` must never be rendered.
- **Exclusions are first-class:** `HUMAN_REQUIRED` and `NOT_REMOVABLE` outcomes are counted in
  the `excluded_*` components and are never subtracted into an unlabelled residual
  (SPEC-001 SM-5, SPEC-000 §7.6). The metric-level components are the four enumerated values
  above. The SPEC-003 §5.16.3 API additionally discloses `acknowledged`, `requestSubmitted`,
  `searchDelisted`, and `ambiguous` in `excludedFromNumerator`; those four are **API response
  fields, not metric label values**, and adding them as metric components would require a
  specification change plus a cardinality review.
- **Prohibited metrics.** The following are forbidden in the registry, in dashboards, in
  reports, and in API responses: any metric named or aliased as "requests sent", "requests
  submitted", "submissions", "actions taken", "permanent deletion", "permanently removed",
  "deleted", "deletion rate", or "success rate"; and any removal-named series that lacks a
  verification-observation linkage in its definition. `REQUEST_SUBMITTED` volume may exist
  only as `vanishgraph_truth_state_transitions_total{truth_state="REQUEST_SUBMITTED"}`, which
  is an activity metric and must never be presented as a removal count (SPEC-000 §5.1, §7.3).
  A metric that would assert permanent deletion does not exist, because the strongest
  available state is `VERIFIED_REMOVED` scoped to one `Source` and one observation window.

### 6.4 Truth-state transition counters

| Metric name | Type | Unit | Labels | Note |
|---|---|---|---|---|
| `vanishgraph_truth_state_transitions_total` | counter | count | `environment`, `tenant_class`, `source_class`, `truth_state`, `transition_id`, `has_verification_reference` ∈ {`true`, `false`} | `truth_state` is the **destination** state and must be exactly one of the eleven SPEC-000 §5 tokens. `transition_id` is `T1`…`T21`. `has_verification_reference` is `true` only when the transition carries the linked `VerificationObservation` required by SPEC-001 §4.1; it exists so that a `VERIFIED_REMOVED` transition without an observation is detectable (A-01b) rather than invisible. |
| `vanishgraph_truth_state_current` | gauge | count | `environment`, `tenant_class`, `source_class`, `truth_state` | Current exposures per state. Used for backlog, not for success. |
| `vanishgraph_truth_state_illegal_transition_refused_total` | counter | count | `environment`, `tenant_class`, `transition_id`, `reason_code` | Refusals are a control signal, not noise. |

Rules:

1. **Never collapsed.** No metric, dashboard, report, or API may sum these into a single
   "completed", "done", "successful", or "processed" number. Panels render the eleven states
   as separate series or as an explicit stacked breakdown that always shows every
   non-zero state.
2. `SEARCH_DELISTED` transitions never add to any source-removal numerator, and
   `REQUEST_SUBMITTED` transitions never add to any numerator (SPEC-000 §5.1).
3. Sub-state breakdowns (`truth_state` × `channel`) are permitted only when `channel` is a
   bounded enum from SPEC-000 §8.

### 6.5 Quality, cost, provider, and DLP metrics

| Metric name | Type | Unit | Labels | Meaning |
|---|---|---|---|---|
| `vanishgraph_reappearance_events_total` | counter | count | `environment`, `tenant_class`, `source_class`, `reappearance_window` ∈ {`LE_7D`, `LE_30D`, `LE_90D`, `GT_90D`} | `VERIFIED_REMOVED` → `REAPPEARED` transitions, bucketed by time since removal. |
| `vanishgraph_reappearance_rate_ratio` | recording rule (gauge) | ratio | `environment`, `tenant_class`, `source_class`, `reappearance_window` | Reappearances ÷ verified removals in the window, with the denominator series required alongside. |
| `vanishgraph_verification_lag_seconds` | histogram | seconds | `environment`, `tenant_class`, `source_class`, `channel`, `verification_method` | `ACKNOWLEDGED` → `VerificationObservation` recorded. Buckets: 1 h, 6 h, 24 h, 72 h, 7 d, 14 d, 30 d, 60 d, +Inf. |
| `vanishgraph_false_positive_events_total` | counter | count | `environment`, `tenant_class`, `source_class`, `reason_code` ∈ {`ALIAS_AMBIGUOUS`, `HUMAN_REJECTED`, `CONFIDENCE_BELOW_THRESHOLD`, `DISPROVED_BY_OBSERVATION`, `DUPLICATE_SUBJECT`} | Assessments that were believed a subject match and were later disproved or rejected. |
| `vanishgraph_false_positive_rate_ratio` | recording rule (gauge) | ratio | `environment`, `tenant_class`, `source_class` | False positives ÷ `MATCH_CONFIRMED` transitions in the window, denominator required alongside. |
| `vanishgraph_stale_recipe_refusals_total` | counter | count | `environment`, `source_class`, `recipe_id`, `reason_code` ∈ {`SIGNATURE_INVALID`, `FRESHNESS_EXPIRED`, `PERMISSION_UNCLEAR`, `PERMISSION_STALE`, `DISABLED`} | Stale or unsigned `RemovalRecipe` use refused (VG-CHANNEL-003). |
| `vanishgraph_recipe_freshness_age_seconds` | gauge | seconds | `environment`, `source_class`, `recipe_id` | Age of the loaded recipe set; drives the stale-recipe alert. |
| `vanishgraph_action_ambiguity_events_total` | counter | count | `environment`, `tenant_class`, `channel`, `reason_code` ∈ {`TIMEOUT`, `NO_RESPONSE`, `PARTIAL_RESPONSE`, `TRANSPORT_RESET`, `UNKNOWN_STATUS`} | Ambiguous external results (VG-ACTION-002). |
| `vanishgraph_reconciliation_events_total` | counter | count | `environment`, `tenant_class`, `channel`, `outcome` ∈ {`NO_EFFECT`, `EFFECT_CONFIRMED`, `DUPLICATE_EFFECT_DETECTED`, `UNRESOLVED`} | Reconciliation attempts and their results. `UNRESOLVED` and `DUPLICATE_EFFECT_DETECTED` are alertable. |
| `vanishgraph_reconciliation_lag_seconds` | histogram | seconds | `environment`, `channel` | Ambiguity detected → reconciliation resolved. Buckets: 1 m, 5 m, 15 m, 1 h, 4 h, 24 h, 72 h, +Inf. |
| `vanishgraph_human_minutes_total` | counter | minutes | `environment`, `tenant_class`, `gate_kind`, `channel` | Human time consumed resolving `HumanGate` steps; recorded when the gate is resolved, never estimated per attempt. |
| `vanishgraph_external_action_cost_minor_units_total` | counter | minor currency units | `environment`, `tenant_class`, `channel`, `provider`, `currency` | Real spend for external effects (mail, paid channels), integer minor units only, no floats (SPEC-001 §2 `Money`). |
| `vanishgraph_source_channel_health_status` | gauge | enum (0=UNKNOWN, 1=HEALTHY, 2=DEGRADED, 3=UNAVAILABLE) | `environment`, `source_class`, `channel` | Probe-derived transport health. Never set by optimistic defaults. |
| `vanishgraph_provider_auth_failures_total` | counter | count | `environment`, `provider`, `auth_mode`, `reason_code` ∈ {`CREDENTIAL_REJECTED`, `TOKEN_EXPIRED`, `PERMISSION_DENIED`, `MFA_REQUIRED`, `UNKNOWN`} | Auth failures at a provider transport (ADR-004 official transports only). |
| `vanishgraph_source_ratelimit_saturation_ratio` | gauge | ratio | `environment`, `source_class`, `channel` | Observed request rate ÷ configured per-source limit, from versioned rate-limit data (VG-DISC-003). Values ≥ 1.0 mean refusal-by-policy was required. |
| `vanishgraph_source_ratelimit_refusals_total` | counter | count | `environment`, `source_class`, `channel`, `reason_code` ∈ {`CLIENT_LIMIT`, `GOVERNOR_LIMIT`, `PROVIDER_429`} | Client-side refusals are the intended behaviour and are counted separately from provider-side throttling. |
| `vanishgraph_action_budget_consumption_ratio` | gauge | ratio | `environment`, `tenant_class`, `budget_key` ∈ {`SUBJECT`, `SOURCE`, `WINDOW`} | Consumed ÷ allowed effect budget (VG-ACTION-005). |
| `vanishgraph_action_budget_refusals_total` | counter | count | `environment`, `tenant_class`, `budget_key`, `reason_code` ∈ {`SUBJECT_CAP`, `SOURCE_CAP`, `WINDOW_CAP`, `BUDGET_EXHAUSTED`} | Refusals to write because a budget was exhausted. The external effect did not happen. |
| `vanishgraph_dlp_scrub_outcome_total` | counter | count | `environment`, `sink` ∈ {`TRACE`, `LOG`, `ERROR_REPORT`, `PR_ISSUE`, `DEBUG_BUNDLE`}, `outcome` ∈ {`ALLOWED_OPAQUE`, `REDACTED`, `DENIED`, `FAILED`} | Every scrub decision. `DENIED` and `FAILED` must both be alertable. |
| `vanishgraph_dlp_redactions_total` | counter | count | `environment`, `egress_class`, `rule_class` | Redactions applied, classified by `EgressClass`. Never carries the redacted value or its hash. |
| `vanishgraph_dlp_egress_denied_total` | counter | count | `environment`, `sink`, `egress_class`, `reason_code` ∈ {`NOT_ALLOWLISTED`, `PROHIBITED_CLASS`, `PROHIBITED_FIELD_NAME`, `POLICY_ABSENT`, `SCRUB_FAILED`, `CANARY_DETECTED`} | Denied egress events. `IDENTITY_DOCUMENT` and `AUTH_SECRET` denials are security-relevant. |
| `vanishgraph_dlp_canary_detections_total` | counter | count | `environment`, `sink`, `rule_class` | Non-zero is a critical defect: a canary reached a sink. |
| `vanishgraph_telemetry_egress_failures_total` | counter | count | `environment`, `sink`, `reason_code` ∈ {`COLLECTOR_UNREACHABLE`, `DSN_MISSING`, `RESOURCE_ATTR_MISSING`, `SCRUB_FAILED`, `SCHEMA_INVALID`} | Dropped telemetry. Dropping is honest; fabricating a substitute record is not. |
| `vanishgraph_readiness_status` | gauge | enum (0=NOT_READY, 1=READY) | `environment`, `dependency_key` | One series per declared dependency plus an overall series. |
| `vanishgraph_dependency_probe_duration_seconds` | histogram | seconds | `environment`, `dependency_key` | Probe latency; used for probe-timeout diagnosis. |
| `vanishgraph_dependency_probe_failures_total` | counter | count | `environment`, `dependency_key`, `reason_code` ∈ {`TIMEOUT`, `CONNECT_REFUSED`, `AUTH_FAILED`, `DNS_FAILED`, `TLS_FAILED`, `HTTP_5XX`, `MISCONFIGURED`, `UNKNOWN`} | Failures by cause so on-call can act. |
| `vanishgraph_readiness_state_changes_total` | counter | count | `environment`, `service`, `direction` ∈ {`TO_READY`, `TO_NOT_READY`} | Drives the readiness-flapping alert. |
| `vanishgraph_workflow_lag_seconds` | histogram | seconds | `environment`, `workflow_name`, `state` | Time cases spend in a state before the next transition. Sub-second buckets up to 30 d. |
| `vanishgraph_duplicate_external_effect_events_total` | counter | count | `environment`, `channel`, `detection_path` ∈ {`IDEMPOTENCY_STORE`, `PROVIDER_READBACK`, `INDEPENDENT_OBSERVATION`} | Non-zero means a second external effect occurred for one `IdempotencyKey` (VG-ACTION-001). |
| `vanishgraph_tenant_scope_refusals_total` | counter | count | `environment`, `layer` ∈ {`SERVICE_AUTHORIZATION`, `POSTGRES_RLS`, `EVIDENCE_READBACK`}, `reason_code` | Cross-tenant access refusals (VG-TENANT-002). |
| `vanishgraph_verification_observations_recorded_total` | counter | count | `environment`, `tenant_class`, `source_class`, `verification_method`, `path_distinct` ∈ {`true`, `false`} | `VerificationObservation` records written. `path_distinct="false"` means the observation used the acting path and is a violation, not an observation (VG-VERIFY-001). |
| `vanishgraph_telemetry_deletions_total` | counter | count | `environment`, `data_class` ∈ {`TRACE`, `LOG`, `METRIC`, `EXEMPLAR`, `ERROR_REPORT`, `ALERT_HISTORY`, `DEBUG_BUNDLE`}, `outcome` ∈ {`PARTITION_DROPPED`, `REFUSED_SEALED_REWRITE`, `FAILED`} | Retention/deletion job outcomes (§11.2). Deletion is never silent. |
| `vanishgraph_slo_verdict` | gauge | enum (0=INCONCLUSIVE, 1=PASS, 2=FAIL) | `environment`, `objective`, `window` | One series per objective in §9. An absent series is `INCONCLUSIVE` and is alertable (A-15). |
| `vanishgraph_slo_bad_events_total` | counter | count | `environment`, `objective`, `window` | Observed bad events in the window. |
| `vanishgraph_slo_allowed_bad_events` | gauge | count | `environment`, `objective`, `window` | `1 − objective` expressed as allowed bad events; the error budget. |
| `vanishgraph_slo_error_budget_burn_ratio` | gauge | ratio | `environment`, `objective`, `window` | `bad_events_observed ÷ bad_events_allowed`. Consumed by A-14. |
| `vanishgraph_server_http_served_total` | counter | count | `environment`, `service`, `route`, `method`, `status_class` ∈ {`2XX`, `3XX`, `4XX`, `5XX`}, `outcome` ∈ {`SUCCEEDED`, `REFUSED`, `FAILED`} | Inbound HTTP responses served by the API and web roles, excluding readiness and liveness probe traffic. This is an infrastructure metric about HTTP serving only; it is **not** an `ExternalAction` metric and must never be presented as external-effect volume. `route` must be the declared route template, never a resolved path containing an identifier. |

Every metric referenced by an alert expression in §8 or an SLO indicator in §9 must be
registered here or in §6.3–§6.4; an alert or SLO referring to an unregistered metric fails the
definition validator (`OBS-ALERT-NEG-001`, `VG-OBS-016`).

### 6.6 Metric derivation rule

Every metric in §6.3–§6.5 is derived from **domain events or probe results**, never from UI
actions, page views, or optimistic intent. If the domain event did not occur, the counter
does not increment. Telemetry is downstream of truth, never upstream of it.

---

## 7. Health, readiness, and liveness

### 7.1 Endpoints

| Endpoint | Method | Purpose | Must not do |
|---|---|---|---|
| `GET /v1/live` | GET | Liveness only: the process is running, the event loop is responsive, and the HTTP listener accepts connections. No dependency I/O. | Must not touch the database, Valkey, the object store, Keycloak, or any provider transport; must not authenticate; must not be blocked by a dependency outage. |
| `GET /v1/ready` | GET | Readiness: this instance may receive traffic and workflow tasks, because every **required** dependency for its role is usable right now. | Must not return `200` from a static handler, a cached value, or a startup-time snapshot. |
| `GET /v1/health` | GET | Aggregate dependency-health classification for operators and for the readiness probe's own reporting. | Must not be confused with a truth state: the field is `dependencyState`, never `status` (SPEC-003 §5.17.1). |
| `GET /v1/startup` | GET | Startup: initialization (migration-applied check, configuration resolution, secret resolution, resource attributes resolved) has completed. Added by this specification; SPEC-003 §5.17 does not define a startup route. | Must not report started before resource attributes and configuration resolve, because that would emit unattributed telemetry. |
| `GET /metrics` | GET | Prometheus exposition. Cluster-internal only (§2.3); not part of the public `/v1` surface. | Must not be exposed through public ingress. |

Path ownership: SPEC-003 §5.17 owns the three public health routes and this file adopts its
paths and response vocabulary verbatim to avoid a conflict. `GET /v1/startup` is introduced by
this specification because startup completion is a distinct condition (resource attributes and
secret resolution) that neither readiness nor liveness reports. `GET /metrics` is deliberately
outside `/v1` because it is not a public API route (SPEC-003 §5.17 note: only the three health
routes may be unauthenticated).

Response shape for `GET /v1/ready` (HTTP `200` when ready, `503` when not ready), combining the
SPEC-003 `dependencyState`/`failedChecks` vocabulary with the per-check completeness this
specification requires:

```json
{
  "dependencyState": "NOT_READY",
  "service": "vanishgraph-api",
  "checkedAt": "2026-02-14T09:31:07.412Z",
  "candidateEpoch": "GENERATION",
  "artifactDigest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "failedChecks": [
    { "name": "job-worker", "reason": "STALE_HEARTBEAT" }
  ],
  "checks": [
    { "name": "postgresql", "required": true,  "status": "PASS", "latencyMs": 4,   "reasonCode": null },
    { "name": "valkey",     "required": true,  "status": "PASS", "latencyMs": 2,   "reasonCode": null },
    { "name": "job-worker", "required": false, "status": "FAIL", "latencyMs": 200, "reasonCode": "STALE_HEARTBEAT" },
    { "name": "object-store", "required": true, "status": "PASS", "latencyMs": 61, "reasonCode": null },
    { "name": "keycloak-jwks", "required": true, "status": "PASS", "latencyMs": 22, "reasonCode": null },
    { "name": "provider-transport", "required": false, "status": "SKIPPED", "latencyMs": 0, "reasonCode": "NOT_REQUIRED_FOR_ROLE" }
  ]
}
```

### 7.2 Dependency semantics

Two service roles exist. The required dependency set is declared in versioned configuration
and must match this table.

| Dependency (`dependency_key` / check `name`) | Probe performed | Timeout | Required for `web` role | Required for `worker` role |
|---|---|---|---|---|
| `postgresql` | Pooled connection: `BEGIN; SELECT 1; ROLLBACK`, plus verification that the session role is the tenant-scoped application role (proves RLS is in force, VG-TENANT-001/002). | 300 ms | yes | yes |
| `valkey` | `PING`, then write/read/delete under a namespaced probe key. | 200 ms | yes | yes |
| `job-worker` | Queue heartbeat freshness: at least one worker heartbeat inside the declared freshness window, read from the Postgres-backed queue. Optional by design so a stalled worker fleet is visible without taking the web tier down, but always reported (rule 1). | 200 ms | no | no |
| `object-store` | `HeadBucket` plus a signed `GetObject` of a probe key that must return the expected digest. | 400 ms | yes | yes |
| `keycloak-jwks` | OIDC discovery document fetch and JWKS retrieval over TLS; no token is minted by the probe. | 300 ms | yes | no |
| `provider-transport` | Transport-level reachability for each declared official provider transport, using a read-only or no-op path. **Never a form write** (VG-DISC-001). | 1000 ms each | no | yes |

Dependency names are the SPEC-003 §5.17 vocabulary (`postgresql`, `valkey`,
`object-store`, `keycloak-jwks`) so that the readiness body is identical across both
specifications. `provider-transport` is added here because SPEC-003 §5.17 enumerates only the
shared datastore/identity dependencies and the worker role additionally requires its official
transports; `job-worker` is added because ADR-016 moved durable execution into PostgreSQL, so
queue availability is already covered by the `postgresql` probe while worker liveness is not.

Rules:

1. `required: true` means a failing, timing-out, or unknown check result forces overall
   `NOT_READY`. `required: false` dependencies report their status but do not block readiness;
   their failing status must still be visible in `checks` and in metrics, so that "not
   required" never becomes "not observed".
2. Probe timeouts are hard bounds. A probe that exceeds its timeout is `FAIL` with
   `reasonCode: "TIMEOUT"`. Retries inside a readiness probe are at most one, and a retry
   must not extend the total readiness budget of 1 500 ms.
3. Every check must be **discriminating**: with the dependency healthy it passes, and with the
   dependency unavailable it fails, for the same code path. A probe that cannot fail is a
   defect.
4. A readiness response must name every declared dependency. Omitting a dependency from the
   response is a defect, because an omitted dependency is indistinguishable from a healthy one.

### 7.3 Fail-closed behaviour

- Any `FAIL`, `TIMEOUT`, or `UNKNOWN` on a required dependency makes `/v1/ready` return `503`
  on the **first** failing evaluation. There is no grace period during which traffic continues
  after a required dependency is known to be down.
- The instance is removed from the ready set within one probe interval (5 s) and, in the same
  window, stops accepting new requests (web role) and stops polling new workflow tasks
  (worker role). In-flight units are allowed to finish or to be handed back to the queue, and
  must not be left in an ambiguous state.
- Liveness is deliberately independent: a dependency outage must **not** fail `/v1/live` and
  must not cause a restart loop. Restarting a healthy process because a database is down
  converts a dependency incident into an availability incident.
- Readiness flapping is damped only in the **alerting** direction (a state change must persist
  across two consecutive probe intervals before the flap counter advances). The readiness
  *decision* is never damped.
- When an instance is unready, the reason is recorded as a structured log record with
  `event: "ReadinessChanged"`, `severity: "ERROR"`, the failing `dependencyKey`, and the
  `reasonCode`. Failures are never silent and never reported as `INFO`.

### 7.4 Induced-failure test (VG-OPS-001 proof)

The acceptance proof for this section injects real failures and observes real signals. The
procedure, executed per dependency:

1. Confirm the steady state: `/v1/ready` returns `200`, the check named `<key>` is `PASS`, and
   `vanishgraph_readiness_status{dependency_key="<key>"} == 1`.
2. Induce exactly one failure: stop the PostgreSQL container (`postgresql`);
   `valkey-cli SHUTDOWN NOSAVE` (`valkey`); withhold worker heartbeats so the `job-worker` freshness window lapses (`job-worker`); revoke the probe credential or remove the probe object
   (`object-store`); stop the Keycloak frontend so discovery/JWKS fetch fails
   (`keycloak-jwks`); force the provider transport
   to return an auth rejection (`provider-transport`).
3. Within 10 s assert: `/v1/ready` returns `503`; the response names the induced
   dependency in both `failedChecks` and `checks` with a non-null `reasonCode`;
   `vanishgraph_readiness_status` for that key
   is `0`; `vanishgraph_dependency_probe_failures_total` increments for that key;
   `vanishgraph_readiness_state_changes_total{direction="TO_NOT_READY"}` increments; a
   `ReadinessChanged` log record at `severity: "ERROR"` exists carrying the failing
   dependency name and `reasonCode` on that record.
4. Assert `/v1/live` still returns `200` for the same instance, proving liveness does not
   entangle dependency state.
5. Assert the traffic surface actually changed: the instance accepts no new work while
   unready (observed by `vanishgraph_server_http_served_total` for that instance and by
   workflow-task polling counters not advancing).
6. Remediate, then assert readiness returns to `200` within 30 s and the metrics return to
   their steady state.

The required negative case is the same procedure with a **static** readiness handler: a
handler that always returns `200` must fail step 3, which is what proves the acceptance test
discriminates.

---

## 8. Alerting

Every alert is defined as versioned data with: name, exact expression, threshold,
`for` duration, severity, routing lane, and a runbook link; and is proven by executing an
induced condition, observing the alert fire with correct labels, and observing it resolve
after remediation. Expressions below are PromQL-style over the metric names of §6. Recording
rules referenced by name are part of this specification and must exist.

Routing lanes: `page` → on-call paging with a 5-minute acknowledgement objective;
`page-security` → security on-call; `ticket` → operations queue with a 1-business-day review;
`advisory` → business-hours channel with a 4-hour working response objective.
Runbooks live under `docs/runbooks/` with the file names given below.

| ID | Alert | Condition (exact) | Threshold | Severity | For | Routing | Runbook |
|---|---|---|---|---|---|---|---|
| A-01 | Removal claim without verification | `sum by (source_class) (increase(vanishgraph_truth_state_transitions_total{truth_state="VERIFIED_REMOVED"}[10m])) > sum by (source_class) (increase(vanishgraph_verification_observations_recorded_total[10m]))` | any positive delta | critical | 0m | page | `docs/runbooks/alerts/removal-claim-without-verification.md` |
| A-01b | `VERIFIED_REMOVED` record lacking an observation reference | `sum(increase(vanishgraph_truth_state_transitions_total{truth_state="VERIFIED_REMOVED",has_verification_reference="false"}[5m]))` | `> 0` | critical | 0m | page | same as A-01 |
| A-02 | Verification-lag breach | `histogram_quantile(0.95, sum by (le) (rate(vanishgraph_verification_lag_seconds_bucket[6h]))) > 1209600` | 14 d p95 | warning | 1h | ticket | `docs/runbooks/alerts/verification-lag-breach.md` |
| A-03 | Reappearance spike | `sum by (source_class) (rate(vanishgraph_reappearance_events_total{reappearance_window="LE_30D"}[1h])) > 3 * (sum by (source_class) (rate(vanishgraph_reappearance_events_total{reappearance_window="LE_30D"}[7d] offset 1d)) > 0 or vector(0.001))` | 3× 7-day baseline | warning | 30m | ticket | `docs/runbooks/alerts/reappearance-spike.md` |
| A-04 | Stale-recipe execution attempt | `sum by (source_class, reason_code) (increase(vanishgraph_stale_recipe_refusals_total[5m]))` | `> 0` | critical | 0m | page | `docs/runbooks/alerts/stale-recipe-execution-attempt.md` |
| A-05 | Cross-tenant access attempt | `sum by (layer) (increase(vanishgraph_tenant_scope_refusals_total[5m]))` | `> 0` | critical | 0m | page-security | `docs/runbooks/alerts/cross-tenant-access-attempt.md` |
| A-06 | DLP egress denial | `sum by (sink) (increase(vanishgraph_dlp_egress_denied_total[10m]))` | `> 5` | warning | 10m | ticket | `docs/runbooks/alerts/dlp-egress-denial.md` |
| A-06b | DLP denial of a prohibited class | `sum by (egress_class) (increase(vanishgraph_dlp_egress_denied_total{egress_class=~"IDENTITY_DOCUMENT\|AUTH_SECRET"}[5m]))` | `> 0` | critical | 0m | page-security | same as A-06 |
| A-06c | Canary reached a sink | `sum by (sink) (increase(vanishgraph_dlp_canary_detections_total[5m]))` | `> 0` | critical | 0m | page-security | `docs/runbooks/alerts/dlp-canary-detection.md` |
| A-07 | Budget exhaustion | `max by (tenant_class, budget_key) (vanishgraph_action_budget_consumption_ratio) > 0.8` | 80 % of allowed effects | warning | 15m | ticket | `docs/runbooks/alerts/budget-exhaustion.md` |
| A-07b | Budget exhausted | `sum by (budget_key) (increase(vanishgraph_action_budget_refusals_total{reason_code="BUDGET_EXHAUSTED"}[15m]))` | `> 0` | critical | 0m | page | same as A-07 |
| A-08 | Duplicate external effect detected | `sum by (channel, detection_path) (increase(vanishgraph_duplicate_external_effect_events_total[30m]))` | `> 0` | critical | 0m | page | `docs/runbooks/alerts/duplicate-external-effect.md` |
| A-09 | Provider auth failure | `sum by (provider) (increase(vanishgraph_provider_auth_failures_total[10m]))` | `> 2` | warning | 10m | ticket | `docs/runbooks/alerts/provider-auth-failure.md` |
| A-09b | Provider auth failure sustained | `sum by (provider) (increase(vanishgraph_provider_auth_failures_total[30m]))` | `> 5` | critical | 0m | page | same as A-09 |
| A-10 | Readiness flapping | `sum by (service) (increase(vanishgraph_readiness_state_changes_total[15m]))` | `> 6` in 15 m | warning | 5m | advisory | `docs/runbooks/alerts/readiness-flapping.md` |
| A-11 | Telemetry identity missing | `sum by (sink, reason_code) (increase(vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}[10m]))` | `> 0` | warning | 5m | ticket | `docs/runbooks/alerts/telemetry-identity-missing.md` |
| A-12 | Unresolved reconciliation | `sum by (channel) (increase(vanishgraph_reconciliation_events_total{outcome="UNRESOLVED"}[1h]))` | `> 0` | warning | 15m | ticket | `docs/runbooks/alerts/reconciliation-unresolved.md` |
| A-13 | Independence violation observed | `sum by (source_class) (increase(vanishgraph_verification_observations_recorded_total{path_distinct="false"}[15m]))` | `> 0` | critical | 0m | page | `docs/runbooks/alerts/verification-independence-violation.md` |
| A-14 | SLO error-budget burn | `vanishgraph_slo_error_budget_burn_ratio{objective="availability"} > 2` | 2× budget rate | warning | 30m | ticket | `docs/runbooks/alerts/slo-budget-burn.md` |
| A-15 | Alert pipeline cannot evaluate | `absent(vanishgraph_truth_state_transitions_total{truth_state="VERIFIED_REMOVED"}) or absent(vanishgraph_readiness_status)` | absent series | critical | 10m | page | `docs/runbooks/alerts/alert-pipeline-blind.md` |

Coverage and honesty rules for this table:

1. The required critical set is exactly: A-01 (removal claim without verification), A-02
   (verification-lag breach), A-03 (reappearance spike), A-04 (stale-recipe execution
   attempt), A-05 (cross-tenant access attempt), A-06 (DLP egress denial), A-07 (budget
   exhaustion), A-08 (duplicate external effect), A-09 (provider auth failure), A-10
   (readiness flapping).
2. **Alerts describe real system state, never optimism.** No alert may fire on a threshold
   that can only be met when things are going well; no alert may be phrased, labelled, or
   annotated as a success notification; and no alert may be suppressed because its subject
   state is inconvenient. A "removal claim without verification" alert does not mean removal
   is happening — it means an unverified claim is in the data, and the runbook treats it as a
   truthfulness defect.
3. A-15 exists because a silent alert pipeline is indistinguishable from a healthy system, and
   "no alerts" must never be read as "no problems".
4. Every alert must have a runbook that states: the meaning of the condition in domain terms,
   the diagnostic queries, the containment action, the remediation, and the resolution
   criteria. A runbook that only restates the expression is incomplete.
5. Alerts are validated in a test environment by inducing the condition (seeded duplicate
   effect, forced stale recipe, simulated RLS refusal, throttled provider auth, killed
   dependency for readiness flapping) and observing the alert fire and resolve. An alert that
   has never fired under an induced condition is unverified.

---

## 9. SLOs and error budgets (DOD-022)

An SLO below is not a wish; it is an **automated pass/fail threshold** against a declared
workload in a declared environment, evaluated by a machine that emits a verdict. Verdicts are
`PASS`, `FAIL`, or `INCONCLUSIVE`; a missing sample is `INCONCLUSIVE`, never `PASS`.

Common measurement contract for every SLO:

The five objectives below are defined once each: the table in this section carries each
objective's indicator and threshold, and §12.7 carries the same ID's acceptance oracle and
required negative case. They are one requirement per ID, not two.

- **Environment:** the staging environment at the pinned `vanishgraph.candidate_epoch` and
  `vanishgraph.artifact.digest`, provisioned from the declared environment manifest with
  production-type dependencies (PostgreSQL, Valkey, object store, Keycloak). Local
  and CI environments may run the harness but may not produce an SLO verdict.
- **Workload model `WL-1`:** a synthetic census of `T` tenants (default 10) × `S` subjects per
  tenant (default 25) × the declared source catalogue subset, executed by the standard
  scheduler at a steady arrival rate with a declared duration and a declared ramp. The
  workload model is versioned data, and any change to it invalidates prior SLO verdicts
  (VG-REL-004).
- **Sample source:** metrics of §6 only, read from the pinned epoch's series. Synthetic
  dashboard arithmetic is not a sample.
- **Verdict rule:** for each SLO, evaluate over the measurement window; `PASS` only when the
  threshold is met with the required denominator present; otherwise `FAIL`; `INCONCLUSIVE`
  when the denominator is absent or the sample window is incomplete.
- **Error budget:** `1 − objective` over the window, expressed as allowed bad events. Burn is
  `bad_events_observed ÷ bad_events_allowed`. A `FAIL` on a mandatory SLO is `NO_GO` for the
  release gate (DOD-022, VG-REL-001); it is never promoted by narrative.

| ID | Objective | Indicator (exact metric expression) | Threshold | Window | Workload | Verdict rule |
|---|---|---|---|---|---|---|
| `VG-SLO-001` | Availability of the public API | `sum(rate(vanishgraph_server_http_served_total{outcome!="FAILED"}[5m])) / sum(rate(vanishgraph_server_http_served_total[5m]))` | ≥ 0.999 | rolling 30 d, 5 m resolution | `WL-1` steady state plus the declared readiness probe traffic | PASS if the ratio ≥ 0.999 with a non-zero denominator for every 5 m window; FAIL if the 30 d ratio < 0.999; INCONCLUSIVE if any 5 m window lacks a denominator. Readiness-probe traffic is excluded from both terms and is measured separately so that an unready instance cannot be scored as a success. |
| `VG-SLO-002` | Verification latency | `histogram_quantile(0.95, sum by (le) (rate(vanishgraph_verification_lag_seconds_bucket[30d])))` | ≤ 1 209 600 s (14 d) at p95, and ≤ 2 592 000 s (30 d) at p99 | rolling 30 d | `WL-1` removals that reach `ACKNOWLEDGED` | PASS if p95 ≤ 14 d and p99 ≤ 30 d with ≥ 30 completed `ACKNOWLEDGED`→`VerificationObservation` observations in the window; FAIL if either percentile is exceeded; INCONCLUSIVE if fewer than 30 observations. Cases still inside their observation window are censored, not counted as breaches and not counted as passes. |
| `VG-SLO-003` | Workflow completion | `sum(rate(vanishgraph_truth_state_transitions_total{truth_state=~"VERIFIED_REMOVED\|SEARCH_DELISTED\|VERIFIED_NOT_PRESENT\|NOT_REMOVABLE\|HUMAN_REQUIRED"}[30d])) / sum(rate(vanishgraph_truth_state_transitions_total{truth_state="REQUEST_READY"}[30d]))` | ≥ 0.95 | rolling 30 d | `WL-1` | PASS if ≥ 0.95 and all five destination states are individually non-suppressed (each destination series is present with its own count, and `NOT_REMOVABLE`/`HUMAN_REQUIRED` counts are reported, not zeroed); FAIL if the ratio < 0.95 **or** if any destination state's series is absent while the ratio passes; INCONCLUSIVE if the denominator is zero. |
| `VG-SLO-004` | Reconciliation time | `histogram_quantile(0.90, sum by (le) (rate(vanishgraph_reconciliation_lag_seconds_bucket[30d])))` | ≤ 14 400 s (4 h) at p90, and `max` observed ≤ 86 400 s (24 h) | rolling 30 d | `WL-1` plus the induced-ambiguity fault set | PASS if p90 ≤ 4 h and no single reconciliation exceeds 24 h; FAIL otherwise; INCONCLUSIVE if the window contains no ambiguity event, because an untested path is not a passing path (DOD-014). |
| `VG-SLO-005` | SLO evaluation integrity | Not a user-facing objective; a meta-objective over the evaluator itself | 100 % agreement between induced condition and verdict | per evaluation run | `WL-1` plus the induced-breach matrix | PASS only if, for every SLO above, a deliberately induced breach produces `FAIL` and an undisturbed run produces `PASS`; a run where an induced breach produced `PASS` is `FAIL` for `VG-SLO-005` and invalidates the other four verdicts. |

Additional binding rules:

1. **Error-budget accounting is automated.** The evaluator emits, per objective:
   `vanishgraph_slo_error_budget_burn_ratio{objective}`,
   `vanishgraph_slo_bad_events_total{objective}`,
   `vanishgraph_slo_allowed_bad_events{objective}`, and
   `vanishgraph_slo_verdict{objective, verdict}`. A verdict series that is absent is
   `INCONCLUSIVE` and is itself alertable through A-15.
2. **No threshold weakening.** Changing an objective, window, workload model, or fraction to
   obtain a pass is prohibited (DOD-027). Changes require a specification change, a recorded
   rationale, and rerun of every affected verdict.
3. **Cost and human-time objectives** are expressed with the same machinery once a workload
   baseline exists; the metrics are `vanishgraph_external_action_cost_minor_units_total` and
   `vanishgraph_human_minutes_total`. Until a baseline is recorded, any budget statement is
   `INCONCLUSIVE`, never `PASS`.
4. **Long-running obligations are labelled.** Soak, endurance, and stress runs that cannot
   complete inside the campaign window are recorded as `DEFERRED_LONG_RUNNING`, never as
   `PASS` (DOD-038).

---

## 10. Truthfulness rules (DOD-037)

1. **No unreached success state.** Telemetry must not report a success state the domain did
   not reach. Concretely: no `outcome: "SUCCEEDED"` on a truth-state transition that was
   refused; no `VERIFIED_REMOVED` counter increment without a linked
   `VerificationObservation` (VG-VERIFY-001); no `SEARCH_DELISTED` count presented as source
   deletion; no `REQUEST_SUBMITTED` or `ACKNOWLEDGED` count presented as removal
   (SPEC-000 §5.1, §7.3). "Software that appears to work is a failure state": a green signal
   that is not backed by domain state is a defect, not a result.
2. **Induced failures must be visible.** Every induced-failure test in this specification
   (dependency failure, provider auth failure, stale recipe, duplicate effect, cross-tenant
   refusal, DLP denial, canary detection) must produce a signal in telemetry *and* a fired
   alert where §8 defines one. A failure that is invisible in telemetry fails DOD-037
   regardless of how the product behaved.
3. **No suppression of honest outcomes.** `HUMAN_REQUIRED` and `NOT_REMOVABLE` must never be
   hidden, filtered, sampled away, downgraded in severity, or excluded from a denominator in
   order to improve an apparent success rate (SPEC-001 SM-5, SPEC-000 §7.6, VG-OBS-002). A
   dashboard filter, API parameter, saved query, or report template that omits them is a
   defect and fails the observability gate. Sampling must never drop `ERROR`, `FATAL`, or
   truth-state transition records.
4. **No aggregation of distinct truth states.** Dashboards and reports must not sum distinct
   truth states into one "completed", "done", "processed", "handled", or "successful" number,
   and must not present `SEARCH_DELISTED`, `ACKNOWLEDGED`, or `REQUEST_SUBMITTED` inside a
   removal total. Where a single visual is required, it must be an explicit stacked breakdown
   that shows every non-zero state and its own count, with `NOT_REMOVABLE` and
   `HUMAN_REQUIRED` always visible.
5. **No optimistic fallback.** When a signal cannot be produced (missing resource attribute,
   failed scrub, unreachable sink, schema rejection), the system records the failure and
   drops the record. It must not synthesise a substitute record, default a count to zero, or
   mark a pipeline healthy because no record arrived.
6. **Uncertainty is reported.** `Confidence` appears with its basis and intervals appear with
   their denominators (SPEC-000 §7.4–7.5). A percentage without a denominator is a defect in
   telemetry exactly as it is in product copy.
7. **No fabricated evidence.** No dashboard, report, runbook, or commit message may describe
   a metric, alert, or pipeline that is not implemented, and none may present a specification
   as a measurement (SPEC-000 §9.1). This document describes intended behaviour only.

---

## 11. Retention, deletion, and access control

Observability data is **not** a PII back door and **is itself** subject to deletion and
retention policy. Retention windows below are versioned configuration per environment; a
missing window is a deploy-gate failure and never defaults to "infinite".

### 11.1 Retention windows

| Data class | Store | Hot retention | Cold retention | Deletion mechanism |
|---|---|---|---|---|
| Traces (spans, span attributes, exemplars) | Trace backend | 7 d | 30 d | Age-based partition/drop |
| Structured logs | Log store | 30 d | 90 d; security-relevant records (`severity` ∈ {`ERROR`, `FATAL`}, `event` ∈ {`CrossTenantAccessRefused`, `EgressDenied`, `StaleRecipeRefused`, `DuplicateEffectDetected`}) 400 d | Daily partition drop |
| Metrics (raw series) | TSDB | 15 d full resolution; 5 m downsampled 13 months | — | Series/block expiry |
| Metric exemplars | TSDB | 72 h | — | Exemplar expiry |
| Error reports (GlitchTip) | Error reporter | 90 d | — | Age-based purge |
| Alert history and SLO verdicts | Alerting/SLO store | 13 months | — | Age-based purge |
| Redaction evidence artifacts (`EgressClass` decisions, canary run bundles) | Evidence store | per `EvidenceArtifact` retention | per `EvidenceArtifact` retention | Content-addressed object expiry under the evidence store's policy |
| Debug bundles | Evidence store | 30 d | — | Object expiry |

**Audit versus telemetry.** The append-only `AuditEvent` store (VG-EVIDENCE-003) is a
separate store with its own retention governed by SPEC-002/SPEC-008; audit rows are not
telemetry. Telemetry integrity is immutability **per partition** (a partition is never
rewritten once sealed) combined with whole-partition drop. This specification asserts no audit
retention duration; where a deletion request would affect audit rows, the audit store's own
policy and the recorded legal basis govern, and the conflict must be resolved by that policy
rather than by silently truncating telemetry or silently retaining PII.

### 11.2 Deletion propagation

1. A tenant-data deletion or retention expiry event must propagate to the telemetry plane:
   logs are partitioned by day so that affected windows can be dropped, traces are dropped by
   age, and per-tenant recording scopes are dropped with the tenant's series.
2. Telemetry payloads carry **opaque identifiers only** (§5.5), so telemetry deletion is a
   hygiene and minimization control rather than the primary privacy control. The primary
   control is that the PII was never there.
3. A deletion request must not be satisfied by rewriting sealed partitions. The
   partition-drop mechanism is the only permitted deletion path, so that immutability and
   deletion are not in conflict.
4. Every deletion job emits `vanishgraph_telemetry_deletions_total{data_class, outcome}` and a
   structured `severity: "INFO"` record naming the window; deletion is never silent and never
   reported as `DEBUG`.

### 11.3 Access control on observability data

1. **Telemetry is a privileged data class.** Read access to raw traces, logs, metrics,
   dashboards, alerts, and debug bundles requires an authenticated principal with an
   observability role, granted through the platform's identity provider with MFA (Keycloak,
   SPEC-005).
2. **Least privilege by signal class.** Log and trace read access is a separate grant from
   metrics read access. Provider credentials, DSNs, and collector endpoints are resolved
   through `SecretResolver` and never appear in dashboards, alert annotations, runbook
   examples, or exported bundles (VG-SEC-002).
3. **Tenant scoping.** Any tenant-level observable is served through the tenant-scoped read
   path with the same service-layer authorization and PostgreSQL RLS enforcement required by
   VG-TENANT-001/002. Cross-tenant reads through a dashboard, query API, or saved view must
   fail exactly as a cross-tenant data read fails, and must increment
   `vanishgraph_tenant_scope_refusals_total{layer="EVIDENCE_READBACK"}`.
4. **No screenshots in tickets.** Incident tickets, issues, and PRs may reference opaque IDs,
   digests, and metric series only. A screenshot of a case view is a prohibited payload
   (§4.2); the correct attachment is an `EvidenceArtifact` reference.
5. **Access is audited.** Every read of raw telemetry through a privileged path emits an
   `AuditEvent` with actor, purpose code, query scope, and result count — never the result
   contents. Observability access is not an unlogged back door.
6. **Break-glass is time-bound.** Emergency elevated access is granted for a bounded window,
   requires a recorded justification, alerts the security lane when used (routed as A-05), and
   expires automatically.

---

## 12. Requirement catalogue

Every requirement below has exactly one acceptance oracle and exactly one required negative
case (DOD-001, DOD-008, DOD-014). Test IDs in this section are identifiers of tests that must
exist and be executed in the candidate epoch; their existence here is not evidence that they
have run (SPEC-000 §9.1).

### 12.1 Signal architecture and artifact identity

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-OBS-003` | Every emitted trace span, log record, and metric sample carries the nine canonical resource attributes of §2.1 with non-empty values, including `vanishgraph.candidate_epoch` and `vanishgraph.artifact.digest`. | `OBS-ATTR-001`: telemetry captured from a live run of each declared service is inspected at the collector; all nine attributes present, non-empty, and equal to the values recorded in `RUN_MANIFEST`; the backend's resource-attribute index returns the expected sample counts per service. | `OBS-ATTR-NEG-001`: a run with the artifact digest unresolved must produce zero emitted records, a `TelemetryIdentityMissing` record, and a non-zero `vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}`; no record may carry a placeholder. |
| `VG-OBS-004` | Artifact identity propagates into every telemetry-derived claim so evidence is epoch-bound (DOD-029). | `OBS-EPOCH-001`: take one telemetry-derived claim, resolve requirement ID → test ID → command → observed sentinel → artifact digest → candidate epoch → evidence digest, and re-resolve the same digest by an independent query against the telemetry store. | `OBS-EPOCH-NEG-001`: a telemetry record whose candidate epoch differs from the pinned epoch must make the claim unresolvable and fail the traceability check rather than silently pass with old identity. |
| `VG-OBS-005` | The four signal classes of §2.3 are produced through the declared transports, and each has a declared owner service and runtime configuration key. | `OBS-SIGNAL-001`: an end-to-end case run produces ≥ 1 connected trace in the trace backend, ≥ 1 JSON log record in the log store, ≥ 1 scraped metric sample from `GET /metrics`, and ≥ 1 error report in the error reporter from a deliberately raised (and scrubbed) test error — each tagged with the candidate epoch. | `OBS-SIGNAL-NEG-001`: with the collector unreachable and the error-reporting DSN unset, the application must still serve requests, must log `severity: "WARN"` with the specific reason code, and must increment the telemetry-egress failure counter; it must not fabricate a success event to fill the gap. |
| `VG-OBS-006` | Every critical workflow emits correlated logs, metrics, and traces, and the observability gate fails when any critical stage emits no signal (VG-OBS-001 enforcement). | `OBS-COVER-001`: for a full discovery → action → verification case run, an automated per-stage assertion reports present signals for every stage, with a non-zero check count so an empty match set cannot pass. | `OBS-COVER-NEG-001`: given a fixture whose action stage is instrumented to emit nothing, the gate must exit non-zero with a sentinel naming the missing stage; and given an input with zero matching records, the gate must also exit non-zero (DOD-007). |
| `VG-OBS-007` | Signal volume is bounded: no metric-label cardinality explosion, no per-record payload above the declared telemetry size limit, and no unbounded attribute growth. | `OBS-VOLUME-001`: after the `WL-1` workload, TSDB cardinality per metric is below its declared limit and ≥ 99 % of records are under the declared size limit; a report lists the observed maximum per metric. | `OBS-VOLUME-NEG-001`: a deliberately injected unbounded attribute (a per-case identifier used as a metric label) must be rejected at registration and must fail the cardinality check. |
| `VG-OBS-008` | Every signal class has an explicit configured retention window per §11.1, enforced by an automated expiry job. | `OBS-RETENTION-001`: retention configuration validated against the §11.1 table; a seeded expired record is absent after the expiry job runs, and `vanishgraph_telemetry_deletions_total` increments for the affected class and window. | `OBS-RETENTION-NEG-001`: removing the retention configuration for one signal class must fail the deploy gate with a missing-configuration error; the system must not fall back to infinite retention. |

### 12.2 DLP-safe telemetry

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-OBS-009` | No telemetry, issue, or PR egress occurs without a mandatory scrub stage producing an accepted-payload token; all five sinks require the token (§4.1). | `OBS-DLP-001`: for each of the five sinks, an emission attempt with a valid token sends the scrubbed payload and increments `vanishgraph_dlp_scrub_outcome_total{outcome="ALLOWED_OPAQUE"}`; an attempt without a token is refused at the boundary. | `OBS-DLP-NEG-001`: with the scrub stage unconfigured or failing, every sink must fail closed, emit no payload, and increment `vanishgraph_dlp_egress_denied_total{reason_code=~"POLICY_ABSENT\|SCRUB_FAILED"}`. |
| `VG-OBS-010` | Deny by default: the telemetry allowlist is exhaustive, every field has an `EgressClass` and a disposition, and the §4.2 prohibited classes are denied in all encodings. | `OBS-DLP-002`: runtime-generated canaries for each prohibited class are injected into every natural flow path; exported payloads from all five sinks contain zero occurrences of any canary value, while allowlisted opaque-ID fields still appear with correct content. | `OBS-DLP-NEG-001` plus `OBS-DLP-NEG-002`: a field name that is not on the allowlist, or one of the prohibited field names of §5.3, must be refused even when its value is benign; and a base64-, URL-, or truncation-encoded canary must also be refused rather than passed through. |
| `VG-OBS-011` | Redaction is verified by executed runtime-generated canary tests that are proven capable of failure; redaction is never asserted (§4.4, DOD-013). | `OBS-CANARY-001`: the canary run records seed, canary bundle digest, per-sink exported-payload digest, and a `PASS` verdict with zero canary occurrences; the redaction-evidence artifact resolves under VG-EGRESS-002. | `OBS-CANARY-NEG-001`: with exactly one redaction rule class disabled, the canary test must fail and must name the offending rule class and field path — proving the test is discriminating and not vacuous. |
| `VG-OBS-012` | The `EgressClass` of an egress event is recorded as a bounded enum on the event record, and no telemetry payload contains the classified content itself. | `OBS-EGRESS-001`: a seeded egress event with class `CUSTOMER_PII` under an explicit tenant policy produces a recorded `redactionCount` and rule class with the content absent from the exported payload; a `NONE`/`OPAQUE_ID` event passes unchanged. | `OBS-EGRESS-NEG-001`: an `IDENTITY_DOCUMENT`- or `AUTH_SECRET`-classified field is denied unconditionally, increments `vanishgraph_dlp_egress_denied_total{egress_class=...}`, and produces no payload even with a tenant policy present. |

### 12.3 Correlation and causality

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-OBS-013` | `correlationId` propagates from the HTTP entry point through the durable job queue, discovery, external action, and independent verification, and every signal in the flow carries it (§5.3). | `OBS-CORR-001`: one end-to-end run emits logs at every stage with an identical `correlationId`; the trace backend shows one connected trace spanning the HTTP root through workflow, activity, action, and verification spans; the incoming `traceparent` is honoured when present. | `OBS-CORR-NEG-001`: an activity invoked without a `correlationId` must be refused with a typed missing-identity error at the boundary and must emit no signal with a zeroed, empty, or freshly generated substitute identifier. |
| `VG-OBS-014` | A single case is reconstructible from telemetry: given `caseId` or `correlationId`, the ordered timeline of truth-state transitions, external actions, verification observations, and refusals is recoverable, and it agrees with the append-only `AuditEvent` stream. | `OBS-RECON-001`: for a case taken to `VERIFIED_REMOVED`, an independent query returns the full ordered timeline; the count and ordering of truth-state transitions match the audit stream for that case, and each transition resolves to an evidence digest. | `OBS-RECON-NEG-001`: for a case whose telemetry is incomplete (one transition record removed for the test), the reconstruction must report a gap and fail validation rather than presenting a shorter timeline as complete. |
| `VG-OBS-015` | Join keys between traces, logs, and metrics are declared and documented: `trace_id`/`span_id` (log ↔ trace), `correlationId` (all three), and the metric label set plus `caseId` carried in span attributes and log fields (metric ↔ case). | `OBS-JOIN-001`: a single case is joined across one trace, one log record, and one derived metric sample; the join resolves to the same `caseId`, tenant class, and candidate epoch, and the join query returns a non-empty result set. | `OBS-JOIN-NEG-001`: a metric sample missing a declared label must make the join return no row and must make the join validator report a missing label key; the dimension must not be silently dropped and no dashboard may compute the metric from the incomplete sample. |

### 12.4 Metric contract and catalogue

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-OBS-016` | Metric names, types, units, and label sets conform to §6.1, are registered with an owner and a meaning, use only canonical vocabulary, and use only permitted label names. | `OBS-METRIC-001`: the metrics registration check lists every emitted metric with type, unit, label set, and owner; every name matches the naming rules; every label is in the permitted set; the check passes on the full registry. | `OBS-METRIC-NEG-001`: registration of a metric whose name contains a forbidden synonym, or whose label set contains a prohibited label such as `tenant_id` or a raw subject value, or whose label value set is not a declared bounded enum, must be rejected with a typed error and fail lint. |
| `VG-OBS-017` | The primary effectiveness metric is emitted as independently verified removals ÷ eligible confirmed matches, with numerator, denominator, and confidence interval always emitted together, per §6.3 (VG-OBS-002). | `OBS-EFFECT-001`: for a workload with a known outcome set, the raw counters are independently recomputed from audit events and the recorded ratio and Wilson interval match the recomputation within tolerance; numerator, denominator, and `ci` (point/lower/upper) are all present, and the exclusion components `excluded_not_removable` and `excluded_human_required` are non-suppressed. | `OBS-EFFECT-NEG-001`: a registration or dashboard attempt for a metric named or aliased "requests sent", "submissions", "permanent deletion", "deleted", "deletion rate", or "success rate", or any removal-named series lacking a verification-observation linkage, must be rejected; and a rendered ratio without a denominator must fail the dashboard schema check. |
| `VG-OBS-018` | Truth-state transition counters are emitted per destination state using exactly the eleven canonical tokens and the `T1`…`T21` transition identifiers, never collapsed (§6.4). | `OBS-STATE-001`: a scripted sequence exercising every legal transition produces the expected increment for each destination state and transition id; the metric validator confirms every observed `truth_state` label value is a canonical token. | `OBS-STATE-NEG-001`: a metric sample labelled with a non-canonical status token (for example `DONE`, `COMPLETE`, `SUCCESS`, or `REMOVED`) must be rejected by the validator and must fail the vocabulary gate; and a report that sums distinct states into one "completed" number must fail the dashboard review check of §10.4. |
| `VG-OBS-019` | Reappearance rate, verification lag, false-positive rate, stale-recipe count, and ambiguity/reconciliation count are emitted with the units, buckets, and label sets of §6.5, each with its denominator where it is a rate. | `OBS-QUALITY-001`: a scripted run producing at least one of each condition yields correct bucket placement for `vanishgraph_verification_lag_seconds`, correct `reappearance_window` bucketing, a non-zero `vanishgraph_stale_recipe_refusals_total` with a classified `reason_code`, and rate series accompanied by their denominator series. | `OBS-QUALITY-NEG-001`: removing a required quality metric from the dashboard registry (or rendering its rate without a denominator) must fail the registry check; a worsening quality metric must never cause its own series to be dropped or hidden. |
| `VG-OBS-020` | Cost and human-time metrics are emitted per §6.5 with integer minor units, declared currency, and human minutes recorded at gate resolution. | `OBS-COST-001`: a scripted run with a paid channel effect and a resolved human gate yields `vanishgraph_external_action_cost_minor_units_total` with the correct amount and `currency` label, and `vanishgraph_human_minutes_total` matching the recorded gate resolution interval. | `OBS-COST-NEG-001`: a float, an implicit currency, or a per-attempt human-minute estimate must be rejected by the metric schema check; an unrecorded cost must leave the series absent and must make any cost-budget statement `INCONCLUSIVE`, never `PASS`. |
| `VG-OBS-021` | Provider and channel health, rate-limit saturation, budget consumption, and auth failures are emitted per §6.5, with health derived from probe results and saturation derived from the configured limit. | `OBS-PROVIDER-001`: a run with a healthy transport, a deliberately throttled transport, and a deliberately rejected credential yields `vanishgraph_source_channel_health_status` values 1 and 3 for the affected series, a `vanishgraph_source_ratelimit_saturation_ratio` consistent with the configured limit, and a classified `vanishgraph_provider_auth_failures_total`. | `OBS-PROVIDER-NEG-001`: a health gauge set by optimistic default (no probe performed) must be rejected — the value must derive from a probe result, and `reason_code` must be populated; a rate-limit refusal must be counted as a client-side refusal rather than reported as an unclassified error. |
| `VG-OBS-022` | DLP redaction counts are emitted per egress class and rule class, and denial counts are emitted per sink and reason, with no redacted value or value-derived hash in any label (§6.5). | `OBS-DLP-003`: a run seeding both a redaction and a denial yields one increment of `vanishgraph_dlp_redactions_total` with the correct `egress_class` and `rule_class`, and one increment of `vanishgraph_dlp_egress_denied_total` with the correct `sink` and `reason_code`. | `OBS-DLP-NEG-003`: a metric carrying the matched text, a reversible encoding of it, or a content hash of a redacted value as a label must be rejected at registration and must fail the DLP gate. |

### 12.5 Health, readiness, and liveness

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-OBS-023` | `GET /v1/live`, `GET /v1/ready`, `GET /v1/health`, `GET /v1/startup`, and `GET /metrics` exist with the distinct semantics of §7.1; liveness performs no dependency I/O and `GET /metrics` is cluster-internal only. | `OBS-HEALTH-001`: with all dependencies healthy, `/v1/live`, `/v1/ready`, `/v1/health`, and `/v1/startup` return `200` with the documented bodies, and `/metrics` returns a valid exposition; a network test from outside the cluster cannot reach `/metrics`. | `OBS-HEALTH-NEG-001`: with every dependency down, `/v1/live` must still return `200` (no dependency entanglement, no restart loop) while `/v1/ready` returns `503`; and `/metrics` must not be reachable from the public ingress. |
| `VG-OBS-024` | Readiness reflects real dependency state: the declared required set per role is exactly §7.2, every declared dependency appears in the `checks` array with status and `reasonCode`, and probe timeouts are hard bounds. | `OBS-READY-001`: the `checks` array contains every declared dependency for the role with `name`, `required`, `status`, `latencyMs`, and `reasonCode`, and `failedChecks` agrees with it; per-probe latency stays inside the declared timeout; the overall `dependencyState` equals the conjunction of required checks. | `OBS-READY-NEG-001`: a probe that times out or returns an unknown result must register `FAIL` with `reasonCode: "TIMEOUT"` (or `"UNKNOWN"`), never `PASS`; and an omitted dependency in the response must fail the response schema check rather than being treated as healthy. |
| `VG-OBS-025` | Fail-closed readiness: any required-dependency failure makes the instance unready on the first failing evaluation, removes it from the ready set within one probe interval, and stops new work acceptance (§7.3); a static `200` is a defect (VG-OPS-001). | `OBS-FAILCLOSED-001`: step 3 and step 5 of §7.4 — induced failure flips `/v1/ready` to `503` within 10 s with the failing dependency named in `failedChecks` and `checks`, `vanishgraph_readiness_status` drops to `0`, a `ReadinessChanged` `ERROR` record exists, and new-work counters for that instance stop advancing. | `OBS-FAILCLOSED-NEG-001`: a static readiness handler that always returns `200` must fail step 3 of §7.4, proving the acceptance test discriminates a real check from a fabricated one. |
| `VG-OBS-026` | Every declared dependency's probe is discriminating and is proven by induced failure across the full set: `postgresql`, `valkey`, `job-worker`, `object-store`, `keycloak-jwks`, `provider-transport` (§7.4). | `OBS-INDUCE-001`: the §7.4 procedure executed once per dependency yields, for each, a `503` readiness response naming that dependency, an increment of `vanishgraph_dependency_probe_failures_total` with a classified `reason_code`, and a recorded latency inside the timeout; each dependency's control run (uninduced) reports `PASS`. | `OBS-INDUCE-NEG-001`: the harness must demonstrate discrimination per dependency by showing `PASS` before injection and `FAIL` after injection for the same probe code path; a probe that reports `PASS` in both states is a defect, and a missing probe for a declared dependency fails the check-manifest validation. |

### 12.6 Alerting

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-OBS-027` | Every alert in §8 is defined as versioned data with expression, threshold, `for` duration, severity, routing lane, and runbook link, and each is proven by an induced condition that fires it and a remediation that resolves it. | `OBS-ALERT-001`: for each alert row, the induced condition produces a firing alert with the expected labels, severity, and routing, and remediation produces a resolved alert within the declared window; the definition validator confirms all six fields are present and the runbook path exists. | `OBS-ALERT-NEG-001`: an alert definition missing a runbook, missing a `for` duration, or containing a placeholder value must fail the definition validator; a rule whose expression can only be satisfied when the system is healthy must fail the truthfulness review rule 2 of §8. |
| `VG-OBS-028` | Domain-truth alerts exist and are wired: removal-claim-without-verification (A-01, A-01b), verification-lag breach (A-02), reappearance spike (A-03), stale-recipe execution attempt (A-04), and verification-independence violation (A-13). | `OBS-ALERT-002`: seeded conditions — a `VERIFIED_REMOVED` transition with no observation reference, an aged `ACKNOWLEDGED` backlog beyond the window, a reappearance burst above baseline, a forced stale recipe, and an observation recorded on the acting path — each fire the corresponding alert with the correct severity and route to `page`. | `OBS-ALERT-NEG-002`: with the same seeds present but the corresponding rule disabled, the alert must not fire, proving the rule (not an unrelated signal) produced the notification; and a `VERIFIED_REMOVED` count without observation linkage must never be treated as a removal success anywhere in the alert text. |
| `VG-OBS-029` | Security and integrity alerts exist and are wired: cross-tenant access attempt (A-05), DLP egress denial (A-06, A-06b, A-06c), budget exhaustion (A-07, A-07b), duplicate external effect (A-08), provider auth failure (A-09, A-09b), and readiness flapping (A-10). | `OBS-ALERT-003`: seeded conditions — an RLS/service-layer cross-tenant read, a prohibited-class egress attempt, a budget-exhausted write refusal, a replayed `IdempotencyKey` producing a second effect, a provider credential rejection, and repeated readiness transitions — each fire the corresponding alert with the correct severity, and A-05/A-06b/A-06c route to `page-security`. | `OBS-ALERT-NEG-003`: each of these alerts must be suppressed for a benign condition that shares the same metric (for example a single allowlisted `NONE`-class egress event, or one readiness transition) to prove the threshold discriminates; an alert that fires on normal operation fails acceptance and must be retuned rather than muted. |

### 12.7 SLOs, truthfulness, and access

| ID | Requirement | Acceptance oracle | Required negative case |
|---|---|---|---|
| `VG-SLO-001` | API availability ≥ 0.999 over a rolling 30-day window under workload `WL-1`, measured by the §9 indicator, with readiness-probe traffic excluded from both terms and measured separately. | `SLO-AVAIL-001`: the evaluator emits `vanishgraph_slo_verdict{objective="availability"}` with a non-zero denominator for every 5-minute window in the 30-day sample and a `PASS`/`FAIL` verdict computed from the raw counters; the recomputed ratio matches the recorded value. | `SLO-AVAIL-NEG-001`: an injected failure window that pushes the ratio below 0.999 must produce `FAIL`; and a window with no requests must produce `INCONCLUSIVE`, never `PASS`. |
| `VG-SLO-002` | Verification latency p95 ≤ 14 days and p99 ≤ 30 days over a rolling 30-day window, with censoring of cases still inside their observation window, per §9. | `SLO-VERIFY-001`: the evaluator emits percentile values and a verdict with at least 30 completed `ACKNOWLEDGED`→`VerificationObservation` observations; the percentile is recomputed independently from the histogram and matches. | `SLO-VERIFY-NEG-001`: an injected slow-verification cohort that pushes p95 past 14 days must produce `FAIL`, and a sample with fewer than 30 completed observations must produce `INCONCLUSIVE` rather than `PASS`. |
| `VG-SLO-003` | Workflow completion ≥ 0.95 over a rolling 30-day window across the five honest outcome states, with every destination state individually present and `NOT_REMOVABLE`/`HUMAN_REQUIRED` non-suppressed, per §9. | `SLO-COMPLETE-001`: the evaluator emits the ratio and a verdict, and a report lists each of the five destination states with its own count in the same window; the ratio is recomputed independently and matches. | `SLO-COMPLETE-NEG-001`: a suppressed `HUMAN_REQUIRED` or `NOT_REMOVABLE` series while the ratio still exceeds 0.95 must produce `FAIL` for this objective; and a zero denominator must produce `INCONCLUSIVE`. |
| `VG-SLO-004` | Reconciliation time p90 ≤ 4 hours and no single reconciliation above 24 hours over a rolling 30-day window, exercised against the induced-ambiguity fault set, per §9. | `SLO-RECON-001`: the evaluator emits p90 and max values plus a verdict for a window containing induced ambiguity events, with the fault set named in the run manifest. | `SLO-RECON-NEG-001`: an injected reconciliation stuck beyond 24 hours must produce `FAIL`, and a window containing no ambiguity event must produce `INCONCLUSIVE` — an untested path is never `PASS` (DOD-014). |
| `VG-SLO-005` | SLO evaluation integrity: every objective's evaluator is proven to fail when its objective is breached and to pass when it is not; an induced breach that yields `PASS` invalidates every other SLO verdict. | `SLO-INTEGRITY-001`: for each of `VG-SLO-001`…`VG-SLO-004`, an induced-breach run produces `FAIL` and an undisturbed run produces `PASS`; the matrix of induced conditions and verdicts is recorded as evidence with the candidate epoch and artifact digest. | `SLO-INTEGRITY-NEG-001`: if any induced breach produces `PASS`, the integrity objective must report `FAIL`, all dependent SLO verdicts must be revoked as `INCONCLUSIVE`, and the release gate must not accept them. |
| `VG-OBS-030` | Telemetry never reports a success state the domain did not reach: transitions carry the truth state actually written, `VERIFIED_REMOVED` requires a linked `VerificationObservation`, and no success naming is applied to `REQUEST_SUBMITTED`, `ACKNOWLEDGED`, or `SEARCH_DELISTED` (DOD-037). | `OBS-TRUTH-001`: for a scripted mixed run, every transition record's `truthStateTo` equals the domain-persisted state, every `VERIFIED_REMOVED` record carries a linked observation id, and no log, metric, or API response names a submitted or acknowledged case as removed. | `OBS-TRUTH-NEG-001`: a forced refusal (an illegal transition attempt, for example `REQUEST_SUBMITTED → VERIFIED_REMOVED`) must produce a `REFUSED` outcome record and must not increment any success series; a record labelled `SUCCEEDED` for a refused transition must fail the truthfulness check. |
| `VG-OBS-031` | Induced failures are visible in signals: every induced-failure test in this specification produces a signal, and where §8 defines an alert for it, that alert fires (DOD-037). | `OBS-INDUCED-VIS-001`: the induced-failure matrix (dependency failure, provider auth failure, stale recipe, duplicate effect, cross-tenant refusal, DLP denial, canary detection, budget refusal) produces, per row, a metric increment, a structured log record with a classified `reasonCode`, and a fired alert where one is defined. | `OBS-INDUCED-VIS-NEG-001`: an induced failure that produces no metric increment, no log record, or no alert must be reported as an observability failure for that row; a failing row may not be closed by lowering the induction or by asserting the failure was expected. |
| `VG-OBS-032` | No silent suppression of `HUMAN_REQUIRED` or `NOT_REMOVABLE`: neither state may be filtered, sampled away, severity-downgraded, or excluded from a denominator to improve an apparent success rate (VG-OBS-002, SPEC-001 SM-5). | `OBS-NOSUPPRESS-001`: for a run containing both states, each appears as an individual destination series and in the effectiveness exclusion components; a report lists both counts; sampling configuration demonstrably retains every truth-state transition and every `ERROR`/`FATAL` record. | `OBS-NOSUPPRESS-NEG-001`: a dashboard, API query, or report template that omits either state, or a sampling configuration that drops truth-state transitions or `ERROR`/`FATAL` records, must fail the observability gate; a denominator computed after excluding those states must fail schema validation. |
| `VG-OBS-033` | Dashboards do not aggregate distinct truth states into a single completion number, and no visual presents `SEARCH_DELISTED`, `ACKNOWLEDGED`, or `REQUEST_SUBMITTED` inside a removal total (§10.4, SPEC-000 §5.1). | `OBS-DASH-001`: each dashboard panel is validated against the truth-state rendering rules; any panel showing a rate shows its denominator; the eleven-state breakdown panel shows every non-zero state with its own count. | `OBS-DASH-NEG-001`: a panel definition summing distinct truth states into one "completed" value, or a removal panel whose query includes `SEARCH_DELISTED`, `ACKNOWLEDGED`, or `REQUEST_SUBMITTED`, must fail the dashboard schema check and must not be deployable. |
| `VG-OBS-034` | Observability data is not a PII back door: telemetry access requires an authenticated, MFA-backed observability role; tenant-level reads go through the same authorization and RLS enforcement as product reads; and every privileged telemetry read emits an `AuditEvent` (VG-TENANT-002, VG-EVIDENCE-003). | `OBS-ACCESS-001`: an unauthenticated or non-privileged principal cannot read raw telemetry; a tenant-scoped telemetry read returns only that tenant's rows; and a privileged raw read produces an `AuditEvent` with actor, purpose code, query scope, and result count but no result contents. | `OBS-ACCESS-NEG-001`: a cross-tenant telemetry read must return nothing and increment `vanishgraph_tenant_scope_refusals_total{layer="EVIDENCE_READBACK"}`; and a privileged read that produces no audit row must fail the access-control acceptance. |
| `VG-OBS-035` | Observability data is subject to the retention and deletion policy of §11: windows are configured per class, deletion propagates on tenant deletion or expiry, and the only deletion path is whole-partition drop — sealed partitions are never rewritten. | `OBS-DELETE-001`: for a tenant deletion request, the affected log windows and tenant recording scopes are dropped, `vanishgraph_telemetry_deletions_total{data_class,outcome}` increments, an `INFO` record names the window, and a follow-up query returns no rows for the deleted scope while the audit store's own policy is reported separately. | `OBS-DELETE-NEG-001`: an attempt to satisfy a deletion request by rewriting a sealed telemetry partition in place must be refused; the system must use partition drop, and a missing retention window for any class must fail the deploy gate rather than defaulting to "keep forever". |

---

## 13. Traceability and conflicts

### 13.1 Requirement index

`VG-OBS-001`, `VG-OBS-002` — owned by SPEC-000 §6.7 (referenced, not restated).

Introduced by this file: `VG-OBS-003` … `VG-OBS-035` (33 requirements), and `VG-SLO-001` …
`VG-SLO-005` (5 objectives). **Total introduced here: 38. Total requirements governed by this
file including the two referenced from SPEC-000: 40.**

Every ID above must appear in `REQUIREMENT_TRACEABILITY.csv` and in at least one row of
`FUNCTIONAL_PROOF_MATRIX.csv` (SPEC-000 §10). The alert, endpoint, metric, and test
identifiers introduced here must receive individual applicability decisions in the release
accounting (DOD-030) and must not be silently omitted.

### 13.2 DOD mapping

| DOD | How this specification carries it |
|---|---|
| DOD-001, DOD-008, DOD-014 | Every requirement in §12 has one acceptance oracle and one required negative case. |
| DOD-012 | Independent verification is required before `VERIFIED_REMOVED` telemetry; A-01, A-13, `VG-OBS-028`. |
| DOD-013 | Runtime-generated canaries for redaction proof and induced-failure proof: §4.4, `VG-OBS-011`, `VG-OBS-026`. |
| DOD-022 | §9 SLOs as automated pass/fail thresholds with workload model, window, and verdict rule; `VG-SLO-001`…`VG-SLO-005`. |
| DOD-029 | Artifact identity in resource attributes and epoch-bound evidence: §2.1, `VG-OBS-003`, `VG-OBS-004`. |
| DOD-037 | §10 truthfulness rules; `VG-OBS-030`, `VG-OBS-031`, `VG-OBS-032`, `VG-OBS-033`; `VG-EGRESS-002` redaction evidence. |
| DOD-040 | Any change to this file invalidates dependent telemetry evidence and SLO verdicts (VG-REL-004, `VG-SLO-005`). |

### 13.3 Conflicts and ambiguities found

Recorded honestly; each is either resolved here by explicit reference to SPEC-000/SPEC-001 or
flagged for the owning specification. None is resolved by weakening a rule.

1. **`VG-OBS-002` has no metric-name binding.** SPEC-000 §6.7 defines the effectiveness
   metric semantically but assigns no metric identifier, unit, or label set. This file binds
   it to `vanishgraph_removal_effectiveness_events_total` and
   `vanishgraph_removal_effectiveness_ratio` (§6.3) without altering the requirement. No
   contradiction; an extension.
2. **`HUMAN_REQUIRED` / `NOT_REMOVABLE` denominator treatment is an inference.** SPEC-001 SM-5
   states that `HUMAN_REQUIRED` "must not decrement success metrics", and SPEC-000 §7.6
   requires that `HUMAN_REQUIRED` and `NOT_REMOVABLE` not be hidden. Neither states whether an
   exposure closed as `HUMAN_REQUIRED` before its verification window belongs in the
   effectiveness **denominator**. This file resolves it in the only direction that is
   consistent with both rules and with the SPEC-003 §5.16.3 denominator definition adopted in
   §6.3: such an exposure **stays inside the denominator** (it did reach `MATCH_CONFIRMED`
   within the interval) and is disclosed through the mandatory `excluded_human_required` /
   `excluded_not_removable` components, so the exclusion is countable and visible and can never
   be silent (`VG-OBS-017`, `VG-OBS-032`). A future "exclude from the denominator" treatment
   would be a specification change and would have to move those exposures into an explicitly
   labelled component rather than dropping them. Flagged for SPEC-000 ownership if a different
   treatment is intended.
3. **`Source` is both a domain term and a generic telemetry word.** SPEC-000 §4 makes `Source`
   canonical and forbids `site`, `vendor`, and `provider` as its synonyms. Telemetry
   nonetheless needs the vocabulary of third-party transports and controllers. This file uses
   `source_class` and `sourceId` for the canonical meaning, and `provider`/`Controller` only
   where SPEC-000 itself uses them: `provider_transport` (transport health),
   `vanishgraph_provider_auth_failures_total`, `ProviderTransportRun` (SPEC-001 §3.5), and
   `Controller` (the legally responsible organization). No forbidden synonym
   (`site`, `vendor`, `hit`, `listing`, `match`, `ticket`, `job`, `task`, `submission`,
   `request`, `sanitizer`, `scraper`, `bot`) appears in any metric name, label, field name,
   endpoint path, or test identifier introduced here. The `scrape`/`scraped` tokens appear
   only in the standard Prometheus sense (`GET /metrics` scrape), never as a synonym for
   `RemovalRecipe` execution.
4. **Retention duration for the append-only audit store is unspecified upstream.** SPEC-001
   §3.5 requires `AuditEvent` to be append-only and VG-EVIDENCE-003 forbids mutation, but no
   specification states a retention duration, and a legal-hold or deletion obligation could
   appear to conflict with append-only immutability. §11.1 resolves the *telemetry* side by
   separating the two stores and deferring audit retention to SPEC-002/SPEC-008 policy; the
   upstream duration remains an open item and must not be invented here.
5. **`tenantId` is mandatory in logs but prohibited as a metric label.** This is not a
   contradiction — logs are per-record and query-scoped, metric labels are series
   dimensions — but it must be stated so that implementers do not "fix" the asymmetry by
   adding a tenant label. See §5.2 and §6.2.
6. **Endpoint paths — resolved by adoption, one addition.** SPEC-003 §5.17 (written
   concurrently) fixes the public health routes at `GET /v1/health`, `GET /v1/ready`, and
   `GET /v1/live`. SPEC-003 owns the public API surface, so this file **adopts those three
   paths and their `dependencyState` / `failedChecks` vocabulary verbatim** rather than
   competing with them. Two additions remain this file's own: `GET /v1/startup`, because
   startup completion (migration-applied check, configuration resolution, secret resolution,
   resource attributes resolved) is reported by neither readiness nor liveness; and
   `GET /metrics`, which is deliberately outside `/v1` because it is a cluster-internal
   scrape endpoint and not a public API route. SPEC-003 §5.17 must add `GET /v1/startup` or
   the conflict must be resolved in SPEC-003's favour with this file updated.
7. **Sampling policy is unspecified upstream.** No specification states whether trace
   sampling is permitted. §10.3 constrains it: sampling must never drop truth-state
   transitions, `ERROR`, or `FATAL` records. Any broader sampling policy is owned by this file
   and would require a specification change.
8. **Error-budget policy consequences are unspecified upstream.** DOD-022 requires automated
   thresholds and makes a mandatory SLO failure `NO_GO`, but no specification states what
   happens operationally when a rolling error budget is exhausted mid-window (feature freeze,
   escalation, or none). §9 defines the verdict machinery and the burn metric; the
   *consequence* policy is flagged as an open item for SPEC-008 (production readiness) rather
   than invented here.
9. **Effectiveness-denominator conflict — resolved by adopting SPEC-003.** SPEC-003 §5.16.3
   defines the denominator as "exposures at `MATCH_CONFIRMED` or beyond within the interval
   that were eligible for a lawful channel". This file's first draft instead counted the
   denominator at the moment a case entered `REQUEST_READY`, which yields a materially smaller
   population (it excludes confirmed matches that never became request-ready) and therefore a
   materially higher ratio for the same outcomes. The divergence is real and would have
   produced two different published effectiveness numbers from one dataset. §6.3 now adopts the
   SPEC-003 definition verbatim, because the public contract owns the published number, and
   adds the binding rule that a second divergent denominator definition anywhere is a defect.
   The numerator definition was not in conflict and is unchanged. Note the interaction with
   §13.3 item 2 above: a confirmed match that closes as `HUMAN_REQUIRED` or `NOT_REMOVABLE`
   now remains **inside** the SPEC-003 denominator and must be disclosed through the mandatory
   `excluded_not_removable` / `excluded_human_required` components, which is exactly why those
   components are mandatory rather than optional.
10. **Confidence-interval representation differs between planes.** This file specifies the
    interval as recording-rule series labelled `ci` ∈ {`point`, `lower`, `upper`}; SPEC-003
    §5.16.3 returns it as a JSON object `{"level":0.95,"low":…,"high":…}`. This is a
    representation difference, not a semantic conflict: both are Wilson score intervals at 95 %
    confidence, and `VG-OBS-017` requires the API response and the recording rule to agree
    within tolerance. §6.3's exclusion-component vocabulary and SPEC-003's
    `excludedFromNumerator` field vocabulary also differ in granularity; the mapping rule is
    stated in §6.3 and the four extra API fields are deliberately not metric labels.

---

## 14. Acceptance for this specification

This specification is satisfied only when, for the current candidate epoch and pinned
artifact digest, executed evidence shows:

1. Every requirement in §12 passes its acceptance oracle and its required negative case, with
   results resolvable requirement → test → command → sentinel/exit code → artifact digest →
   evidence path (SPEC-000 §9.2).
2. The redaction canary run passes **and** the disabled-rule negative control fails, proving
   the canary test is discriminating.
3. The induced-failure matrix for all six dependencies flips readiness and is visible in
   metrics, logs, and alerts.
4. Every alert in §8 has fired under an induced condition and resolved after remediation.
5. Every SLO in §9 has produced a verdict from a real sample, and the induced-breach matrix of
   `VG-SLO-005` shows `FAIL` where a breach was induced.
6. No dashboard panel aggregates distinct truth states, and every displayed rate carries its
   denominator.

Until then this specification is unimplemented, and any statement that a metric, dashboard,
alert, pipeline, or SLO described here is built, wired, or verified is a fabrication defect
(DOD-026, DOD-027, DOD-037).
