NODE-META-BEGIN
ID: EP-008
DEPS: EP-007
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-observability.sh
VERIFY_SENTINEL: gate-observability: ok
GREEN_TAG: green/EP-008
NODE-META-END

# EP-008 — Observability & Operations

## 1. Purpose / Big Picture

VanishGraph is a system of record for **evidence about removal attempts**, so telemetry is part
of the evidence surface, not a side channel. Three laws govern this node (SPEC-007 §1):

- **L1 Truthfulness** — a signal may never assert a state the domain did not reach. A metric that
  counts `REQUEST_SUBMITTED` as a removal, or a report that reads "no alerts" as "no problems", is
  a fabrication defect (DOD-037).
- **L2 Egress safety** — no telemetry, error report, issue, or PR text leaves the trust boundary
  before DLP scrubbing, and redaction is proven by an executed runtime-canary test, never by prose
  (VG-EGRESS-002).
- **L3 Identity** — every signal is bound to a candidate epoch and artifact digest so evidence
  cannot drift across code (DOD-029, VG-REL-004); a producer that cannot resolve its identity
  fails closed and emits nothing rather than a placeholder.

At the end of this node a cold executor must be able to run `sh scripts/gate-observability.sh` and
receive an honest answer to six questions: does the telemetry plane tell the truth; has the
scrubber been proven by a test that can fail; does readiness actually go unready when a real
dependency dies; has every alert fired under an induced condition and resolved; are the SLOs
automated pass/fail thresholds rather than wishes; and does every signal class have a retention
window rather than an implicit "keep forever".

## 2. Scope

In scope:

- The signal architecture: canonical resource attributes, declared services, transports, and the
  signal inventory (SPEC-007 §2).
- The DLP scrub stage in front of all five egress sinks, the versioned telemetry allowlist, and
  the runtime-generated canary proof with its negative control (SPEC-007 §4).
- The structured log contract: mandatory fields, the closed severity enum, canonical event names,
  the opaque-identifier rule, and the prohibited-field-name list (SPEC-007 §5).
- The metric catalogue, the primary effectiveness metric with numerator, denominator and
  confidence interval, the prohibition on requests-sent metrics, and the label cardinality and
  privacy rules (SPEC-007 §6).
- Health, readiness, liveness, and startup endpoints with real dependency probes, fail-closed
  readiness, and the induced-failure proof across all six declared dependencies (SPEC-007 §7).
- The alert catalogue with expressions, thresholds, `for` durations, severities, routing lanes,
  and runbooks, each proven by an induced condition that fires it and a remediation that resolves
  it (SPEC-007 §8).
- SLOs and error budgets as automated, machine-verified thresholds with an induced-breach
  integrity matrix (SPEC-007 §9, DOD-022).
- Retention, deletion propagation, and access control for observability data (SPEC-007 §11).
- The operator-facing documents: `OBSERVABILITY.md`, `OPERATIONS.md`,
  `REMOVAL_EFFECTIVENESS_METRICS.md`, and the runbook set.

## 3. Non-goals

- No new product behaviour. Where a required signal depends on a domain event that does not
  exist, that is a finding about EP-002…EP-006 and is recorded as `BLOCKED_PREREQUISITE` with a
  dependency edge — not implemented here.
- No test-hardening work (EP-007); no packaging, release, CI, staging, or rollback work (EP-009);
  no candidate-epoch freeze, verification subgraph, DOD gate, or release verdict (EP-010).
- No dashboard that aggregates distinct truth states into one completion number, and no metric
  named or aliased "requests sent", "requests submitted", "submissions", "actions taken",
  "permanent deletion", "permanently removed", "deleted", "deletion rate", or "success rate"
  (SPEC-007 §6.3 prohibited list).
- No fabricated substitute record when a signal cannot be produced: dropping a record is honest,
  inventing one is not (SPEC-007 §10.5).
- No alert that can only fire when the system is healthy, and no alert phrased, labelled, or
  annotated as a success notification.
- No retention window that defaults to infinite, and no deletion path that rewrites a sealed
  partition.
- No production deployment (prohibited: VG-SCOPE-009).

## 4. Context and Orientation

Laws and authorities: `AGENTS.md` is authoritative; `SPEC-000` is the oracle for vocabulary,
truth states and acceptance; `SPEC-007` is the normative specification for everything this node
builds; `SPEC-003` §5.16–§5.17 owns the public route vocabulary that this node adopts.

Reality of the repository at the time this plan was authored:

- **SPEC-007 is unimplemented**, and says so in its own header ("Implementation status of this
  document: NOT IMPLEMENTED"); its §14 acceptance section lists six conditions that are not met.
  Reading that file is not evidence under SPEC-000 §9.1.
- `OBSERVABILITY.md` is a one-line summary. `OPERATIONS.md` is a one-line summary.
  `REMOVAL_EFFECTIVENESS_METRICS.md` states the primary metric in prose with no metric name, no
  denominator definition, and no prohibition list.
- No telemetry code exists. The layer contract in `ARCHITECTURE.md` and SPEC-001 §1 places the
  scrub stage and telemetry adapters under `adapters` (implementing the domain's `EgressGate`
  port, SPEC-001 §5), with composition under `infrastructure`; the health routes belong to `http`
  and extend the surface EP-004 created.
- `scripts/probes/` holds credential probes for the external dependencies. Those are the
  discovery half of readiness; the readiness probe itself is product code, not a shell probe.
- `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md` records `clean-local` and `staging` as
  `NOT_PROVISIONED`. Until PostgreSQL, Valkey, Temporal, the object store and Keycloak exist, rows
  that need them are `ERROR` (provisioning gap the adapter can fix), `BLOCKED_ENVIRONMENT`, or
  `BLOCKED_CREDENTIALS` — never `PASS` (DOD-033).
- `.agent/verification/state/RUN_STATE.json` is `PLANNED` and
  `.agent/verification/state/RELEASE_GATE.json` is `INCONCLUSIVE` with reason `FORGE_ONLY`. This
  node changes neither and does not begin the 484 accounting (EP-010).
- Counts that the gates in this node verify: SPEC-007 §8 has **20** alert rows (A-01, A-01b,
  A-02 … A-15) naming **17** distinct runbook paths; SPEC-007 §6.3–§6.5 names **42** metric
  families; SPEC-007 §7.2 declares exactly **six** dependencies; SPEC-007 §9 declares five
  objectives. A missing row is a defect, not a rounding error.
- `scripts/lib/loud-fail.sh` records that every still-unimplemented script exits non-zero with the
  mandated `ERROR:` signature. Any gate this node is supposed to implement must genuinely pass; a
  gate that still prints the placeholder line is a finding about the owning node.

## 5. Files to Read First

Control plane and laws:

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`
- `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/DONE_LAW.md` (all 42 clauses)
- `.agent/checklists/implementation.md`, `.agent/checklists/validation.md`,
  `.agent/checklists/incident-response.md`
- `.agent/state/LEDGER.md`

Specifications:

- `.agent/specs/SPEC-007-observability.md` — read §1–§12 in full; this node is its instantiation
- `.agent/specs/SPEC-000-product-scope.md` §4 (vocabulary lock), §5 and §5.1 (truth model and
  non-collapse rules), §6.6–§6.7 (egress and operations requirements), §7 (coverage honesty), §9
  (acceptance oracle)
- `.agent/specs/SPEC-001-core-domain.md` §1 (layer contract), §5 (ports: `EgressGate`,
  `AuditSink`, `SecretResolver`)
- `.agent/specs/SPEC-003-api-contracts.md` §5.16 (coverage and effectiveness routes), §5.17
  (health, readiness, liveness), §10 (prohibited response fields)
- `.agent/specs/SPEC-005-auth-permissions.md` (observability role, MFA)
- `.agent/specs/SPEC-006-errors.md` §4.1 (taxonomy), §8 (no masking), §9 (no PII in errors)

Operational documents and harness:

- `OBSERVABILITY.md`, `OPERATIONS.md`, `REMOVAL_EFFECTIVENESS_METRICS.md`, `SECURITY.md`,
  `ARCHITECTURE.md`, `ENVIRONMENT.md`, `.env.example`, `PREFLIGHT.md`
- `.agent/verification/HARNESS_LAWS.md`, `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`,
  `.agent/verification/CAPABILITY_MATRIX.md`
- `.agent/verification/MASTER_TEST_REGISTRY.csv` (the GEN and SUP rows whose titles concern
  observability, SLOs, and operational correctness)
- `.agent/verification/DOD_REGISTRY.csv` (DOD-012, DOD-013, DOD-022, DOD-029, DOD-037, DOD-040)
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`

Code and gates actually present:

- `src/**` (especially the HTTP surface from EP-004, the authorization hooks from EP-006, and the
  ports declared in `src/domain/`)
- `tests/**`
- `scripts/**` including `scripts/lib/loud-fail.sh` and `scripts/probes/*.sh`

## 6. Expected Changed Files

Created:

- `src/adapters/observability/telemetry-resource.ts`
- `src/adapters/observability/telemetry-allowlist.ts`
- `src/adapters/observability/egress-gate.ts`
- `src/adapters/observability/structured-logger.ts`
- `src/adapters/observability/metrics-registry.ts`
- `src/adapters/observability/effectiveness-metric.ts`
- `src/adapters/observability/dependency-probes.ts`
- `src/adapters/observability/slo-evaluator.ts`
- `src/http/health-routes.ts`
- `src/infrastructure/observability/compose-telemetry.ts`
- `config/telemetry/allowlist.json`
- `config/metrics/catalogue.json`
- `config/alerts/catalogue.json`
- `config/slo/objectives.json`
- `config/dashboards/*.json`
- `config/observability/retention.json`
- `docs/runbooks/alerts/removal-claim-without-verification.md`
- `docs/runbooks/alerts/verification-lag-breach.md`
- `docs/runbooks/alerts/reappearance-spike.md`
- `docs/runbooks/alerts/stale-recipe-execution-attempt.md`
- `docs/runbooks/alerts/cross-tenant-access-attempt.md`
- `docs/runbooks/alerts/dlp-egress-denial.md`
- `docs/runbooks/alerts/dlp-canary-detection.md`
- `docs/runbooks/alerts/budget-exhaustion.md`
- `docs/runbooks/alerts/duplicate-external-effect.md`
- `docs/runbooks/alerts/provider-auth-failure.md`
- `docs/runbooks/alerts/readiness-flapping.md`
- `docs/runbooks/alerts/telemetry-identity-missing.md`
- `docs/runbooks/alerts/reconciliation-unresolved.md`
- `docs/runbooks/alerts/verification-independence-violation.md`
- `docs/runbooks/alerts/slo-budget-burn.md`
- `docs/runbooks/alerts/alert-pipeline-blind.md`
- `docs/runbooks/operations/readiness-induced-failure.md`
- `docs/runbooks/operations/telemetry-canary-run.md`
- `docs/runbooks/operations/incident-response.md`
- `scripts/canary-dlp.mjs`
- `scripts/egress-canary-test.sh`
- `scripts/log-contract-guard.sh`
- `scripts/metrics-catalogue-guard.sh`
- `scripts/induced-failure-readiness.sh`
- `scripts/alert-catalogue-guard.sh`
- `scripts/slo-evaluate.sh`
- `scripts/retention-config-guard.sh`
- `scripts/gate-observability.sh`
- `tests/observability/telemetry-identity.test.ts`
- `tests/observability/egress-canary.test.ts`
- `tests/observability/log-contract.test.ts`
- `tests/observability/metrics-catalogue.test.ts`
- `tests/observability/effectiveness-metric.test.ts`
- `tests/observability/readiness-fail-closed.test.ts`
- `tests/observability/alert-definitions.test.ts`
- `tests/observability/slo-evaluator.test.ts`
- `tests/observability/retention-and-access.test.ts`
- `.agent/evidence/EP-008/**`

Modified:

- `OBSERVABILITY.md`, `OPERATIONS.md`, `REMOVAL_EFFECTIVENESS_METRICS.md`, `ENVIRONMENT.md`
- `COMMANDS.md`
- `DECISIONS.md` (the telemetry transport ADR, if a dependency is added)
- `ARCHITECTURE.md` (toolchain table, only if a dependency is added)
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`
- `.agent/verification/REQUIREMENT_TRACEABILITY.csv` (the `VG-OBS-*`, `VG-SLO-*`, `VG-OPS-001`,
  and `VG-EGRESS-002` rows this node actually proves)
- `.agent/verification/state/RUN_MANIFEST.json`
- `.agent/state/LEDGER.md`
- `src/http/**` and `src/infrastructure/**` (route registration and composition only)
- `package.json`, `package-lock.json` (only under the dependency rules)

Nothing else may change. Any other diff is a scope violation and must be reverted.

## 7. Interfaces and Contracts

### 7.1 Gate-script contract

Every script this node adds is POSIX `sh` (the single `*.mjs` helper is Node, wrapped by a POSIX
script), `set -eu`, runs from the repository root, exports
`CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive`, passes
`sh -n`, prints its exact sentinel only on genuine success, and exits non-zero on failure. No
sentinel may be printed from a path that performed no check (DOD-024, SPEC-008 §10).

| Command | Sentinel |
|---|---|
| `sh scripts/egress-canary-test.sh` | `canary egress: ok` |
| `sh scripts/log-contract-guard.sh` | `log contract: ok` |
| `sh scripts/metrics-catalogue-guard.sh` | `metrics catalogue: ok` |
| `sh scripts/induced-failure-readiness.sh` | `readiness induced failure: ok` |
| `sh scripts/alert-catalogue-guard.sh` | `alert catalogue: ok` |
| `sh scripts/slo-evaluate.sh` | `slo: evaluated` |
| `sh scripts/retention-config-guard.sh` | `retention config: ok` |
| `sh scripts/gate-observability.sh` | `gate-observability: ok` |

`sh scripts/slo-evaluate.sh` additionally prints one line per objective of the form
`slo <objective>: PASS|FAIL|INCONCLUSIVE`. An absent objective line is `INCONCLUSIVE`, never
`PASS`.

### 7.2 The nine canonical resource attributes

Every trace span, log record, and metric sample carries `service.name`, `service.version`,
`deployment.environment.name`, `vanishgraph.tenant.class`, `vanishgraph.candidate_epoch`,
`vanishgraph.artifact.digest`, `vanishgraph.build.inputs_digest`, `vanishgraph.policy.version`,
and `vanishgraph.recipe.set_digest`, all non-empty. These are the **only** canonical telemetry
resource keys; producers must not invent aliases or abbreviations. A producer that cannot resolve
one fails closed: it refuses to emit, records a local structured error, and increments
`vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}`. Substituting
`unknown`, `n/a`, `latest`, or a zero digest is prohibited (SPEC-007 §2.1).

`service.name` is exactly one of `vanishgraph-api`, `vanishgraph-web`,
`vanishgraph-worker-discovery`, `vanishgraph-worker-action`, `vanishgraph-worker-verify`,
`vanishgraph-scheduler`, `vanishgraph-mcp`. A process that cannot map itself to that list fails
startup rather than emitting unattributed telemetry.

### 7.3 Egress sinks and the scrub contract

There are exactly **five** egress sinks: the OTLP trace exporter, the collector-bound log
forwarder, the error reporter, the PR/issue text exporter, and the debug bundle exporter. The
scrub stage is deny-by-default; its outcomes are exactly `ALLOWED_OPAQUE`, `REDACTED`, `DENIED`,
`FAILED`, and `FAILED` behaves as `DENIED`. A sink adapter's send function requires an
accepted-payload token produced by the scrub stage, and a denial emits **no payload at all**. The
telemetry allowlist is versioned data (`config/telemetry/allowlist.json`) mapping
`field_path → EgressClass → disposition`; a field with no entry is `DENIED` at runtime.

`EgressClass` dispositions: `NONE` and `OPAQUE_ID` permitted; `CUSTOMER_PII` denied by default and
permitted only with a tenant policy row, a field allowlist entry, and an unconditional
deterministic redaction pass; `HIGH_RISK_PII` denied with no telemetry exception;
`IDENTITY_DOCUMENT` and `AUTH_SECRET` denied unconditionally.

### 7.4 Structured log contract

Single-line JSON objects, one record per line, UTF-8, no embedded newlines, stdout only. Severity
is the closed uppercase enum `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`. Mandatory fields
on every record: `timestamp` (RFC 3339, millisecond precision, explicit UTC offset), `severity`,
`service`, `correlationId`, `tenantId`, `event`, `outcome` (one of `SUCCEEDED`, `REFUSED`,
`FAILED`, `AMBIGUOUS`, `GATED`), `message` (content-free template text), `candidateEpoch`,
`artifactDigest`. Conditional-required: `caseId`, `exposureId`, `actionId`, mandatory when the
entity is in the operation's scope. The prohibited field names of SPEC-007 §5.3 are rejected
anywhere in a record at any nesting depth.

### 7.5 Metric contract

Names begin with `vanishgraph_`, use `lower_snake_case`, and end `_total` for counters, `_seconds`
for durations, `_ratio` for dimensionless ratios, `_bytes` for sizes. Every metric is registered
with type, unit, label set, owner service, and a one-line meaning; unregistered names fail lint.
Canonical label names are exactly those of SPEC-007 §6.1. `tenantId`, `tenant_id`, `tenant`,
`caseId`, `exposureId`, `actionId`, `evidenceId`, `sourceId`, `correlationId`, `trace_id`, and
`subjectId` are prohibited label names, as is any label whose value set is not a bounded enum
declared in versioned configuration.

### 7.6 The primary effectiveness metric (VG-OBS-002)

`vanishgraph_removal_effectiveness_events_total{component}` carries `numerator`, `denominator`,
`excluded_not_removable`, and `excluded_human_required`;
`vanishgraph_removal_effectiveness_ratio{ci}` carries `point`, `lower`, `upper` (Wilson score
interval at 95 %). The denominator is exactly the SPEC-003 §5.16.3 definition: exposures at
`MATCH_CONFIRMED` or beyond within the interval that were eligible for a lawful channel, counted
once per exposure per measurement interval. The numerator counts exposures that reached
`VERIFIED_REMOVED` with a linked `VerificationObservation` produced by a path distinct from the
acting path, with the required observation window elapsed and the recipe's declared verification
method satisfied. Numerator, denominator, and interval are emitted together; a ratio without its
denominator is a defect, and a zero denominator is reported `no_data` with the denominator
present — never a bare `0 %` or `100 %`.

### 7.7 Health endpoints

Ruling: SPEC-007 §7.1 fixes the paths at `GET /v1/live`, `GET /v1/ready`, `GET /v1/health`,
`GET /v1/startup`, and `GET /metrics`, and states that it adopts the SPEC-003 §5.17 paths and
response vocabulary verbatim to avoid a conflict. SPEC-007 §13.3 item 6 is therefore superseded;
the `healthz` / `readyz` / `startupz` paths named there are **not** implemented.

Readiness semantics: any `FAIL`, `TIMEOUT`, or `UNKNOWN` on a required dependency makes
`/v1/ready` return `503` on the first failing evaluation, with no grace period. Liveness never
depends on a dependency and returns `200` during a dependency outage. Readiness is never served
from a static handler, a cached value, or a startup-time snapshot. `/metrics` is cluster-internal
only and must be unreachable from the public ingress. The required dependency sets per role, and
the probe performed for each, are exactly SPEC-007 §7.2: `postgresql`, `valkey`, `temporal`,
`object-store`, `keycloak-jwks`, `provider-transport`.

### 7.8 Status vocabulary

Every status written by this node uses a SPEC-006 §4.1 token with that token's required fields. An
executed failure of the product is `FAIL`; a broken harness is `ERROR`; an unprovisioned
dependency the adapter could provision is `ERROR` until provisioned (DOD-033). A missing sample is
`INCONCLUSIVE`, never `PASS`.

### 7.9 Rulings this plan makes, to be re-recorded in §13 by the executor

1. **Node verify command.** The stub header declared `VERIFY: sh scripts/verify.sh` /
   `VERIFY_SENTINEL: verify: ok`. `verify.sh` cannot print that sentinel before EP-009 builds an
   artifact and EP-010 implements artifact-bound smoke, E2E, and live-fire. This node's verify is
   therefore `sh scripts/gate-observability.sh` with sentinel `gate-observability: ok`. No stage is
   removed from `verify.sh`, its order is unchanged, and nothing is weakened.
2. **Endpoint paths** are those of SPEC-007 §7.1 (see §7.7). The §13.3 item-6 paths are superseded
   and must not be implemented: two path sets for one endpoint is itself an observability defect.
3. **`HUMAN_REQUIRED` exclusion treatment.** SPEC-007 §13.3 item 2 records that neither SPEC-000
   nor SPEC-001 states whether an exposure closed as `HUMAN_REQUIRED` before its verification
   window belongs in the effectiveness denominator. This node adopts SPEC-007's resolution — such
   exposures leave the denominator **visibly**, through the `excluded_human_required` component —
   and flags the choice for SPEC-000 ownership rather than inventing a second denominator.
4. **Transport stack.** The choice of OpenTelemetry SDK, Prometheus client, and error-reporter
   client is made in M1 from repository evidence under the dependency rules, recorded as an ADR in
   `DECISIONS.md`, and pinned exactly. No telemetry dependency is added without that ADR.
5. **`staging`-only SLO verdicts.** SPEC-007 §9 states that local and CI environments may run the
   harness but may not produce an SLO verdict. Until `staging` is provisioned, SLO verdicts are
   `INCONCLUSIVE` with the provisioning attempt log as evidence; they are never `PASS`.
6. **SPEC-007 §13.3 item 8 (error-budget consequence policy) stays open.** DOD-022 requires
   automated thresholds and makes a mandatory SLO failure `NO_GO`, but no specification states
   what happens operationally when an error budget is exhausted mid-window. This node implements
   the verdict machinery and the burn metric and flags the consequence policy as an open item for
   SPEC-008 rather than inventing a feature-freeze rule.

## 8. Milestones

### M1: Telemetry resource identity and declared services

GOAL: Every emitted record carries the nine canonical resource attributes with non-empty values,
and a producer that cannot resolve its identity emits nothing.

READ: `.agent/specs/SPEC-007-observability.md` §2, §13.3; `.agent/specs/SPEC-001-core-domain.md`
§1, §5; `.agent/specs/SPEC-008-production-readiness.md` §3;
`.agent/verification/state/RUN_MANIFEST.json`; `ARCHITECTURE.md`; `COMMANDS.md`;
`.agent/DONE_LAW.md` (DOD-029, DOD-037).

CHANGE: `src/adapters/observability/telemetry-resource.ts`,
`src/infrastructure/observability/compose-telemetry.ts`, `config/telemetry/allowlist.json`,
`tests/observability/telemetry-identity.test.ts`, `DECISIONS.md`, `ARCHITECTURE.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`.agent/verification/state/RUN_MANIFEST.json`, `.agent/state/LEDGER.md`, and `package.json` /
`package-lock.json` only if a dependency is added by ADR.

CONTENT:

(a) `telemetry-resource.ts` — resolves the nine keys of §7.2 from the build output, the deployment
manifest, the versioned policy data, the signed `RemovalRecipe` set, and `RUN_MANIFEST.json`;
attaches them at the SDK resource layer, never at individual call sites; and exposes a fail-closed
resolution function whose failure path emits no record and increments
`vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}`.

(b) The exact test assertion: for each of the nine keys in turn, with that key unresolved, the run
must emit **zero** records and increment the failure counter; and with all nine resolved, every
emitted record carries all nine with the exact values recorded in `RUN_MANIFEST.json`. A record
carrying `unknown`, `n/a`, `latest`, or a zero digest fails the test.

(c) `config/telemetry/allowlist.json` — the versioned classification
(`field_path → EgressClass → disposition`) with an entry for every field this node emits, including
the log fields of §7.4 and the span attributes of SPEC-007 §3.1, and an entry for each of the nine
resource keys.

(d) Exact discovery commands whose output fills the transport blank (which telemetry, metrics, and
error-reporting clients already exist versus must be added):

```
cat package.json
git ls-files 'src/**' | sort
node --version
git ls-files 'scripts/**' | sort
```

Record the output verbatim in `.agent/evidence/EP-008/M1-discovery.txt` and paste the
already-present dependency list into the ADR.

RUN:

```
node --version
sh scripts/test-unit.sh
sh scripts/lint.sh
grep -c 'RESOURCE_ATTR_MISSING' config/telemetry/allowlist.json
```

EXPECT: `test-unit: ok` and `lint: ok` (sentinels owned by EP-001's implementations of those
wrappers). The grep prints the count of classified canonical keys; the executor records the number
in the evidence file. Any unresolved key is a failure to fix in this milestone, not a note.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M1 telemetry identity resolved; test-unit: ok; lint: ok"`

FALLBACK: if the chosen SDK cannot attach resources globally, attach them in a single composition
function that wraps every producer and is the only exported emission path; the fail-closed refusal
test is unchanged. Never fall back to per-call-site attributes, because a new call site could then
omit them silently.

COMMIT: `git add -A && git commit -m "[EP-008][M1] telemetry resource identity and declared services"`

### M2: DLP scrub stage before every sink, with a runtime canary proof

GOAL: All five egress sinks refuse to send without an accepted-payload token, and a
runtime-generated canary test proves redaction works while a disabled-rule negative control proves
the test can fail.

READ: `.agent/specs/SPEC-007-observability.md` §4, §12.2; `.agent/specs/SPEC-000-product-scope.md`
§4 (`EgressClass`, `DLP`), §6.6 (VG-EGRESS-001, VG-EGRESS-002); `.agent/specs/SPEC-006-errors.md`
§9; `SECURITY.md`; `.agent/DONE_LAW.md` (DOD-013, DOD-024, DOD-027); `src/domain/values.ts`;
`config/telemetry/allowlist.json`.

CHANGE: `src/adapters/observability/egress-gate.ts`,
`src/adapters/observability/telemetry-allowlist.ts`, `config/telemetry/allowlist.json`,
`tests/observability/egress-canary.test.ts`, `scripts/canary-dlp.mjs`,
`scripts/egress-canary-test.sh`, `COMMANDS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/evidence/EP-008/canary/**`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) `egress-gate.ts` — the mandatory scrub stage:
`producer → record(...) → classify → scrub (deny-by-default) → accepted payload + scrub token →
sink adapter → egress`. Outcomes are exactly `ALLOWED_OPAQUE`, `REDACTED`, `DENIED`, `FAILED`;
`FAILED` behaves as `DENIED`. A denial or failure emits no payload, increments
`vanishgraph_dlp_scrub_outcome_total` and, for `DENIED`/`FAILED`,
`vanishgraph_dlp_egress_denied_total` with a `reason_code` from `NOT_ALLOWLISTED`,
`PROHIBITED_CLASS`, `PROHIBITED_FIELD_NAME`, `POLICY_ABSENT`, `SCRUB_FAILED`, `CANARY_DETECTED`.
Reaching a sink without a token must be impossible in the type system in addition to being refused
at runtime. The deny-by-default check is also exercised with an encoded canary: a base64-, URL-,
or truncation-encoded prohibited value is refused, not passed through.

(b) `scripts/canary-dlp.mjs` — the runtime canary generator: values are unpredictable, generated
at test time from a recorded seed, shaped like each prohibited class of SPEC-007 §4.2, and drawn
only from non-live material (generated token sets, `.invalid` / `.example` domains, the reserved
fictitious telephone range). It records the seed and a digest over the emitted bundle. Real
person's data is never used to prove redaction.

(c) `tests/observability/egress-canary.test.ts` — injects canaries where PII naturally flows (the
`ProtectedSubject` reference chain, an email-thread body fixture, a fetched page body, a form
submission payload, a screenshot artifact, and a secret-shaped environment value), runs the full
discovery → action → verification path, and asserts on the **exported bytes** from all five sinks
that no canary value occurs as a substring, in a decoded form, or as a token in any field,
attribute, label, resource attribute, or exemplar. It asserts in the same run that allowlisted
opaque identifiers still appear with correct content.

(d) Negative control — the same run with exactly one redaction rule class disabled must FAIL and
must name the offending rule class and field path. A canary test that cannot fail is not a test.

(e) `scripts/egress-canary-test.sh` — runs the canary test, then the disabled-rule control, asserts
the control failed for the right reason, restores the rule, re-runs the positive case, and prints
`canary egress: ok` only then. It writes a redaction-evidence artifact containing the canary seed,
the canary bundle digest, the sink list, the per-sink exported-payload digest, and the verdict.

(f) `COMMANDS.md` — append `sh scripts/egress-canary-test.sh` / `canary egress: ok`.

RUN:

```
sh scripts/test-unit.sh
sh scripts/egress-canary-test.sh
grep -c 'CANARY_DETECTED' config/telemetry/allowlist.json
git diff --exit-code
```

EXPECT: `canary egress: ok`; `git diff --exit-code` exits 0 after the control restored the
disabled rule. A control that did not fail is a harness `ERROR` and the milestone does not pass.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M2 canary egress: ok; disabled-rule control failed as required"`

FALLBACK: if the error reporter or the PR/issue exporter cannot be reached in this environment, the
sink adapter is exercised against a local capture endpoint that receives the same scrubbed bytes
through the same code path, and that sink's row is recorded `BLOCKED_ENVIRONMENT` with the
provisioning attempt log. The canary assertion still runs on the captured bytes; it is never
skipped and the sink is never assumed clean.

COMMIT: `git add -A && git commit -m "[EP-008][M2] DLP scrub stage with runtime canary proof"`

### M3: Structured log contract and truthfulness

GOAL: Every log record satisfies the mandatory-field contract, contains no prohibited field name
and no prohibited data class, and never asserts a state the domain did not reach.

READ: `.agent/specs/SPEC-007-observability.md` §5, §10, §3.2, §12.3;
`.agent/specs/SPEC-000-product-scope.md` §5, §5.1; `.agent/specs/SPEC-006-errors.md` §4.1, §9;
`.agent/DONE_LAW.md` (DOD-037, DOD-012).

CHANGE: `src/adapters/observability/structured-logger.ts`,
`tests/observability/log-contract.test.ts`, `scripts/log-contract-guard.sh`, `COMMANDS.md`,
`OBSERVABILITY.md`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `structured-logger.ts` — single-line JSON to stdout, the closed severity enum, the mandatory
fields of §7.4, the conditional-required fields, the canonical event names of SPEC-007 §5.4 (the
SPEC-001 §7 domain events plus the declared operational set), the opaque-identifier rule, and
rejection of the prohibited field names at any nesting depth before the record leaves the process.
`correlationId` propagates from the HTTP entry point through the workflow, discovery, external
action, and independent verification; an activity invoked without a `correlationId` is refused
with a typed missing-identity error and emits no signal carrying a zeroed, empty, or freshly
generated substitute identifier. Raw text that originated outside the trust boundary — a fetched
page body, a `Controller` reply body, an email body, a form value, a provider error string — is
never logged verbatim; it is logged as a length, a digest, a classified `reasonCode`, and an
`EvidenceArtifact` reference.

(b) The truthfulness assertions the guard enforces: no `outcome: "SUCCEEDED"` on a refused
transition; no `VERIFIED_REMOVED` record without a linked observation id; no success naming applied
to `REQUEST_SUBMITTED`, `ACKNOWLEDGED`, or `SEARCH_DELISTED`; `HUMAN_REQUIRED` and `NOT_REMOVABLE`
never downgraded, filtered, or sampled away; sampling never drops a truth-state transition, an
`ERROR`, or a `FATAL` record.

(c) `scripts/log-contract-guard.sh` — runs the log-contract suite, then scans a captured live log
stream from a real run for a missing mandatory field, a prohibited field name, a non-canonical
event string, a non-canonical severity, and a truthfulness violation. It fails when the captured
stream is empty, because a guard over zero records must fail (DOD-007). Prints
`log contract: ok`.

(d) `COMMANDS.md` — append `sh scripts/log-contract-guard.sh` / `log contract: ok`.
(e) `OBSERVABILITY.md` — replace the one-line summary with the real signal inventory, transports,
sinks, severity enum, mandatory fields, and correlation model, transcribed from SPEC-007 §2–§5.

RUN:

```
sh scripts/test-unit.sh
sh scripts/log-contract-guard.sh
grep -c 'log contract: ok' COMMANDS.md
```

EXPECT: `log contract: ok`; the grep prints `1`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M3 log contract: ok"`

FALLBACK: if no end-to-end run exists yet because an upstream node is incomplete, capture the
stream from the deepest real entry point available and record the capture's coverage in the
evidence file. The guard still fails on an empty capture, so "no logs yet" is an honest failure
rather than a pass.

COMMIT: `git add -A && git commit -m "[EP-008][M3] structured log contract and truthfulness"`

### M4: Metric catalogue and the primary effectiveness metric

GOAL: Every metric in SPEC-007 §6.3–§6.5 is registered with type, unit, labels, owner and meaning;
the effectiveness metric emits numerator, denominator and confidence interval together; and no
requests-sent or permanent-deletion metric exists anywhere.

READ: `.agent/specs/SPEC-007-observability.md` §6, §12.4, §13.3 items 1 and 5;
`.agent/specs/SPEC-003-api-contracts.md` §5.16, §10; `REMOVAL_EFFECTIVENESS_METRICS.md`;
`.agent/specs/SPEC-000-product-scope.md` §5.1, §7; `.agent/specs/SPEC-001-core-domain.md` §4.3;
`.agent/DONE_LAW.md` (DOD-022, DOD-037).

CHANGE: `src/adapters/observability/metrics-registry.ts`,
`src/adapters/observability/effectiveness-metric.ts`, `config/metrics/catalogue.json`,
`tests/observability/metrics-catalogue.test.ts`,
`tests/observability/effectiveness-metric.test.ts`, `scripts/metrics-catalogue-guard.sh`,
`config/dashboards/*.json`, `COMMANDS.md`, `REMOVAL_EFFECTIVENESS_METRICS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `config/metrics/catalogue.json` — exactly **42** metric families, one entry each, with `name`,
`type`, `unit`, `labels`, `owner_service`, `meaning`. The names, transcribed from SPEC-007
§6.3–§6.5:

```
vanishgraph_removal_effectiveness_events_total
vanishgraph_removal_effectiveness_ratio
vanishgraph_truth_state_transitions_total
vanishgraph_truth_state_current
vanishgraph_truth_state_illegal_transition_refused_total
vanishgraph_reappearance_events_total
vanishgraph_reappearance_rate_ratio
vanishgraph_verification_lag_seconds
vanishgraph_false_positive_events_total
vanishgraph_false_positive_rate_ratio
vanishgraph_stale_recipe_refusals_total
vanishgraph_recipe_freshness_age_seconds
vanishgraph_action_ambiguity_events_total
vanishgraph_reconciliation_events_total
vanishgraph_reconciliation_lag_seconds
vanishgraph_human_minutes_total
vanishgraph_external_action_cost_minor_units_total
vanishgraph_source_channel_health_status
vanishgraph_provider_auth_failures_total
vanishgraph_source_ratelimit_saturation_ratio
vanishgraph_source_ratelimit_refusals_total
vanishgraph_action_budget_consumption_ratio
vanishgraph_action_budget_refusals_total
vanishgraph_dlp_scrub_outcome_total
vanishgraph_dlp_redactions_total
vanishgraph_dlp_egress_denied_total
vanishgraph_dlp_canary_detections_total
vanishgraph_telemetry_egress_failures_total
vanishgraph_readiness_status
vanishgraph_dependency_probe_duration_seconds
vanishgraph_dependency_probe_failures_total
vanishgraph_readiness_state_changes_total
vanishgraph_workflow_lag_seconds
vanishgraph_duplicate_external_effect_events_total
vanishgraph_tenant_scope_refusals_total
vanishgraph_verification_observations_recorded_total
vanishgraph_telemetry_deletions_total
vanishgraph_slo_verdict
vanishgraph_slo_bad_events_total
vanishgraph_slo_allowed_bad_events
vanishgraph_slo_error_budget_burn_ratio
vanishgraph_server_http_served_total
```

Label names and bounded label value sets come from SPEC-007 §6.1 and §6.3–§6.5 verbatim. A metric
name or label not in those sections is rejected at registration.

(b) `metrics-registry.ts` — registration with type, unit, labels, owner, and meaning; rejection of
a non-canonical name, a prohibited label (`tenant_id`, `caseId`, `correlationId`, `trace_id`,
`subjectId`, …), a label whose value set is not a bounded enum, a float cost, an implicit currency,
and any name containing a forbidden synonym. Registration failure is a typed error and fails lint.

(c) `effectiveness-metric.ts` — implements §7.6 exactly, emits the events counter with all four
`component` values and the ratio with `ci` ∈ {`point`, `lower`, `upper`}, derives every value from
domain events and never from UI actions, page views, or optimistic intent, and returns `no_data`
with the denominator when the denominator is zero. The API route
`GET /v1/metrics/removal-effectiveness` (SPEC-003 §5.16.3) is served by the same computation: one
denominator definition, no second one anywhere.

(d) Test assertions: for a workload with a known outcome set, the raw counters recomputed
independently from audit events and the recorded ratio and Wilson interval must match within
tolerance, and the exclusion components must be non-suppressed. A second test asserts that a
registration or dashboard panel for `requests sent`, `requests submitted`, `submissions`,
`actions taken`, `permanent deletion`, `permanently removed`, `deleted`, `deletion rate`, or
`success rate` is rejected, and that a rendered ratio without a denominator fails the dashboard
schema check.

(e) `scripts/metrics-catalogue-guard.sh` — asserts the catalogue has 42 entries, every name matches
the naming rules, every label is permitted, every alert expression in `config/alerts/catalogue.json`
and every SLO indicator in `config/slo/objectives.json` refers to a registered metric
(VG-OBS-016), and no prohibited metric name appears anywhere in `config/`, `src/`, or `docs/`.
Prints `metrics catalogue: ok`.

(f) `COMMANDS.md` — append `sh scripts/metrics-catalogue-guard.sh` / `metrics catalogue: ok`.
(g) `REMOVAL_EFFECTIVENESS_METRICS.md` — replace the one-line summary with the metric names, the
numerator and denominator definitions, the always-together rule, the exclusion components, and the
prohibition list.

RUN:

```
sh scripts/test-unit.sh
sh scripts/metrics-catalogue-guard.sh
grep -c '"name"' config/metrics/catalogue.json
```

EXPECT: `metrics catalogue: ok`; the catalogue grep prints `42`. A hit for a prohibited metric name
inside a configuration or dashboard file is a defect to remove, not a wording choice.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M4 metrics catalogue: ok"`

FALLBACK: if a Prometheus client library cannot be added under the dependency rules, expose the same
registered catalogue through a hand-written exposition writer driven by the registry; the
registration, naming, label and prohibition checks are unchanged, and no metric may be dropped to
make the writer simpler.

COMMIT: `git add -A && git commit -m "[EP-008][M4] metric catalogue and effectiveness metric"`

### M5: Health, readiness, liveness and the induced-failure proof

GOAL: Readiness goes `503` on the first failing evaluation of a required dependency and returns to
`200` after remediation, liveness stays `200` throughout, and every declared dependency's probe is
proven discriminating by an induced failure.

READ: `.agent/specs/SPEC-007-observability.md` §7, §12.5; `.agent/specs/SPEC-003-api-contracts.md`
§5.17; `.agent/specs/SPEC-000-product-scope.md` §6.7 (VG-OPS-001); `.agent/DONE_LAW.md` (DOD-014,
DOD-037); `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`;
`.agent/verification/CAPABILITY_MATRIX.md`; `scripts/probes/*.sh`; `OPERATIONS.md`.

CHANGE: `src/adapters/observability/dependency-probes.ts`, `src/http/health-routes.ts`,
`src/infrastructure/observability/compose-telemetry.ts`,
`tests/observability/readiness-fail-closed.test.ts`, `scripts/induced-failure-readiness.sh`,
`docs/runbooks/operations/readiness-induced-failure.md`, `OPERATIONS.md`, `COMMANDS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/evidence/EP-008/induced-failure/**`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) `dependency-probes.ts` — one discriminating probe per declared dependency, with the exact probe
action and hard timeout from SPEC-007 §7.2: `postgresql` (pooled connection
`BEGIN; SELECT 1; ROLLBACK`, plus verification that the session role is the tenant-scoped
application role, 300 ms); `valkey` (`PING`, then write/read/delete under a namespaced probe key,
200 ms); `temporal` (frontend health RPC plus `DescribeNamespace` for the configured namespace,
400 ms); `object-store` (`HeadBucket` plus a signed `GetObject` of a probe key that must return the
expected digest, 400 ms); `keycloak-jwks` (OIDC discovery plus JWKS retrieval over TLS, no token
minted, 300 ms); `provider-transport` (read-only or no-op reachability per declared official
transport, **never a form write**, 400 ms each). At most one retry inside a probe, and the total
readiness budget of 1 500 ms is never extended.

(b) `health-routes.ts` — `GET /v1/live` (no dependency I/O, no authentication),
`GET /v1/ready` (`200`/`503`, with `dependencyState`, `failedChecks`, and the full `checks` array
naming every declared dependency with `name`, `required`, `status`, `latencyMs`, `reasonCode`),
`GET /v1/health` (`dependencyState`, never `status`), `GET /v1/startup` (migration-applied check,
configuration resolution, secret resolution, and resource attributes resolved), and `GET /metrics`
on a cluster-internal listener only. An unready transition records a `ReadinessChanged` record at
severity `ERROR` carrying the failing `dependencyKey` and `reasonCode`; failures are never reported
at `INFO`.

(c) `tests/observability/readiness-fail-closed.test.ts` — the SPEC-007 §7.4 procedure per
dependency: confirm steady state; induce exactly one failure; within 10 s assert `503`, the
dependency named in both `failedChecks` and `checks` with a non-null `reasonCode`,
`vanishgraph_readiness_status == 0` for that key, an increment of
`vanishgraph_dependency_probe_failures_total` with a classified reason, an increment of
`vanishgraph_readiness_state_changes_total{direction="TO_NOT_READY"}`, and the `ReadinessChanged`
`ERROR` record; assert `/v1/live` still returns `200`; assert new work acceptance actually stopped
for that instance; remediate and assert readiness returns to `200` within 30 s. It also runs the
required negative case: a **static** readiness handler that always returns `200` must fail step 3,
which is what proves the acceptance test discriminates a real check from a fabricated one.

(d) `scripts/induced-failure-readiness.sh` — runs the suite once per declared dependency (six runs),
records a control run before injection and an induced run after injection for each, and prints
`readiness induced failure: ok` only when every dependency demonstrated `PASS` before and `FAIL`
after on the **same probe code path**. A probe that reports `PASS` in both states is a defect. A
dependency that cannot be provisioned is recorded `ERROR` per DOD-033 with the provisioning attempt
log.

(e) `docs/runbooks/operations/readiness-induced-failure.md` — the exact procedure, the six
induction actions, the expected signals with thresholds, containment, and resolution criteria.

(f) `COMMANDS.md` — append `sh scripts/induced-failure-readiness.sh` /
`readiness induced failure: ok`.

RUN:

```
sh scripts/test-unit.sh
sh scripts/induced-failure-readiness.sh
grep -c 'dependency_key' config/metrics/catalogue.json
```

EXPECT: `readiness induced failure: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M5 readiness induced failure: ok"`

FALLBACK: if a dependency class cannot be provisioned at all, the probe is exercised against a
locally provisioned disposable instance of the same production-type service (PostgreSQL, Valkey,
and Temporal are `PROVISIONABLE_ENVIRONMENT` per `CAPABILITY_MATRIX.md`) and the row stays `ERROR`
until provisioned. Never substitute an in-process fake for a dependency probe, and never mark a
dependency `PASS` because no probe result arrived.

COMMIT: `git add -A && git commit -m "[EP-008][M5] health, readiness and induced-failure proof"`

### M6: Alert catalogue, runbooks, and induced fire-and-resolve proof

GOAL: Every alert is versioned data with expression, threshold, `for` duration, severity, routing
lane, and an existing runbook; each fires under an induced condition with the correct labels and
resolves after remediation.

READ: `.agent/specs/SPEC-007-observability.md` §8, §12.6; `.agent/DONE_LAW.md` (DOD-037);
`.agent/checklists/incident-response.md`; `OPERATIONS.md`; `config/metrics/catalogue.json`;
`.agent/specs/SPEC-000-product-scope.md` §5.1, §7.

CHANGE: `config/alerts/catalogue.json`, the 17 runbook paths listed in §6,
`docs/runbooks/operations/incident-response.md`,
`tests/observability/alert-definitions.test.ts`, `scripts/alert-catalogue-guard.sh`,
`OPERATIONS.md`, `COMMANDS.md`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`.agent/evidence/EP-008/alerts/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `config/alerts/catalogue.json` — exactly **20** alert rows, transcribed from SPEC-007 §8 with
the exact PromQL expression, threshold, `for`, severity, routing lane (`page`, `page-security`,
`ticket`, `advisory`), and runbook path: A-01, A-01b, A-02, A-03, A-04, A-05, A-06, A-06b, A-06c,
A-07, A-07b, A-08, A-09, A-09b, A-10, A-11, A-12, A-13, A-14, A-15. A placeholder value in any
field fails the gate.

(b) The **17** runbook files, each stating in domain terms: the meaning of the condition, the
diagnostic queries, the containment action, the remediation, and the resolution criteria. A runbook
that only restates its expression is incomplete. Mapping: A-01 and A-01b share
`removal-claim-without-verification.md`; A-06 and A-06b share `dlp-egress-denial.md`; A-07 and
A-07b share `budget-exhaustion.md`; A-09 and A-09b share `provider-auth-failure.md`; every other
row has its own file.

(c) `tests/observability/alert-definitions.test.ts` — asserts all six fields are present for all 20
rows, that every referenced metric is registered, that every runbook path exists and is non-empty,
that routing lanes come from the declared set, and the truthfulness review of SPEC-007 §8.2: no
alert is phrased, labelled, or annotated as a success notification, and no alert can fire only when
the system is healthy.

(d) `scripts/alert-catalogue-guard.sh` — for each alert, induces the condition named in SPEC-007
§8.5 (seeded duplicate external effect, forced stale `RemovalRecipe`, simulated database-layer
refusal, throttled provider auth, killed dependency for readiness flapping, and the rest of the
induced matrix), observes the alert fire with the expected labels, severity, and routing lane, then
remediates and observes it resolve within the declared window. It also runs the discrimination
control: with the same seed present but the rule disabled, the alert must not fire. Prints
`alert catalogue: ok` only when every row fired, resolved, and was suppressed when disabled.

(e) `COMMANDS.md` — append `sh scripts/alert-catalogue-guard.sh` / `alert catalogue: ok`.
(f) `OPERATIONS.md` — replace the one-line summary with the routing lanes, acknowledgement
objectives, runbook index, and the incident-response entry point.

RUN:

```
sh scripts/test-unit.sh
sh scripts/alert-catalogue-guard.sh
grep -c '"id"' config/alerts/catalogue.json
ls docs/runbooks/alerts | wc -l
```

EXPECT: `alert catalogue: ok`; the catalogue grep prints `20`; the runbook listing prints `17`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M6 alert catalogue: ok"`

FALLBACK: if no alerting backend is available in this environment, the rules are evaluated by a
local rule evaluator that consumes the same recorded metric series and emits the same firing and
resolved transitions; the induced condition and the disabled-rule control are executed for real.
Only the backend-specific notification step may be `BLOCKED_ENVIRONMENT`, and the rule evaluation
itself never is.

COMMIT: `git add -A && git commit -m "[EP-008][M6] alert catalogue, runbooks and induced proof"`

### M7: SLOs as automated thresholds with an induced-breach integrity matrix

GOAL: Each of the five objectives is evaluated by a machine that emits a verdict, an induced breach
produces `FAIL`, an undisturbed run produces `PASS`, and an absent or incomplete sample produces
`INCONCLUSIVE` rather than `PASS`.

READ: `.agent/specs/SPEC-007-observability.md` §9, §12.7, §13.3 item 8; `.agent/DONE_LAW.md`
(DOD-022, DOD-038, DOD-027); `config/metrics/catalogue.json`;
`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`; `REMOVAL_EFFECTIVENESS_METRICS.md`.

CHANGE: `config/slo/objectives.json`, `src/adapters/observability/slo-evaluator.ts`,
`tests/observability/slo-evaluator.test.ts`, `scripts/slo-evaluate.sh`, `COMMANDS.md`,
`OPERATIONS.md`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`.agent/evidence/EP-008/slo/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `config/slo/objectives.json` — the five objectives transcribed verbatim from SPEC-007 §9 with
fields `id`, `objective`, `indicator`, `threshold`, `window`, `workload`, `verdictRule`:
`VG-SLO-001` availability ≥ 0.999 over a rolling 30 d with readiness-probe traffic excluded from
both terms and measured separately; `VG-SLO-002` verification latency p95 ≤ 1 209 600 s and p99
≤ 2 592 000 s with ≥ 30 completed observations and censoring of cases still inside their window;
`VG-SLO-003` workflow completion ≥ 0.95 across the five honest destination states, each
individually present with `NOT_REMOVABLE` and `HUMAN_REQUIRED` non-suppressed; `VG-SLO-004`
reconciliation p90 ≤ 14 400 s and max ≤ 86 400 s exercised against the induced-ambiguity fault set;
`VG-SLO-005` evaluation integrity — an induced breach that yields `PASS` invalidates the other four
verdicts. The workload model `WL-1` is versioned data; a change to it invalidates prior verdicts.

(b) `slo-evaluator.ts` — computes each verdict from the recorded series only and emits
`vanishgraph_slo_verdict`, `vanishgraph_slo_bad_events_total`, `vanishgraph_slo_allowed_bad_events`,
and `vanishgraph_slo_error_budget_burn_ratio` per objective and window. A missing sample or an
incomplete window is `INCONCLUSIVE`; the evaluator never rounds `INCONCLUSIVE` to `PASS` or `FAIL`.
Threshold weakening to obtain a pass is prohibited (DOD-027); changing an objective, window, or
workload model requires a specification change, a recorded rationale, and a rerun of every affected
verdict.

(c) `scripts/slo-evaluate.sh` — runs the evaluator against the pinned environment's series, prints
one `slo <objective>: PASS|FAIL|INCONCLUSIVE` line per objective and then `slo: evaluated`. It
exits non-zero when any objective is `FAIL`, and exits zero with `INCONCLUSIVE` lines when the
sample is incomplete; the distinction is deliberate and must not be collapsed. Objectives that
cannot complete inside the campaign window are labelled `DEFERRED_LONG_RUNNING`, never `PASS`
(DOD-038).

(d) The integrity matrix: for each of `VG-SLO-001`…`VG-SLO-004`, an induced-breach run produces
`FAIL` and an undisturbed run produces `PASS`; the matrix of induced conditions and verdicts is
recorded with the environment identity and the pinned epoch. If any induced breach yields `PASS`,
`VG-SLO-005` is `FAIL` and every dependent verdict is revoked as `INCONCLUSIVE`.

(e) `COMMANDS.md` — append `sh scripts/slo-evaluate.sh` / `slo: evaluated` and the per-objective
line format. A mandatory SLO `FAIL` is `NO_GO` for the release gate (DOD-022); this node records
the failure and does not write `RELEASE_GATE.json`.

RUN:

```
sh scripts/test-unit.sh
sh scripts/slo-evaluate.sh
grep -c '"id"' config/slo/objectives.json
```

EXPECT: `slo: evaluated` preceded by five `slo <objective>: ...` lines; the objectives grep prints
`5`. If `staging` is not provisioned, the objectives report `INCONCLUSIVE` with the provisioning
attempt log as evidence — that is the honest result and the milestone records it as such.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M7 slo: evaluated"`

FALLBACK: until a 30-day sample exists, the evaluator is executed against the induced-breach fault
set and a shortened sample, and each verdict is recorded `INCONCLUSIVE` (shortened sample) or
`DEFERRED_LONG_RUNNING` (duration-bound objective) with the sample identity. A shortened trial is
never reported as `PASS` (DOD-038), and the threshold is never changed to fit the sample.

COMMIT: `git add -A && git commit -m "[EP-008][M7] SLOs as automated thresholds with integrity matrix"`

### M8: Retention, deletion, and access control for observability data

GOAL: Every signal class has an explicit configured retention window enforced by an automated
expiry job, deletion propagates by whole-partition drop only, and raw telemetry reads are
authenticated, audited, and tenant-scoped.

READ: `.agent/specs/SPEC-007-observability.md` §11, §12.1 (`VG-OBS-008`), §12.7 (`VG-OBS-034`,
`VG-OBS-035`); `.agent/specs/SPEC-005-auth-permissions.md`;
`.agent/specs/SPEC-000-product-scope.md` §6.6; `.agent/specs/SPEC-003-api-contracts.md` §10;
`.agent/DONE_LAW.md` (DOD-012, DOD-037).

CHANGE: `config/observability/retention.json`, `scripts/retention-config-guard.sh`,
`tests/observability/retention-and-access.test.ts`,
`docs/runbooks/operations/incident-response.md`, `OBSERVABILITY.md`, `OPERATIONS.md`,
`COMMANDS.md`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `config/observability/retention.json` — one explicit window per data class from SPEC-007 §11.1:
traces 7 d hot / 30 d cold; structured logs 30 d hot, 90 d cold, with security-relevant records
(`severity` ∈ {`ERROR`, `FATAL`} and the events `CrossTenantAccessRefused`, `EgressDenied`,
`StaleRecipeRefused`, `DuplicateEffectDetected`) retained 400 d; metrics 15 d full resolution with
5 m downsampling for 13 months; metric exemplars 72 h; error reports 90 d; alert history and SLO
verdicts 13 months; redaction evidence and debug bundles per the evidence store policy. A missing
window is a deploy-gate failure and never defaults to infinite.

(b) `scripts/retention-config-guard.sh` — validates the configuration against the §11.1 table, fails
when any class is missing a window or is set to infinite, and asserts the expiry job emits
`vanishgraph_telemetry_deletions_total{data_class,outcome}` plus an `INFO` record naming the window
(deletion is never silent and never reported at `DEBUG`). It also asserts that a deletion request is
refused when it would rewrite a sealed partition. Prints `retention config: ok`.

(c) `tests/observability/retention-and-access.test.ts` — asserts: a seeded expired record is absent
after the expiry job runs and the deletion counter incremented for the affected class and window; a
sealed-partition rewrite is refused; a privileged raw-telemetry read requires an authenticated
MFA-backed observability role, is scoped to the tenant, and emits an `AuditEvent` with actor,
purpose code, query scope, and result count but no result contents; a cross-tenant telemetry read
returns nothing and increments
`vanishgraph_tenant_scope_refusals_total{layer="EVIDENCE_READBACK"}`; a privileged read that
produces no audit row fails.

(d) `COMMANDS.md` — append `sh scripts/retention-config-guard.sh` / `retention config: ok`.

RUN:

```
sh scripts/test-unit.sh
sh scripts/retention-config-guard.sh
grep -c 'data_class' config/observability/retention.json
```

EXPECT: `retention config: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 MILESTONE_PASS "M8 retention config: ok"`

FALLBACK: if the trace backend or the log store cannot be provisioned, the guard validates the
configuration and the expiry job's dry-run plan, and the deletion-propagation rows are recorded
`BLOCKED_ENVIRONMENT` with the provisioning attempt log. The configuration check itself is never
relaxed to make the guard pass.

COMMIT: `git add -A && git commit -m "[EP-008][M8] retention, deletion and access control"`

### M9: Node close-out

GOAL: The node's own gate passes end to end over the real observability surface, and no unproven
claim is carried forward.

READ: `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md` (DOD-024, DOD-025, DOD-026),
`.agent/specs/SPEC-007-observability.md` §14, `.agent/checklists/final-review.md`,
`.agent/verification/state/RUN_MANIFEST.json`, `.agent/verification/state/RELEASE_GATE.json`,
`.agent/state/LEDGER.md`.

CHANGE: `scripts/gate-observability.sh`, `COMMANDS.md`,
`.agent/verification/state/RUN_MANIFEST.json`, `.agent/state/LEDGER.md`,
`.agent/evidence/EP-008/**`.

CONTENT:

(a) `scripts/gate-observability.sh` runs, in order: `sh scripts/test-unit.sh`,
`sh scripts/log-contract-guard.sh`, `sh scripts/egress-canary-test.sh`,
`sh scripts/metrics-catalogue-guard.sh`, `sh scripts/alert-catalogue-guard.sh`,
`sh scripts/induced-failure-readiness.sh`, `sh scripts/slo-evaluate.sh`,
`sh scripts/retention-config-guard.sh`. It prints `gate-observability: ok` only when every step
exited zero and printed its own sentinel. It additionally asserts that each of the six acceptance
conditions of SPEC-007 §14 resolves to an evidence path in this epoch, and reports any that does not
with its exact taxonomy status instead of a pass. A missing sentinel or a skipped step is a failure.

(b) `RUN_MANIFEST.json` — record the telemetry stack's pinned versions and the overlay revision. Do
not change `registry_count` (484), `dod_count` (42), or `candidate_epoch`.

(c) `RELEASE_GATE.json` — **do not change it here.** The verdict remains `INCONCLUSIVE` with reason
`FORGE_ONLY`. This node cannot produce a verdict (SPEC-008 §13, DOD-042).

(d) Index the EP-008 evidence directory with content hashes and append the milestone ledger events.

RUN:

```
sh scripts/gate-observability.sh
sh scripts/ledger.sh append <AGENT_ID> EP-008 NODE_DONE "EP-008 complete: gate-observability: ok"
git tag green/EP-008
sh scripts/ledger.sh tail 30
git log --oneline -1
```

EXPECT: `gate-observability: ok`; the ledger tail shows the `NODE_DONE` line for `EP-008`; tag
`green/EP-008` exists locally. If an SLO verdict is `INCONCLUSIVE` or a dependency row is
`BLOCKED_ENVIRONMENT`, the node may still close only when each such row carries its required fields
and a named next action; it may never close with a `PASS` that lacks evidence.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-008 NODE_DONE "EP-008 complete: gate-observability: ok"`

FALLBACK: if a mandatory sub-gate cannot pass because an upstream node or an environment is
incomplete, the node stays open and the finding is reported with its taxonomy status. Tagging on a
partial gate is prohibited.

COMMIT: `git add -A && git commit -m "[EP-008][M9] close observability and operations node"`

## 9. Validation and Acceptance

Node-level acceptance, each item an executed observation:

1. `sh scripts/gate-observability.sh` prints `gate-observability: ok` and exits 0.
2. The nine resource attributes are present and non-empty on emitted records, and a run with an
   unresolved artifact digest emits zero records, one `TelemetryIdentityMissing` record, and a
   non-zero `vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}`.
3. `sh scripts/egress-canary-test.sh` prints `canary egress: ok`, and its disabled-rule control was
   observed to fail naming the offending rule class and field path.
4. `sh scripts/log-contract-guard.sh` prints `log contract: ok` on a non-empty captured stream.
5. `sh scripts/metrics-catalogue-guard.sh` prints `metrics catalogue: ok` with 42 registered metric
   families, and no requests-sent, submissions, permanent-deletion, deletion-rate, or success-rate
   metric exists anywhere in `config/`, `src/`, or `docs/`.
6. The effectiveness metric emits numerator, denominator, and the Wilson interval together, with
   both exclusion components non-suppressed, and `GET /v1/metrics/removal-effectiveness` uses the
   same denominator definition.
7. `sh scripts/induced-failure-readiness.sh` prints `readiness induced failure: ok` with a control
   run and an induced run per dependency, and the static-handler negative case failed.
8. `sh scripts/alert-catalogue-guard.sh` prints `alert catalogue: ok` with 20 definition rows and 17
   runbooks, each alert fired under induction and resolved, and each was suppressed when its rule
   was disabled.
9. `sh scripts/slo-evaluate.sh` prints five objective verdict lines and `slo: evaluated`; every
   induced breach produced `FAIL`; no verdict is `PASS` without a sample.
10. `sh scripts/retention-config-guard.sh` prints `retention config: ok` with a window for every data
    class and no infinite retention.
11. `OBSERVABILITY.md`, `OPERATIONS.md`, and `REMOVAL_EFFECTIVENESS_METRICS.md` describe only what
    was actually built; no metric, alert, dashboard, or pipeline is described that is not
    implemented (SPEC-007 §10.7). The open items recorded in §7.9 stay labelled open.
12. No file outside §6's list changed: `git status --short` is the audit list.

**Never claim:** that `sh scripts/verify.sh` passes, that the product is production-ready, that the
484 IDs are accounted, or that an `INCONCLUSIVE` SLO is a pass. The ship verdict remains
`INCONCLUSIVE` with reason `FORGE_ONLY` until EP-010 legitimately changes it.

## 10. Idempotence and Recovery

To re-enter cold: read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, this plan's §11 Progress, then
`.agent/state/LEDGER.md` and `sh scripts/ledger.sh status EP-008`. Resume at the first milestone
with no `MILESTONE_PASS` event, and re-run the previous milestone's gate to confirm its sentinel
still appears before proceeding — cached green is not green (SPEC-008 §3, VG-SHIP-006).

All artefacts are files and every gate is re-runnable. Three operations mutate shared state and must
be cleaned up and proven clean: the disabled-rule canary control, the induced-failure matrix, and the
alert fire-and-resolve inductions. After each, the induced condition must be remediated, the rule or
probe restored, and the steady state re-asserted. A leftover induced failure is an `ERROR` and blocks
the next milestone.

If a dependency is unavailable, only tests with an explicit dependency edge are blocked and all
independent work continues (DOD-031, VG-REL-003); blanket blocking is invalid. Provisioning gaps are
`ERROR` until the adapter has attempted non-invasive provisioning (DOD-033); a genuinely unavailable
environment class is `BLOCKED_ENVIRONMENT` with the provisioning attempt log; a credential gap is
`BLOCKED_CREDENTIALS` naming the `PREFLIGHT.md` row and the probe exit code — never a secret value.

Bounded retry: at most six attempts per milestone following the ladder — targeted fix, diagnosis,
real fallback, rollback, structured block — and never the same fix twice.

## 11. Progress

- [ ] M1: Telemetry resource identity and declared services
- [ ] M2: DLP scrub stage before every sink, with a runtime canary proof
- [ ] M3: Structured log contract and truthfulness
- [ ] M4: Metric catalogue and the primary effectiveness metric
- [ ] M5: Health, readiness, liveness and the induced-failure proof
- [ ] M6: Alert catalogue, runbooks, and induced fire-and-resolve proof
- [ ] M7: SLOs as automated thresholds with an induced-breach integrity matrix
- [ ] M8: Retention, deletion, and access control for observability data
- [ ] M9: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the exact command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
<!-- The executor records here the rulings of §7.9, the transport-stack ADR, and every substitution made under a FALLBACK. -->

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. -->
