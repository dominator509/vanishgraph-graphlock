# OBSERVABILITY.md

The operational telemetry plane of VanishGraph. Transcribed from SPEC-007 §2–§5 (EP-008 M3(e)), which is normative: this
document describes what is specified and says plainly which parts are built, which are partially built, and which are not
built at all. **A pipeline, metric, endpoint or alert named below is not evidence that it exists** (SPEC-007 preamble).

## 1. Signal inventory and transport (SPEC-007 §2.3)

| Signal | Producer | Transport | Store / backend | Declaration | State in this repository |
|---|---|---|---|---|---|
| Traces | OTel SDK in every service | OTLP/gRPC to the collector | trace backend behind the collector | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_TRACES_EXPORTER=otlp` | **NOT BUILT.** No OpenTelemetry dependency exists (measured, `.agent/evidence/EP-008/M1-discovery.txt`). The sink adapter serialises OTLP-shaped bytes and the DLP stage refuses without a token; transport is not implemented. |
| Logs (structured) | the application logger, JSON lines to stdout | platform log agent → collector → store | log store indexed by `correlationId`, `tenantId`, `severity` | `VANISHGRAPH_LOG_FORMAT=json` | **PARTIAL.** `src/adapters/observability/structured-logger.ts` implements the contract of §5 and writes one JSON record per line to stdout. `pino` already serves the HTTP layer. |
| Metrics | Prometheus client registry in every service | scrape of `GET /metrics` | Prometheus-compatible TSDB plus recording rules | `VANISHGRAPH_METRICS_PATH=/metrics` | **NOT BUILT.** No Prometheus client exists; no `/metrics` endpoint exists. The DLP and telemetry-identity counters are emitted as labelled series names through the gate's counter surface, not yet through a scrape endpoint. |
| Errors | error reporter (GlitchTip-compatible) | scrubbed event POST, DSN from `SecretResolver` | GlitchTip project per environment | `VANISHGRAPH_ERROR_REPORTING_DSN` (secret) | **NOT BUILT.** No reporter client exists; the sink adapter produces the POST body and the DLP stage governs it. |

Rules that hold regardless of whether a transport exists (§2.3): standard output is the only log sink; `GET /metrics` is
cluster-internal only and must be unreachable from the public ingress; metric exemplars are scrubbed under the same DLP
rules as every other payload; high-cardinality identifiers (`caseId`, `exposureId`, `actionId`, `evidenceId`, `sourceId`,
`recipeId`, `ProtectedSubject` references, tenant IDs) belong in span attributes, log fields or exemplars and **never** as
metric label values.

## 2. Egress sinks and the scrub stage (SPEC-007 §4.1–§4.4)

There are exactly **five** egress sinks: the OTLP trace exporter, the collector-bound log forwarder, the error reporter,
the PR/issue text exporter (`RepairCapsule` egress), and the debug bundle exporter.

```
producer → record(...) → classify → scrub (deny-by-default) → [accepted payload + scrub token] → sink adapter → egress
```

**BUILT** (`src/adapters/observability/egress-gate.ts`, `telemetry-allowlist.ts`; `config/telemetry/allowlist.json`): the
classification is versioned data (`field_path → EgressClass → disposition`) with default `DENY`; a field with no entry, a
prohibited field name at any depth, a field whose `EgressClass` is not permitted, and an unvalidatable policy are each
refused; outcomes are exactly `ALLOWED_OPAQUE`, `REDACTED`, `DENIED`, `FAILED`, and `FAILED` behaves as `DENIED`; a
denial emits **no payload at all**; reaching a sink without a token is impossible in the type system and refused at
runtime; base64-, percent- and truncation-encoded prohibited values are refused rather than decoded and cleaned. Counters:
`vanishgraph_dlp_scrub_outcome_total{outcome}`, `vanishgraph_dlp_egress_denied_total{reason_code}`,
`vanishgraph_dlp_canary_detections_total{sink}`.

**NOT BUILT:** the transport clients. Every sink row currently reads `BLOCKED_ENVIRONMENT` with its reason; the same
scrubbed bytes are captured locally through the same code path. Two of the five sinks (PR/issue text exporter, debug
bundle exporter) have **no declared environment variable** in any specification; this repository does not invent one.

Prohibited data classes (§4.2) never leave in any encoding: subject names, email addresses, telephone numbers, postal
addresses, raw HTML, page content, cookies and session values, tokens and secrets, identity-document content, form values,
sensitive screenshots, free-text operator notes. Five of those twelve classes have no shape a value scanner can recognise
and are enforced by field NAME or by `EgressClass`; `config/telemetry/allowlist.json` declares each class's enforcement
and carries no pattern for the classes that have none. The canary proof of §4.4 runs as `sh scripts/egress-canary-test.sh`
(positive run, disabled-rule control, restored run) and leaves its evidence in `.agent/evidence/EP-008/canary/`.

## 3. Canonical resource attributes (SPEC-007 §2.1, §2.2)

Every trace span, log record and metric sample must carry these nine keys with non-empty values, and they are the **only**
canonical resource keys:

`service.name`, `service.version`, `deployment.environment.name`, `vanishgraph.tenant.class`,
`vanishgraph.candidate_epoch`, `vanishgraph.artifact.digest`, `vanishgraph.build.inputs_digest`,
`vanishgraph.policy.version`, `vanishgraph.recipe.set_digest`.

**BUILT** (`src/adapters/observability/telemetry-resource.ts`, `src/infrastructure/observability/compose-telemetry.ts`):
resolution is fail-closed, the two enum attributes are validated as closed sets, `service.name` must be one of the seven
declared services (`vanishgraph-api`, `vanishgraph-web`, `vanishgraph-worker-discovery`, `vanishgraph-worker-action`,
`vanishgraph-worker-verify`, `vanishgraph-scheduler`, `vanishgraph-mcp`) — a process that cannot map itself to that list
fails startup — and a producer that cannot resolve a key emits **zero** records, writes one `TelemetryIdentityMissing`
local structured error, and increments
`vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}`.

**MEASURED STATE OF THIS REPOSITORY:** a run here resolves five of the nine and refuses four.
`vanishgraph.artifact.digest` and `vanishgraph.build.inputs_digest` need build/release output that does not exist
(`scripts/artifact-identity.sh` resolves them for the manifest; the resolver takes them from its ProcessIdentity
parameter, so this document does not claim they resolve from the environment alone); `vanishgraph.policy.version` and
`vanishgraph.recipe.set_digest` need runtime loaders that do not exist. `.agent/verification/state/RUN_MANIFEST.json`
records each key's source and status. Substituting `unknown`, `n/a`, `latest` or a zero digest is prohibited and refused.

## 4. Structured log contract (SPEC-007 §5)

- **Format:** one single-line JSON object per record, UTF-8, no embedded newlines, to stdout. **BUILT.**
- **Severity:** the uppercase closed enum `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`, in ascending order. `ERROR`
  means an operation failed visibly; `FATAL` means the process is terminating; `WARN` means degraded but correct. **BUILT**
  (a value outside the enum is refused).
- **Mandatory fields:** `timestamp` (RFC 3339, millisecond precision, explicit UTC offset), `severity`, `service`,
  `correlationId`, `tenantId`, `event`, `outcome` (`SUCCEEDED`, `REFUSED`, `FAILED`, `AMBIGUOUS`, `GATED`), `message`,
  `candidateEpoch`, `artifactDigest`. **BUILT** (each is refused when absent or empty).
- **Conditional-required fields:** `caseId`, `exposureId`, `actionId` — required whenever the entity is in the operation's
  scope. **BUILT** (the scope is stated by the caller and the logger requires the field).
- **Permitted optional fields:** `traceId`, `spanId`, `traceFlags`, `sourceId`, `recipeId`, `recipeVersion`, `channel`,
  `truthStateFrom`, `truthStateTo`, `transitionId`, `policyVersion`, `jurisdiction`, `evidenceId`, `evidenceDigest`,
  `idempotencyKey`, `attempt`, `latencyMs`, `dependencyKey`, `reasonCode`, `gateKind`, `egressClass`,
  `redactionRuleClass`, `redactionCount`, `budgetKey`, `costMinorUnits`, `currency`, `humanMinutes`, `errorType`,
  `errorCode`, `retryable`. **BUILT** as classification data; the DLP stage denies anything not classified.
- **Prohibited field names at any depth:** `name`, `fullName`, `firstName`, `lastName`, `email`, `emailAddress`, `phone`,
  `phoneNumber`, `address`, `street`, `postalCode`, `zip`, `ssn`, `dob`, `dateOfBirth`, `documentNumber`, `idNumber`,
  `body`, `html`, `content`, `pageContent`, `raw`, `payload`, `cookie`, `setCookie`, `sessionId`, `token`, `accessToken`,
  `refreshToken`, `apiKey`, `password`, `secret`, `otp`, `formValues`, `screenshot`, `imageBase64`, `attachment`.
  **BUILT** (rejected by the logger before the record leaves the process). The prohibition is aimed at record fields; the
  resource attributes `service.name` and `deployment.environment.name` are mandated by §2.1 and are the only exemption,
  which `config/telemetry/allowlist.json` states in its `resource_key_note`.
- **Event names:** the SPEC-000 §4 / SPEC-001 §7 domain events (`SourceRecordObserved`, `MatchConfirmed`, `PolicyResolved`,
  `RequestReady`, `ActionSubmitted`, `ActionAmbiguous`, `Acknowledged`, `Refused`, `HumanRequired`, `VerifiedRemoved`,
  `VerificationFailed`, `Reappeared`, `NotRemovable`, `SearchDelisted`, `EvidenceStored`, `BudgetExceeded`) plus the
  declared operational set (`ReadinessChanged`, `DependencyProbeFailed`, `EgressDenied`, `EgressScrubbed`, `AlertFired`,
  `AlertResolved`, `SloBreachDetected`, `TelemetryIdentityMissing`, `StaleRecipeRefused`, `DuplicateEffectDetected`,
  `CrossTenantAccessRefused`). Ad-hoc event strings are rejected. **BUILT.**
- **Opaque-identifier rule:** a log field value is an opaque id, a digest, an enum token, a number, a boolean, a duration,
  a currency amount, a version string, a jurisdiction code, or a content-free template validated as containing no
  prohibited class. Raw text that originated outside the trust boundary is logged as a length, a digest, a classified
  `reasonCode` and an `EvidenceArtifact` reference — never verbatim. **BUILT** as a rejection of line breaks and nested
  structures plus the DLP stage's field rules.

## 5. Correlation model (SPEC-007 §5.2, §3.1, §6.4)

`correlationId` is opaque, stable across the whole case flow, and mandatory on every record; `tenantId`, `caseId`,
`exposureId` and `actionId` are opaque and travel as attributes or fields, never as metric labels. **BUILT**: an activity
invoked without a `correlationId` is refused with a typed missing-identity error and emits no signal — this repository
never generates, zeroes or otherwise substitutes a correlation identifier, because such a record would look correlated and
join to nothing.

`GET /v1/health`, `GET /v1/ready` and `GET /v1/live` are adopted from SPEC-003 §5.17 with its `dependencyState` /
`failedChecks` vocabulary; `GET /v1/startup` and `GET /metrics` are this plane's own additions. **NOT BUILT** as
observability endpoints: the health routes exist in `src/http/routes/health.ts` from the API node, and the readiness
fault-injection proof of §7.4 belongs to EP-008 M6.

## 6. Truthfulness (SPEC-007 §10, DOD-037)

A signal may never assert a state the domain did not reach. **BUILT** as record-level rules: `SUCCEEDED` is refused for
`REQUEST_SUBMITTED`, `ACKNOWLEDGED` and `SEARCH_DELISTED`, which never count as progress; a `VERIFIED_REMOVED` record
without `vanishgraph.verification.observation_id` is refused; `HUMAN_REQUIRED` and `NOT_REMOVABLE` are never downgraded,
filtered or sampled away; sampling may never drop a truth-state transition, an `ERROR` or a `FATAL`. The same rules are
re-applied by `scanLogStream` to a captured stream, which is what `sh scripts/log-contract-guard.sh` runs.

## 7. What is specified but not built, in one list

Traces and OTLP export; `GET /metrics` and the Prometheus registry; the error-reporter client; alert definitions and
runbooks (EP-008 M7); SLO evaluation and error budgets (M8); retention and access configuration for observability data
(M8); the readiness/liveness induced-failure proof (M6); the metrics catalogue (M5). **NO RESULT, DIGEST OR MEASUREMENT IS
CLAIMED BY THIS DOCUMENT.** The evidence for what is built lives under `.agent/evidence/EP-008/`, and the ledger records
each milestone with its sentinels.

## 8b. Retention, deletion and access control (SPEC-007 §11)

`config/observability/retention.json` gives **one explicit window per data class**: traces 7 d hot / 30 d cold; structured
logs 30 d / 90 d; the **security-relevant subset** 400 d, selected by `severity ∈ {ERROR, FATAL}` and the events
`CrossTenantAccessRefused`, `EgressDenied`, `StaleRecipeRefused`, `DuplicateEffectDetected`; metrics 15 d full
resolution then 5-minute downsampling for 13 months; exemplars 72 h; error reports 90 d; alert history and SLO verdicts
13 months; redaction evidence and debug bundles **per the evidence store policy**, not per a second number invented here.
`sh scripts/retention-config-guard.sh` (sentinel `retention config: ok`) validates the file against §11.1, refuses an
**unbounded** window in every form, and checks the deletion counter and its outcome vocabulary against the metric
catalogue — a deletion whose outcome the catalogue cannot express would happen without a signal.

**Deletion propagates by WHOLE-PARTITION DROP only.** A request that would rewrite records inside a **sealed** partition
is refused and recorded as `REFUSED_SEALED_REWRITE` rather than silently skipped: sealing is what makes a stored artifact
evidence, and a job that could edit it would destroy the property the store exists for. Every deletion emits one **INFO**
record and is **never** reported at `DEBUG` — a retention job that runs quietly is indistinguishable from one that has
stopped, which is how a window silently becomes infinite in practice.

**Raw telemetry reads** require an authenticated caller, an observability role and an MFA-backed assurance level, are
scoped to the caller's tenant, and emit an `AuditEvent` carrying actor, purpose code, query scope and result count but
**no result contents**; an unaudited privileged read is a **failure**, because it is indistinguishable from exfiltration.
A cross-tenant read returns **nothing** (not an error — a distinguishable refusal would reveal that the other tenant's
data exists) and increments `vanishgraph_tenant_scope_refusals_total{layer="EVIDENCE_READBACK"}`.

**Not built, and recorded rather than implied:** no expiry job and no partitioned telemetry store exist here, so the
deletion **propagation** rows are `BLOCKED_ENVIRONMENT` with their attempt log
(`.agent/evidence/EP-008/retention/provisioning-attempts.txt`), and no deletion has been observed executing.
