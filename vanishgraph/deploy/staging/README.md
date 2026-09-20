# Staging deployment (EP-009 M4)

**Status of this path: `EXTERNAL_REQUIRED` / `BLOCKED_CREDENTIALS`. No staging deployment has been performed, and
none is claimed.** `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md` declares staging as a managed US cloud in a
separate account requiring Kubernetes, KMS, an object store, managed PostgreSQL and a browser pool, with state
`NOT_PROVISIONED`. There is no `deploy/staging/` tree in this repository and no staging host, credential or
endpoint is reachable from this environment.

## What staging has to prove, and to what

An artifact-bound stage consumes an artifact, never a source tree (SPEC-008 §7 `VG-SHIP-021`, DOD-004). A staging
deployment is therefore only meaningful if it is described by the digest it deployed and if the verification
stage can read that digest back from the running system and compare it with the pinned one.

| step | command | what makes it honest |
|---|---|---|
| pin | `sh scripts/build-artifact.sh` then `sh scripts/artifact-identity.sh` | the digest is recorded in `.agent/verification/state/ARTIFACT_IDENTITY.json` and every digest is recomputed from the bytes on disk; a stale identity fails |
| deploy | `sh scripts/staging-deploy.sh` | deploys the pinned digest, reads it back, and prints `staging deploy: ok` only when they agree; it never falls back to a local deployment and never deploys a source tree |
| verify | `sh scripts/staging-verify.sh` | runs the artifact-bound smoke and E2E suites against the deployed digest, asserts the health surface SPEC-007 §7.1 declares, and performs one independent read-back through a second client (DOD-012) |
| teardown | operator procedure | the disposable staging stack is destroyed and the teardown is recorded; an undeleted stack is a cost and a credential that outlives its purpose |

## Why the two commands stop where they do

Both scripts exit non-zero with `BLOCKED_CREDENTIALS` and write their status — with the pinned digest, the
manifest row, the probe command and its exit code, the blocking dependency edge and a named next action — to
`.agent/evidence/EP-009/M4-staging-deploy.txt` and `M4-staging-verify.txt`. `gate-release.sh` requires a stage that
cannot execute to carry exactly those fields, which is why the blocked status is recorded rather than hidden.

**The plan's fallback is a different, labelled run.** When staging cannot be provisioned, the artifact-bound smoke
and E2E suites run against the exact digest in a `clean-local` environment, and both evidence sets carry their
environment fingerprint. That run is performed by `sh scripts/smoke-test.sh` and `sh scripts/test-e2e.sh` with
`VG_ARTIFACT_DIGEST` set to the pinned digest. Calling that run "staging" is the substitution SPEC-008 §7 forbids,
so the staging rows stay `BLOCKED_CREDENTIALS` and `RELEASE.md` states that staging verification is not claimed.

## Prerequisites before this path can run

1. A staging account with Kubernetes, KMS, an object store, managed PostgreSQL and a browser pool.
2. The platform credentials declared in `PREFLIGHT.md` and `.env.example` — **they are not declared today**,
   because no platform was ever provisioned; `sh scripts/config-validate.sh` will report their absence from the
   contract as `REQUIRED_KEY_UNDECLARED` as soon as they are read by code, and the operator must add the rows
   first.
3. `VG_STAGING_ENDPOINT` set to the staging ingress, which `scripts/staging-verify.sh` requires and never
   defaults.
4. **A health surface that matches the contract.** The clean-local artifact-bound smoke does not pass today:
   the running artifact answers `/v1/health` with a `status` field where SPEC-003 §5.17.1 requires
   `dependencyState`, reports three checks named `postgres`, `valkey` and `keycloak` where the contract names
   `postgresql`, `valkey`, `job-worker`, `object-store`, `keycloak-jwks` and `provider-transport`, and answers
   `/v1/live` and `/v1/startup` without the declared `dependencyState` vocabulary. Deploying to staging before
   that is fixed would verify a contract the artifact does not implement.
