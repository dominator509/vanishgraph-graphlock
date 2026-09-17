# Next action

**EP-007 (testing-hardening) is closed; `graph-next.sh` names EP-008.** EP-008 (observability and operations) is IN
PROGRESS: milestones **M1–M4 are `MILESTONE_PASS`**, **M5 is partially delivered** across six `MILESTONE_NOTE` rows, and
**M6–M9 are untouched**. EP-009 (release) and EP-010 (final accounting) have not been started.

## What EP-008 has built, and what each part was verified by

* **M1 telemetry identity** (`b7f76cd`) — the nine canonical resource attributes, the seven declared services, both enum
  attributes as closed sets, prohibited substitutes refused, and the single emission path (the plan's FALLBACK: no OTel
  SDK exists here). A run in this tree resolves **five of nine** attributes and refuses four, so it **emits nothing** —
  the specified fail-closed behaviour. `test-unit: ok` (1247), `lint: ok`, suite 35/35, `grep -c RESOURCE_ATTR_MISSING`
  = 9.
* **M2 DLP scrub stage** (`c11a997`) — deny-by-default classification from versioned data, encoded prohibited values
  refused rather than cleaned, a token-typed sink boundary, five sink adapters, and a runtime canary proof.
  `canary egress: ok` with a disabled-rule control that **failed as required** naming the rule class and field path.
* **M3 structured log contract** (`5702c79`) — mandatory/conditional fields, closed vocabularies, truthfulness rules,
  `correlationId` with no substitute, and a guard that scans a capture with the same checker and proves it can fire.
  `log contract: ok`.
* **M4 metric catalogue** (`0cdc587`) — 42 families as validated data, a registry that refuses every prohibited series, a
  dashboard schema, and the effectiveness figure built on the API's **own** computation so there is one denominator
  definition. `metrics catalogue: ok`, suites 34/34 and 11/11.
* **M5 readiness** — dependency probes with the declared actions and timeouts, the fail-closed decision, the composition
  that writes one `ReadinessChanged` ERROR per transition, an induced-failure stage, a runbook, and the exposition writer
  (`renderExposition`, M4's fallback).

## M5 is NOT finished, and this is exactly what is owed

1. **`GET /metrics` listener.** The content is built (`renderExposition`); the **cluster-internal listener is not**, and
   it must be unreachable from the public ingress (§2.3 rule 2).
2. **Four dependencies cannot demonstrate their induced transition here**, and the stage honestly exits 1 without
   printing `readiness induced failure: ok`:
   * `job-worker` — **no worker process exists in this repository** to write a heartbeat into `job_worker.heartbeat_at`;
   * `object-store` — **no module here can sign an S3 request**, so the declared `HeadBucket` + signed `GetObject` probe
     is not wired;
   * `keycloak-jwks` — no Keycloak provisioned (needs `KEYCLOAK_ISSUER`);
   * `provider-transport` — no provider entitlement (EXTERNAL_REQUIRED).
   `postgresql` and `valkey` **are** demonstrated (`PASS` → `FAIL` → `PASS` on the same probe path). Evidence:
   `.agent/evidence/EP-008/induced-failure/verdict.txt`.
3. **Findings recorded, not resolved**: the §7.2 per-probe timeouts sum to **1800 ms** against a **1500 ms** total
   readiness budget; the `reason_code` enum is declared per metric but **not enforced at record time**; §6.1's
   canonical label list conflicts with the ~23 labels §6.3–§6.5 declare (carried as data in `label_namespace_note`);
   and `dependency_key` needed an `overall` token for the series §6.5 itself asks for.

## Standing facts that must not be misreported

* `.agent/verification/state/RELEASE_GATE.json` is `{"verdict":"INCONCLUSIVE","reason":"FORGE_ONLY"}` and this node
  **cannot** change it.
* **CI has never run** (`.github/workflows/` is empty; no `CODEOWNERS`), so every CI-only check is unverified.
* **`scripts/test-migrations.sh` does not exist**, so `db/UPGRADE_MATRIX.md` rows remain UNPROVEN.
* **The coverage layer table does not measure the EP-008 observability modules**: `config/testing/coverage-thresholds.json`
  is not in EP-008 §6's file list, so it was not edited and `tests/observability/**` is in no layer's suite list.
* **No external endpoint is reachable**: every sink row reads `BLOCKED_ENVIRONMENT`, no provider was contacted, and no
  delivery is claimed anywhere.
* The M2 DLP counters' `sink` **label values** were reconciled to the catalogue's bounded set in M4; the counters'
  names were unchanged.

## Where to resume

`sh scripts/graph-next.sh` → **NEXT EP-008**. Read `.agent/execplans/EP-008-node.md` M5 for the remaining items above,
then M6 (health runtime and the metrics listener), M7 (alerts and runbooks), M8 (SLOs, retention, access) and M9
(close-out). Every milestone ends with its own sentinel, a ledger row and a commit; nothing here is a sentinel that has
not been printed.
