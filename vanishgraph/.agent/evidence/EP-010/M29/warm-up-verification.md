# The readiness surface verified end to end against the artifact, and the cold-start defect that hid it (EP-010 M29)

Artifact under test: `sha256:371fe881dc40f0d9c0f31cb7321f2d2df68c5f437ded3d765c7912b772df4c57`,
built at commit `5089dcb5`, declared to `scripts/smoke-test.sh` through `VG_ARTIFACT_DIGEST`.

## The result, six consecutive runs

    run 1 exit=0 : readiness 200 dependencyState=READY with 6 declared check(s): postgresql=true valkey=true
                   job-worker=false(MISCONFIGURED) object-store=true keycloak-jwks=true provider-transport=false(MISCONFIGURED)
    run 2 exit=0 : (identical)
    run 3 exit=0 : (identical)
    run 4 exit=0 : (identical)
    run 5 exit=0 : (identical)
    run 6 exit=0 : (identical)
    passing runs: 6/6

`/v1/health`, `/v1/live`, `/v1/startup` and `/v1/ready` answered as SPEC-003 §5.17.1-4 declare, an unauthenticated
scoped request was refused 401, and the fingerprint was written (`smoke test: fingerprint sha256 ...`).

The readiness body names **all six** declared dependencies, which is what SPEC-007 §7.2 requires. The two that report
`false` are `job-worker` and `provider-transport`, both `required: false` for the web role
(`config/environment/required.json` `service_roles.web`), and both report the closed reason code `MISCONFIGURED`
because this process has no heartbeat store and no declared provider transport - they are REPORTED rather than
omitted, which is the rule. Their failure does not force `NOT_READY`, and `/v1/health` answers 200 `DEGRADED` for the
same reason.

## The path to it, because the first two attempts were wrong

1. The readiness body named four checks instead of six. `toDependencyProbes` skipped a dependency with no client; it now
   delegates to `createProbeRunner`, whose own rule is that a missing client is `UNKNOWN`/`MISCONFIGURED`.
2. `/v1/ready` then reported `object-store` and `keycloak-jwks` unreachable while the same values were present in the
   gate's shell. `scripts/smoke-test.sh` sourced the state files into SHELL variables and never exported them, so the
   artifact - a CHILD process - could not see them. Measured both ways on one artifact: unexported -> 503 with two
   required dependencies failing; exported -> READY with all four required checks passing.
3. `/v1/health` then answered 503 on the FIRST evaluation of about one boot in three, with `valkey=false` and READY a
   moment later. Two causes, both measured:
   - the valkey probe loaded `ioredis` inside its own closure: 205.0 ms total for the first call, of which 176.0 ms was
     the module load, against a 200 ms budget;
   - the first evaluation after boot costs 144-201 ms per dependency (TLS handshakes, the pool's first connection and
     socket setup contending on one event loop) while the second costs 15-30 ms.
   `main.ts` now loads the drivers and evaluates every probe once BEFORE it listens, and discards that verdict on
   purpose; every request still evaluates every dependency with its own §7.2 budget.

## What this does not claim

`job-worker` and `provider-transport` remain unwired for this role: they are reported as `MISCONFIGURED`, not as
healthy. The smoke boots the artifact inside the repository tree and resolves its dependencies from the lockfile-installed
`node_modules`, because this environment is offline; a clean-room `npm install <tarball>` is VG-SHIP-028 work and is not
claimed here. `scripts/verify.sh` still cannot print its sentinel - `test-e2e` needs a browser runtime and `live-fire`
needs named external participants - and the five external gates remain unsigned.
