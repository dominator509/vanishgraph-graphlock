# Next action

**EP-008 (observability and operations) is CLOSED_BLOCKED on one external condition, and the structured report is
`.agent/evidence/EP-008/CLOSED_BLOCKED.md`.** `graph-next.sh` still names EP-008; **no `NODE_DONE` row was written and no
`green/EP-008` tag exists**, because M9's FALLBACK forbids tagging on a partial gate.

## The one blocking condition

**`provider-transport` needs a provider entitlement; the row is `EXTERNAL_REQUIRED`, not unprovisioned by the
implementer.** MEASURED: all three declared transports are reachable and all three answer **HTTP 401 without a
credential** — which §7.4 step 2 names as the *induced* state, so the control run cannot reach PASS and no transition can
be demonstrated. Evidence: `.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt`.

**NEXT ACTION (an environment action, not code):** obtain an official-transport credential, set it, and re-run
`sh scripts/induced-failure-readiness.sh`. The row becomes demonstrable with no code change; then close M9
(`NODE_DONE`, `green/EP-008`) and continue to EP-009 and EP-010.

## What EP-008 delivered

`MILESTONE_PASS`: M1 telemetry identity, M2 DLP scrub with the canary proof, M3 structured log contract, M4 metric
catalogue and effectiveness metric, M7 SLOs, M8 retention and access. Delivered with one proof `NOT_RUN`: M6 alerts
(catalogue, guard, 17 runbooks, 16-test suite; the induced fire-and-resolve proof needs an expression evaluator and a
series store, neither of which exists). **M5 readiness is PARTIAL: five of six dependencies DEMONSTRATED**
(`postgresql`, `valkey`, `job-worker`, `object-store`, `keycloak-jwks`, each `PASS` → not-`PASS` → `PASS` on the same
probe path), and **`readiness induced failure: ok` has NOT been printed**.

The node gate `sh scripts/gate-observability.sh` prints `gate-observability: ok` (exit 0) with the readiness row reported
as `BLOCKED_ENVIRONMENT`, carrying its required fields and its next action, and an evidence index of 68 files.