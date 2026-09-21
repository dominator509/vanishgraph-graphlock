# The first `/v1/health` answered 503 on a healthy dependency, and the cause was a module load (EP-010 M28)

## What was observed, not inferred

`scripts/smoke-test.sh` ran against the artifact built at commit `820dfafe` three times. Two runs printed
`smoke test: ok`. The third failed, and this is its output verbatim:

    smoke test: readiness 200 dependencyState=READY with 6 declared check(s): postgresql=true valkey=true
      job-worker=false(MISCONFIGURED) object-store=true keycloak-jwks=true provider-transport=false(MISCONFIGURED)
    smoke test: FAIL - /v1/health answered 503 with dependencyState "UNHEALTHY" and degraded
      ["job-worker","provider-transport"]: postgresql=true valkey=false job-worker=false object-store=true
      keycloak-jwks=true provider-transport=false

Read that pair carefully, because the ORDER is the whole finding: `/v1/health` is the FIRST request the smoke makes and
it answered 503 UNHEALTHY with `valkey=false`; `/v1/ready` came a moment later and answered **200 READY** with
`valkey=true`. The dependency was reachable in both cases. Something about the FIRST evaluation was different.

## The measurement that identified it

The Valkey probe's declared action ran standalone, on ten fresh connections, timed end to end:

    call 1: 21.5 ms ... call 10: 6.6 ms   (min 5.6 ms, median 6.6 ms, max 21.5 ms; declared §7.2 budget: 200 ms)

Every connection was fast, so the connection was never the problem. That run loaded the driver BEFORE timing, which is
exactly what the probe did not do. Re-measured in a fresh process with the driver load INSIDE the timed action, the way
`src/infrastructure/observability/dependency-clients.ts` performed it:

    call 1: TOTAL 205.0 ms (import 176.0 ms, probe action 29.0 ms) -> EXCEEDS the declared 200 ms budget
    call 2: TOTAL  21.8 ms (import   0.2 ms, probe action 21.6 ms) -> inside budget
    call 3: TOTAL  15.5 ms (import   0.1 ms, probe action 15.3 ms) -> inside budget

`await import('ioredis')` sat inside the round-trip closure, so **the module load was charged to the dependency's
declared 200 ms budget**. The first call landed at ~205 ms, `runProbe` classified it TIMEOUT, and SPEC-007 §7.2 does not
retry a TIMEOUT - so the first `/v1/health` reported UNHEALTHY. The next evaluation was 15-22 ms and passed.

## The correction

The driver is loaded ONCE by a memoized loader, and `main.ts` awaits `warmUpDependencyClients()` BEFORE it listens, so
no request can be charged for a module load. A structural regression test pins both halves: exactly one dynamic import
in the module, it lives in the loader rather than in the probe closure, it is memoized, and the composition root awaits
the warm-up before `await listen(app`.

## Why this is recorded rather than quietly fixed

The failure was intermittent (about one boot in three), it appeared as a DEPENDENCY failure while the dependency was
idle and healthy, and the only reason it was found at all is that the smoke run was repeated and that its diagnostic
output was widened to name the failing dependency - the first version printed `/v1/health answered 503` and nothing
else, which says nothing about which dependency to look at. A readiness probe may report a dependency that is genuinely
too slow. It may not report one that is fine because the service had not finished loading its own driver.
