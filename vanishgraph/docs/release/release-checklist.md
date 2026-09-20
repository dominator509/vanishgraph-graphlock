# Release checklist

Every line below names a command, an artifact or a decision owner. No line is a sentiment. The verdict document
`.agent/verification/state/RELEASE_GATE.json` remains `{"verdict":"INCONCLUSIVE","reason":"FORGE_ONLY"}` and this
checklist may not change it: the release verdict is produced only by EP-010's ship gate.

## 1. Pre-conditions

| # | pre-condition | how it is checked | owner |
|---|---|---|---|
| 1 | A clean tree, because an artifact must be described by a commit | `git status --porcelain` (the build refuses otherwise) | release operator |
| 2 | The declared configuration contract satisfied | `sh scripts/config-validate.sh` → `config: ok` | release operator |
| 3 | The pipeline definition cannot mask a failure and cannot drift from the local gate | `sh scripts/ci-guard.sh` → `ci pipeline: ok` | release operator |
| 4 | The external signatures of SPEC-008 §9 | named participants; **unsigned today** | business, counsel, AT practitioner, authorized operator |

## 2. The gate sequence, in order, with its sentinels

```sh
sh scripts/config-validate.sh
sh scripts/ci-guard.sh
sh scripts/build-artifact.sh
sh scripts/build-reproducibility.sh
sh scripts/artifact-identity.sh
sh scripts/install.sh
```

Each prints its own sentinel — `config: ok`, `ci pipeline: ok`, `artifact: built`, `artifact reproducible: ok`,
`artifact identity: ok`, `install: ok` — and the release gate refuses a stage that exits zero without printing
one. `scripts/gate-release.sh` runs this sequence plus the drills and the staging pair; a stage that cannot
execute must carry a taxonomy status with its required fields, a dependency edge and a named next action.

**The staging pair is `BLOCKED_CREDENTIALS` today** (the environment is `NOT_PROVISIONED`, measured in
`deploy/staging/README.md`), so the block below is marked as requiring operator credentials and is not executed by
`sh scripts/published-commands.sh`:

```sh
# requires operator credentials:
#   VG_STAGING_ENDPOINT plus the staging platform credentials, which PREFLIGHT.md does not yet declare
sh scripts/staging-deploy.sh
sh scripts/staging-verify.sh
```

## 3. Evidence required before a deploy decision

| evidence | where |
|---|---|
| artifact identity with every digest resolved | `.agent/verification/state/ARTIFACT_IDENTITY.json` |
| reproducibility with the container reconciliation | the same file, `reproducibility` |
| install record: version, digest, destination, dependency supply | `.agent/evidence/EP-009/M5-install.txt` |
| artifact-bound smoke result (currently FAILING, with 20 conformance findings) | `.agent/evidence/EP-009/M4-artifact-smoke.txt` |
| staging status | `.agent/evidence/EP-009/M4-staging-deploy.txt`, `M4-staging-verify.txt` |
| the milestone ledger with every measurement | `.agent/state/LEDGER.md` |

## 4. Rollback trigger and decision owner

**Trigger:** any of the following, observed after a deployment — the artifact digest read back from the running
system differs from the pinned digest; readiness reports `NOT_READY` for a required dependency that passed before
the deployment; a smoke or E2E stage fails against the deployed digest; or the operator judges the deployment's
effect unacceptable.

**Decision owner:** the authorized operator on call. The rollback itself is mechanical: redeploy the previous
pinned digest, then verify the same way it was verified before. The procedure is `ROLLBACK.md`, and the drill
evidence is under `.agent/evidence/EP-009/drills/`.

## 5. Production deployment

**`MANUAL_ONLY`.** Production deployment is unauthorized in this run and may not be performed, simulated or
recorded by an agent: it requires a named authorized operator (SPEC-008 §9, `VG-SCOPE-009`, ADR-005). The
procedure is `deploy/production/README.md` and it contains no automation an agent could invoke.
