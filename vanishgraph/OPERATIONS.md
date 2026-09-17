# OPERATIONS.md

How to run, watch and diagnose VanishGraph. Transcribed from SPEC-007 §7–§11 and written to describe **what is actually
built**, with every unbuilt element named as unbuilt (SPEC-007 §10.7 forbids describing a pipeline that does not exist).

## 1. Dependencies and their probes (SPEC-007 §7.2)

Six dependencies are declared, each with one discriminating probe and a hard timeout:

| `dependency_key` | Probe action | Timeout | State in this repository |
|---|---|---|---|
| `postgresql` | pooled `BEGIN; SELECT 1; ROLLBACK`, and the session role must be the tenant-scoped application role | 300 ms | **Provisioned and demonstrated** |
| `valkey` | `PING`, then write/read/delete under a namespaced probe key | 200 ms | **Provisioned and demonstrated** |
| `job-worker` | at least one worker heartbeat inside the declared freshness window (`job_worker.heartbeat_at`) | 200 ms | **Not demonstrable**: no worker process exists in this repository to write a heartbeat |
| `object-store` | `HeadBucket` plus a **signed** `GetObject` of a probe key returning the expected digest | 400 ms | **Not wired**: no module here can sign an S3 request |
| `keycloak-jwks` | OIDC discovery plus JWKS retrieval over TLS, no token minted | 300 ms | **Not provisioned**: no Keycloak in this environment |
| `provider-transport` | read-only or no-op reachability per declared official transport, **never a form write** | 400 ms | **Not provisioned**: no provider entitlement |

**A budget finding, measured:** the six timeouts sum to **1800 ms** against §7.2's declared **1500 ms** total readiness
budget, so a run in which several dependencies hang cannot satisfy both. The runner reports `budgetExceeded` and treats a
breach as `NOT_READY` rather than hiding it.

## 2. Readiness, liveness and startup (SPEC-007 §7.1, §7.3; SPEC-003 §5.17)

- `GET /v1/live` — no dependency I/O, no authentication. Liveness is **deliberately independent**: a dependency outage
  must not fail liveness and must not cause a restart loop, because restarting a healthy process converts a dependency
  incident into an availability incident.
- `GET /v1/ready` — `200`/`503` with `dependencyState`, `failedChecks` and the full `checks` array naming every declared
  dependency with `name`, `required`, `status`, `latencyMs` and `reasonCode`. **One failing required dependency makes it
  `503` on the first evaluation; there is no grace period.**
- `GET /v1/health` — process identity and uptime; never a dependency verdict.
- `GET /v1/startup` — startup completion.
- `GET /metrics` — cluster-internal only, and it must be unreachable from the public ingress. **Content is built**
  (`renderExposition` renders the registered catalogue with `HELP`/`TYPE`, recorded-only series, and histograms as
  `_count`/`_sum` because no bucket boundaries are declared); **the listener is NOT built yet.**

When an instance becomes unready, exactly **one** `ReadinessChanged` record is written at `severity: ERROR` naming the
first failing `dependencyKey` and its classified `reasonCode` — one per transition, so a steadily unready instance does
not write one record per evaluation and an operator can tell an outage from a flap. Failures are never silent and never
reported at `INFO`.

Failure causes are classified into the closed enum `TIMEOUT`, `CONNECT_REFUSED`, `AUTH_FAILED`, `DNS_FAILED`,
`TLS_FAILED`, `HTTP_5XX`, `MISCONFIGURED`, `UNKNOWN`, so on-call acts on a cause rather than on a boolean.

## 3. The induced-failure proof (VG-OPS-001)

`sh scripts/induced-failure-readiness.sh` — sentinel `readiness induced failure: ok`. It runs the same probe path three
times (control, induced, remediated) and prints its sentinel only when **every** declared dependency demonstrated
`PASS` → `FAIL` → `PASS`. Per-dependency rows and the exact induction commands are recorded in
`.agent/evidence/EP-008/induced-failure/`, and the procedure, thresholds, containment and resolution criteria are in
`docs/runbooks/operations/readiness-induced-failure.md`.

**Measured state: the sentinel has NOT been printed.** `postgresql` and `valkey` are demonstrated; the other four rows
are `ERROR` (DOD-033, not provisioned) or `INCONCLUSIVE`. The readiness endpoint must not be reported as proven while any
of those rows stands.

## 4. Telemetry safety (SPEC-007 §4)

The DLP scrub stage sits between every producer and all five egress sinks; the default is deny; an encoded prohibited
value is refused rather than decoded and cleaned; nothing reaches a sink without a scrubbed-payload token. The canary
proof is `sh scripts/egress-canary-test.sh` (sentinel `canary egress: ok`), which runs the suite, then the same run with
one redaction rule class disabled — which **must** fail naming the rule class and field path — and then the positive case
again. Real-person data is never used to prove redaction.

## 5. Metrics, dashboards and prohibitions (SPEC-007 §6)

42 metric families are registered in `config/metrics/catalogue.json` with type, unit, labels, owner and meaning;
`sh scripts/metrics-catalogue-guard.sh` (sentinel `metrics catalogue: ok`) validates the catalogue, every dashboard
panel, the alert and SLO references when those files exist, and scans `config/`, `src/` and `docs/` for a prohibited
metric identifier — a scan it proves can fire by planting one.

`tenantId` is **not** a permitted metric label (§6.2, for cardinality and privacy). No metric may be named or aliased as
"requests sent", "requests submitted", "submissions", "actions taken", "permanent deletion", "permanently removed",
"deleted", "deletion rate" or "success rate", and a metric asserting permanent deletion does not exist: the strongest
available state is `VERIFIED_REMOVED`, scoped to one `Source` and one observation window.

**Not built:** no Prometheus server scrapes these series, no alert definitions beyond the readiness runbook arrive before
EP-008 M7, no SLO evaluation before M8, and no retention configuration before M8. `OBSERVABILITY.md` names each of these
as unbuilt in its own section.

## 6. Incident starting points

1. **Readiness `503`** — read `failedChecks` and the `reasonCode` on `checks`, then the `ReadinessChanged` ERROR record;
   the classified cause names the class of fault (a refused connection is not an authentication failure).
2. **Telemetry dropped** — `vanishgraph_telemetry_egress_failures_total{reason_code="RESOURCE_ATTR_MISSING"}` means the
   process could not resolve its identity and therefore **emitted nothing** (one `TelemetryIdentityMissing` local record
   accompanies it). That is the specified behaviour, not a fault: fix the missing attribute rather than the counter.
3. **A canary reached a sink** — `vanishgraph_dlp_canary_detections_total > 0` is a critical defect; the canary stage's
   evidence names the rule class and field path.
4. **Removal claims look too good** — check the effectiveness metric's denominator and its `excluded_*` components
   together; a ratio without its denominator is a defect, and a denominator that quietly dropped `NOT_REMOVABLE` or
   `HUMAN_REQUIRED` reads as a smaller cohort and a higher ratio for the same outcomes.

## 7. Alerts (SPEC-007 §8)

**What exists:** `config/alerts/catalogue.json` carries exactly **20 alert rows** — A-01, A-01b, A-02, A-03, A-04, A-05,
A-06, A-06b, A-06c, A-07, A-07b, A-08, A-09, A-09b, A-10, A-11, A-12, A-13, A-14, A-15 — each with its exact PromQL
expression, threshold, `for` duration, severity, routing lane and runbook path. Routing lanes: `page` and
`page-security` acknowledge within 5 minutes, `ticket` reviews within 1 business day, `advisory` responds within 4
working hours. Every row points at a runbook under `docs/runbooks/alerts/`, and `sh scripts/alert-catalogue-guard.sh`
(sentinel `alert catalogue: ok`) refuses a row whose runbook is missing or empty, a placeholder in any field, a routing
lane outside the four, an expression naming an unregistered metric, an alert phrased as success, and a coverage-rule
disagreement that is not recorded.

**TWO THINGS AN OPERATOR MUST KNOW BEFORE TRUSTING THIS TABLE.**

1. **NO ALERT HAS BEEN DEMONSTRATED FIRING, AND NONE HAS BEEN DEMONSTRATED RESOLVING.** §8 requires each alert to be
   shown firing under an induced condition with correct labels and to resolve after remediation. That needs an expression
   evaluator and a series store; this repository has neither — no Prometheus server, no recording rules, no loaded alert
   rules. The guard prints `induction: NOT RUN` with that reason on every run, and the alert-definitions suite asserts
   that no evaluator module exists, so the absence cannot be quietly forgotten.
2. **§8 CONTRADICTS ITSELF ABOUT SIX ROWS, AND THE CONTRADICTION IS KEPT VISIBLE.** Coverage rule 1 calls A-01…A-10 the
   required critical set, while §8's own table marks A-02, A-03, A-06, A-07, A-09 and A-10 as `warning`. The catalogue
   transcribes the table (the per-alert fact) and lists the six ids in `coverage_rule_1_conflicts`; the guard and the
   suite both REQUIRE that list to name exactly the rows that disagree, so nobody can make a check green by editing one
   of two normative statements.

Runbook content follows the same rule as the rest of this document: each alert runbook states what a firing **means** and
what it **does not mean** — a stale-recipe refusal means the control worked, a DLP denial means the stage refused to leak,
a cross-tenant refusal means the attempt was denied rather than that data was disclosed — and every one of them ends by
saying that its induction has not been run.

## 8. Service-level objectives (SPEC-007 §9)

**What exists:** `config/slo/objectives.json` carries the **five objectives** — `VG-SLO-001` availability ≥ 0.999 over a
rolling 30 d (readiness and liveness probe traffic excluded from **both** terms and measured separately), `VG-SLO-002`
verification latency p95 ≤ 1 209 600 s and p99 ≤ 2 592 000 s with ≥ 30 completed observations and censoring of cases
still inside their window, `VG-SLO-003` workflow completion ≥ 0.95 across the five honest destination states with
`NOT_REMOVABLE` and `HUMAN_REQUIRED` non-suppressed, `VG-SLO-004` reconciliation p90 ≤ 14 400 s and max ≤ 86 400 s
exercised against the induced-ambiguity fault set, and `VG-SLO-005` evaluation integrity. `WL-1` is the **versioned**
workload model, and changing it invalidates prior verdicts. `sh scripts/slo-evaluate.sh` prints one
`slo <objective>: <VERDICT>` line per objective and then `slo: evaluated`.

**THE VERDICT VOCABULARY IS FOUR VALUES AND THE GAPS BETWEEN THEM ARE THE POINT.** `PASS` and `FAIL` are claims about a
measured interval; `INCONCLUSIVE` says the sample cannot support either claim; `DEFERRED_LONG_RUNNING` says the objective
is duration-bound and the campaign window cannot contain it yet (DOD-038). **A shortened trial is never reported as
`PASS`**, and the evaluator refuses to promote an unexercised objective: zero served responses is not 100 % availability,
fewer than 30 observations makes quantiles *not a measurement*, a missing honest destination state makes the completion
ratio a *different number*, and a reconciliation window with no ambiguity event was never exercised.

**§9 permits a verdict only in `staging` or `production`.** Neither exists here and no series store is reachable, so the
evaluation submits an **incomplete** sample and every objective reports the gap: four `DEFERRED_LONG_RUNNING` and
`evaluation_integrity` `INCONCLUSIVE`. The provisioning attempt log is
`.agent/evidence/EP-008/slo/provisioning-attempts.txt`, and the matrix of induced conditions — each row `NOT_RUN` with its
reason — is `.agent/evidence/EP-008/slo/integrity-matrix.json`. **The exit code distinguishes the two cases**: non-zero
when any objective is `FAIL`, because DOD-022 makes a mandatory SLO failure `NO_GO`; zero when the sample is incomplete,
because "we cannot measure it yet" is an honest result and must not be flattened into either a pass or a failure.

**What is NOT claimed:** no induced breach has been observed producing `FAIL`, no undisturbed run has been observed
producing `PASS`, and no objective has ever been reported `PASS` in this repository. The revocation rule — an induced
breach that yields `PASS` makes `VG-SLO-005` `FAIL` and revokes every dependent verdict as `INCONCLUSIVE` — is enforced by
the evaluator and proven by its suite, not by an executed campaign. The error-budget **consequence policy** stays open
(SPEC-007 §13.3 item 8) and is not invented here.

## 9. Retention, deletion and access (SPEC-007 §11)

`config/observability/retention.json` carries one explicit window per data class, and `sh scripts/retention-config-guard.sh`
(`retention config: ok`) refuses a class with no window, a window that is unbounded in any form, and a deletion outcome
the metric catalogue cannot express. Deletion is by **whole-partition drop**; a sealed-partition rewrite is **refused** and
recorded, never silently skipped; every deletion logs at **INFO** and never at `DEBUG`. Raw telemetry reads need an
authenticated, observability-roled, MFA-backed caller, are tenant-scoped, and write an `AuditEvent` with the actor, purpose
code, query scope and result count but **no result contents**.

**Measured state: the propagation rows are `BLOCKED_ENVIRONMENT`.** There is no partitioned telemetry store and no expiry
job in this environment (`TRACE_BACKEND_URL`, `LOG_STORE_URL` and `PROMETHEUS_URL` are unset, recorded in
`.agent/evidence/EP-008/retention/provisioning-attempts.txt`), so what is validated is the configuration and the dry-run
plan — **no deletion has been observed executing**, and the configuration check was not relaxed to make the guard pass.
