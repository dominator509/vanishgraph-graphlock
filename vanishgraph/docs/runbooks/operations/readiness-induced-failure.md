# Runbook — readiness induced-failure proof

**Purpose.** Prove, by execution, that the readiness endpoint discriminates a real dependency failure from a healthy
state — the VG-OPS-001 acceptance proof of SPEC-007 §7.4. A readiness check that has never been observed failing is not
evidence that it works.

**Command.** `sh scripts/induced-failure-readiness.sh` — sentinel `readiness induced failure: ok`.

**What it does, per declared dependency.**

1. **Control run.** Evaluate the six §7.2 probes through the real probe path and record each verdict. `postgresql` must
   report `PASS` with the session role verified as the tenant-scoped application role; a control run that cannot reach
   `PASS` means the dependency is not provisioned, and the row is recorded `ERROR` (DOD-033) with the provisioning
   attempt rather than being skipped.
2. **Induce exactly one failure.** The declared actions of §7.4 step 2: stop the PostgreSQL container (`postgresql`);
   `valkey-cli SHUTDOWN NOSAVE` (`valkey`); withhold worker heartbeats so the freshness window lapses (`job-worker`);
   revoke the probe credential or remove the probe object (`object-store`); stop the Keycloak frontend so discovery or
   the JWKS fetch fails (`keycloak-jwks`); force the provider transport to return an auth rejection
   (`provider-transport`).
3. **Induced run.** Within 10 s the same probe path must report `FAIL` with a classified `reasonCode`, the readiness
   gauge for that key must be `0`, `vanishgraph_dependency_probe_failures_total` must increment for that key, the
   `direction="TO_NOT_READY"` series must advance once per transition, and a `ReadinessChanged` record at
   `severity: ERROR` must carry the failing `dependencyKey` and the `reasonCode`. `/v1/live` must still answer `200` for
   the same instance — liveness is deliberately independent of every dependency.
4. **Remediate.** Undo the induction and assert readiness returns to `PASS` within 30 s.
5. **Verdict.** `DEMONSTRATED` only when the SAME probe path reported `PASS` before, `FAIL` after, and `PASS` after
   remediation. `DEFECT` when it reported `PASS` in both states (a probe that does not discriminate). `ERROR` for a
   dependency this environment cannot provision, `INCONCLUSIVE` for anything else — and the stage does not print its
   sentinel unless every dependency is `DEMONSTRATED`.

**Evidence.** `.agent/evidence/EP-008/induced-failure/`: `control.txt`, `induced.txt`, `remediated.txt` (one line per
dependency), `induction.txt` (the exact induction command and its output), `verdict.txt` (the table above).

**Containment and blast radius.** The `postgresql` induction stops the project's own test container
(`vanishgraph-ep003-postgres`) and starts it again immediately; the stage refuses to continue if the start fails, and
nothing else in the stack is touched. No production or shared environment is contacted, and no provider is written to:
the `provider-transport` probe is a read-only reachability check by specification, and §6.7 forbids a form write from a
probe.

**Resolution criteria.** The stage is satisfied when its sentinel prints. Until then the dependency rows it reports are
the work list: a `DEFECT` means the probe must be fixed, an `ERROR` means the dependency must be provisioned — and the
readiness endpoint must not be reported as proven while any of them stands.

**State of this repository, as measured.** Only `postgresql` is provisioned here; its induction is demonstrated
(`PASS` → `CONNECT_REFUSED` → `PASS`). `valkey`, `keycloak-jwks` and `provider-transport` are not provisioned (no
`VALKEY_URL`, no Keycloak, no provider entitlement); the `object-store` probe is not wired because no module in this
repository can sign an S3 request; and `job-worker` reports no fresh heartbeat because no worker process exists to write
one. **The sentinel has therefore NOT been printed**, and the readiness proof is incomplete.
