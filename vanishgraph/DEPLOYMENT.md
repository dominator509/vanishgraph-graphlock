# DEPLOYMENT.md

Immutable artifact to staging; production deploy is MANUAL and unauthorized in this run.

This file states the deployment contract and the true status of every deployment path as of EP-009 M1.
**No deployment has been performed, and none is claimed.** There is no `deploy/` tree in this repository
(measured), so no deployment path below is described as existing code.

## The contract

1. **Deploy an immutable artifact pinned by digest, never a source tree and never a development server**
   (SPEC-008 VG-SHIP-021, DOD-004). The pin is the SHA-256 recorded in
   `.agent/verification/state/ARTIFACT_IDENTITY.json`, and the deployed bytes are verified against
   `dist/SHA256SUMS` before and after transfer.
2. **Verify the artifact before it is used**: `sh scripts/artifact-identity.sh` must print
   `artifact identity: ok` in the environment that will consume the artifact. A digest that does not
   resolve is a stop condition, not a warning.
3. **Validate the configuration before the artifact starts**, not after it fails: `PREFLIGHT.md` and
   `.env.example` are the declared contract, `config/environment/required.json` gives the exact required set
   for the environment class being deployed, and `sh scripts/config-validate.sh --environment <class> --file
   <env-file>` refuses a missing, empty, placeholder, malformed or out-of-enum value and refuses an unknown
   key. It prints key names and reason codes and never a value, so its output is safe to attach to a change
   record. A deployment that skips this step is deploying an environment nobody validated.
4. **Verify the dependencies the artifact needs** before declaring a deployment healthy:
   `sh scripts/induced-failure-readiness.sh` exercises every declared dependency's probe and prints
   `readiness induced failure: ok` only when each one's induced state was observed. That command proves the
   probes; it is not evidence that a deployment succeeded.
5. **Roll back by digest, not by rebuild**: the previous artifact digest is redeployed as-is. The procedure
   and its ownership are in `ROLLBACK.md`; the drill that proves it is EP-009 M6 and has not been run.
6. **Production deployment is a mandatory external gate** (SPEC-008 §9): manual only, performed and
   authorized by a named human operator (VG-SCOPE-009). An agent may not perform it, simulate it, or record
   it as done. It is unauthorized in this run.

## Continuous integration

`.github/workflows/ci.yml` mirrors `scripts/verify.sh`'s fifteen stages and adds the artifact build, the
SBOM/provenance check and a digest-keyed artifact upload; `sh scripts/ci-guard.sh` validates it structurally,
including that no construct in it can hide a failure and that its stage order cannot contradict the local gate.
**The pipeline has never run remotely.** The declared observation credentials (`GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`) are unprovisioned, so remote observation is
`BLOCKED_CREDENTIALS` with the probe evidence in `.agent/evidence/EP-009/M3-ci-pipeline.txt`. Two stages would
fail today by design — `live-fire` is a placeholder owned by EP-010 and `smoke`/`e2e` need the digest binding of
EP-009 M4 — so a green pipeline is not claimed and must not be reported until it is observed.

## Status of each path

| path | status | reason and next action |
|---|---|---|
| staging deployment | **EXTERNAL_REQUIRED — not attempted** | No staging host, credential or endpoint was reachable in this environment, so no probe of the target exists. EP-009 M4 owns it: it must record either the pinned digest it deployed and the artifact-bound verification output, or `BLOCKED_CREDENTIALS` with the probe evidence. Until then no staging claim may appear in any gate or report. |
| artifact-bound smoke / E2E / live-fire | **OWED** | These stages require the artifact to be installed and run against real dependencies (EP-009/EP-010). `RELEASE.md` records them as owed; source-level tests cannot satisfy them (VG-SHIP-022). |
| production deployment | **MANUAL, UNAUTHORIZED in this run** | Requires a named authorized operator; the procedure contains no executable deployment and no credential is present. |
| rollback | **OWED** | `ROLLBACK.md` holds the procedure; EP-009 M6 owns the drill that demonstrates it, including the evidence that no drill artefact is left in the working tree. |
| backup and restore | **OWED** | A real backup/restore drill is EP-009 M6 work; retention deletion propagation could not be demonstrated in this environment and is recorded as `BLOCKED_ENVIRONMENT` in the EP-008 evidence. |
| disaster recovery | **OWED** | Same ownership as rollback; no DR run has been executed. |

## What a deployment would have to prove, and what would falsify it

A deployment may be reported as verified only when all of the following are recorded for the exact digest
that was deployed: the artifact identity check passing in the target environment; the deployed bytes matching
`dist/SHA256SUMS`; the dependency probes reporting their true states; and the artifact-bound smoke run
passing against the deployed artifact. A digest mismatch, a missing format, a probe that cannot distinguish
its induced state, or a stage that prints a sentinel without running falsifies the deployment claim — and
under VG-SHIP-033 a placeholder must fail loudly rather than print a success sentinel.
