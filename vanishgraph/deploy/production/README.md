# Production deployment — MANUAL ONLY

**Production deployment is unauthorized in this run.** It may not be performed, simulated, or recorded as done by
an agent, by automation, or by this repository's own gates: it requires a named authorized operator
(SPEC-008 §9, `VG-SCOPE-009`, ADR-005). This document exists so that the procedure is written down and reviewable;
it contains **no automation an agent could invoke**, and no credential.

## Who may perform it

A named authorized operator, recorded with the deployment's date, the artifact digest deployed, the evidence they
reviewed, and any unresolved findings. The authorization is a mandatory external gate: until it is signed, the
release verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES`, and today it is `INCONCLUSIVE` with reason
`FORGE_ONLY`.

## Pre-conditions, all of them

1. A release whose artifact identity resolves: `sh scripts/artifact-identity.sh` printed
   `artifact identity: ok` for the exact digest being deployed.
2. The release gate's own record: `sh scripts/gate-release.sh` printed `gate-release: ok`, with every stage that
   could not execute carrying a taxonomy status, a dependency edge and a named next action.
3. Staging verification completed **against the same digest** — or a signed statement that staging verification is
   not claimed. It is **not** claimed today.
4. The external signatures of SPEC-008 §9: human UAT of the golden path, assistive-technology validation,
   legal/compliance review, and hardware/HSM assessment where applicable. **None is signed today.**
5. A restore point: the backup path was exercised by `sh scripts/backup-restore-drill.sh` and its evidence is
   under `.agent/evidence/EP-009/`, so a rollback has somewhere to roll back to.

## The procedure

1. Retrieve the artifact whose digest matches the release record. Verify the digest **before** transfer and
   **after** transfer: `sha256` of the tarball against `.agent/verification/state/ARTIFACT_IDENTITY.json`, and the
   per-file entries in `dist/SHA256SUMS`.
2. Deploy the artifact, pinned by digest, to the production environment. Never deploy a source tree and never a
   development server (SPEC-008 §7 `VG-SHIP-021`).
3. Validate the configuration **in the target environment before starting the artifact**:
   the declared contract is `PREFLIGHT.md` and `config/environment/required.json` for the `production` class, and
   `sh scripts/config-validate.sh --environment production --file <env-file>` refuses a missing, empty,
   placeholder, malformed or out-of-enum value and refuses an unknown key. It prints key names and reason codes
   and never a value, so its output is safe to attach to the change record.
4. Read the deployed digest back from the running system and compare it with the pinned digest. A mismatch is a
   stop condition and a rollback trigger.
5. Check the health surface: `/v1/live`, `/v1/startup`, `/v1/ready` and `/v1/health`. **Known blocker: the
   running service's health surface does not implement the contract SPEC-003 §5.17 declares** (measured
   divergences in `.agent/evidence/EP-009/M4-artifact-smoke.txt`), so a production check of that surface cannot
   pass until the contract is implemented. This is why production deployment is not merely unauthorized today but
   inadvisable.
6. Run the artifact-bound smoke against the deployed digest, then record: the digest, the reading of each health
   endpoint, the operator's name, and the time.

## Rollback trigger

Roll back by redeploying the previous pinned digest as-is — never by rebuilding — when: the read-back digest
differs; `/v1/ready` reports `NOT_READY` for a required dependency that passed before the deployment; the smoke
stage fails against the deployed digest; or the operator judges the effect unacceptable. The decision owner is the
authorized operator on call. The procedure is `ROLLBACK.md`; the drill evidence is under
`.agent/evidence/EP-009/drills/`, and **a rollback to a previous version has never been demonstrated** because
only one artifact version exists (recorded as `BLOCKED_ON_IMPLEMENTATION` in
`.agent/evidence/EP-009/M6-rollback.txt`).

## What this document must never become

A script. If a step here can be executed by a machine, it belongs in `scripts/` where the gates can check it; this
document is the part a human must do, and the part no agent may claim to have done.
