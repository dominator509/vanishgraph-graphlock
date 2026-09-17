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
