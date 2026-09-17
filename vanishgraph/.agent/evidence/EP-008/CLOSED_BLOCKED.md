# EP-008 CLOSED_BLOCKED — structured report

**Node:** EP-008 (Observability and Operations). **Date of this report:** end of round 172. **Graph position:**
`sh scripts/graph-next.sh` names **EP-008** and will keep naming it; no `NODE_DONE` row was written and no `green/EP-008`
tag exists.

## The one blocking condition

**`provider-transport` cannot be induced in this environment because no provider entitlement exists, and the row is
`EXTERNAL_REQUIRED` rather than unprovisioned by the implementer.**

MEASURED, not asserted (`sh` output captured in `.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt`):

```
stripe          https://api.stripe.com/v1/balance       HTTP 401
postal_api      https://api.lob.com/v1/us_verifications HTTP 401
search_api_key  https://serpapi.com/account             HTTP 401
```

All three declared transports are reachable and all three answer **401 without a credential** — which §7.4 step 2 names
as the **induced** state. A transport with no credential is therefore permanently in the state the specification calls
failed, so the control run cannot reach `PASS` and no transition can be demonstrated. A locally hosted stand-in would
report a pass for a dependency that is *defined as the provider*, not as a server this repository controls; that
reasoning, and the verdict vocabulary that would be needed to make a stand-in legitimate, is in
`.agent/evidence/EP-008/M5-standin-decision.txt`.

**Next action (a person or an environment, not code):** obtain a provider entitlement — an official-transport credential
for one of the declared transports (`STRIPE_SECRET_KEY`, `LOB_API_KEY`/`CLICK2MAIL_API_KEY`/`POSTGRID_API_KEY`, or
`SEARCH_API_KEY`) — set it, and re-run `sh scripts/induced-failure-readiness.sh`. The row then moves from `ERROR` to a
demonstrable transition with no code change.

## What is delivered, and by what evidence

| milestone | status | sentinel / evidence |
|---|---|---|
| M1 telemetry identity | `MILESTONE_PASS` (`b7f76cd`) | `test-unit: ok`, `lint: ok`, suite 35/35, `grep -c RESOURCE_ATTR_MISSING` = 9 |
| M2 DLP scrub + canary | `MILESTONE_PASS` (`c11a997`) | `canary egress: ok`, disabled-rule control failed naming class + field path |
| M3 structured log contract | `MILESTONE_PASS` (`5702c79`) | `log contract: ok`, four-defect negative control |
| M4 metric catalogue | `MILESTONE_PASS` (`0cdc587`) | `metrics catalogue: ok`, 42 families, suites 34/34 and 11/11 |
| M5 readiness | **PARTIAL** (three notes, then five of six demonstrated) | `postgresql`, `valkey`, `job-worker`, `object-store`, `keycloak-jwks` DEMONSTRATED; **`readiness induced failure: ok` NOT printed** |
| M6 alerts | delivered, one proof `NOT_RUN` | `alert catalogue: ok`; 20 rows, 17 runbooks, suite 16/16; induced fire-and-resolve `NOT RUN` (no evaluator, no series store) |
| M7 SLOs | `MILESTONE_PASS` (`d2caf3b`) | `slo: evaluated`; five verdict lines, four `DEFERRED_LONG_RUNNING` and one `INCONCLUSIVE` |
| M8 retention/access | `MILESTONE_PASS` (`cc4cc90`) | `retention config: ok`; propagation rows `BLOCKED_ENVIRONMENT` |
| M9 node gate | gate written and green | `gate-observability: ok`, exit 0, evidence index 68 files, readiness row reported `BLOCKED_ENVIRONMENT` with its required fields and next action |

## Why this is a report and not a tag

M9's EXPECT clause permits closing when a blocked row carries its required fields and a named next action; M9's
**FALLBACK** clause says that when a mandatory sub-gate cannot pass because an environment is incomplete **the node stays
open** and **tagging on a partial gate is prohibited**. The induced-failure stage *is* a mandatory sub-gate and its
sentinel is not printed, so the FALLBACK governs. This report is the "finding reported with its taxonomy status" that
the FALLBACK requires.

## Standing facts that must not be misreported downstream

- `.agent/verification/state/RELEASE_GATE.json` is `{"verdict":"INCONCLUSIVE","reason":"FORGE_ONLY"}` and this node
  cannot change it.
- **No alert has been demonstrated firing or resolving**; **no SLO objective has ever been reported `PASS`**; the
  effectiveness ratio has never been published from a live run.
- **No deletion has been observed executing**; the retention propagation rows are `BLOCKED_ENVIRONMENT`.
- **CI has never run** (`.github/workflows/` is empty; no `CODEOWNERS`).
- The coverage layer table does not measure the EP-008 observability modules (`config/testing/coverage-thresholds.json`
  is outside EP-008 §6 and was not edited).
- Specification conflicts recorded as data rather than resolved: §6.1's canonical label list vs §6.3–§6.5's per-metric
  labels; §8's coverage rule 1 vs its own severity column (six rows); §7.2's per-probe timeouts summing to 1800 ms
  against a 1500 ms budget.

## What a later round should do first

1. Provision a provider credential and re-run the readiness stage — that alone unblocks EP-008's close.
2. Then M9's close-out: `NODE_DONE` for EP-008, the `green/EP-008` tag, and the residual polish (the gate summary's
   spacing, the object-store induced value reading `UNKNOWN`, the `reason_code` per-family enforcement already done).
3. Then EP-009 (release and ship) and EP-010 (final accounting).
