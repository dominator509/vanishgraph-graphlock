# RELEASE.md

Release requires exact artifact, DOD, registry, evidence and truthful verdict.

This file states what this repository can and cannot claim about a release, as of EP-009 M1. Nothing here
is a ship verdict: the verdict document `.agent/verification/state/RELEASE_GATE.json` remains
`{"verdict":"INCONCLUSIVE","reason":"FORGE_ONLY"}` and no node before the release node may change it.

## The release artifact

The declared format set is `docs/release/supported-formats.md`; the §7.3 identity is
`.agent/verification/state/ARTIFACT_IDENTITY.json`. Both are produced by commands that print a sentinel
only on genuine success:

| command | sentinel | what it refuses to do |
|---|---|---|
| `sh scripts/build-artifact.sh` | `artifact: built` | refuses to build from a tree whose source is not committed (an artifact that cannot be described by a commit SHA cannot be bound to a test), and refuses to print the sentinel if any declared format is missing or empty |
| `sh scripts/build-reproducibility.sh` | `artifact reproducible: ok` | refuses to print the sentinel if the two builds differ in content, if the SBOM closure differs after canonicalization, if provenance or the deterministic checksums differ, or if the scratch builds modified the published identity |
| `sh scripts/artifact-identity.sh` | `artifact identity: ok` | refuses to print the sentinel if any §7.3 field is empty, if any recorded digest does not resolve against the bytes on disk, if the recorded commit is not an ancestor of HEAD, or if the artifact's source surface has changed since it was built (a STALE identity) |

A digest that is written down is a claim; a digest that resolves is evidence. `artifact identity: ok` means
every digest in the identity was recomputed from the file on disk during that run.

## What is NOT claimed

- **Container image: not produced, and container-format support is NOT claimed.** SPEC-008 §7.2 names an
  OCI image per declared service role. A container runtime is available (`docker 29.7.2`, measured), so the
  environment is not the blocker: the repository contains no `Dockerfile` and no container build
  definition. The format is recorded as `BLOCKED_ON_IMPLEMENTATION` with a named next action in
  `docs/release/supported-formats.md`. No gate, test, document or evidence path in this repository may
  represent an image as the artifact.
- **The artifact is unsigned.** No signing key and no managed KMS exist in this environment (ADR-006
  open), so the identity records `signature.status = EXTERNAL_REQUIRED` and describes the artifact as
  unsigned rather than representing it as signed.
- **No deployment has been performed.** No staging or production host, credential or endpoint was reached.
- **No published install or upgrade command has been executed yet** (EP-009 M5 owns that, and DOD-023
  requires the published commands to be executed exactly as written).
- **The mandatory external gates are unsigned** (SPEC-008 §9): human UAT of the golden path, assistive-
  technology validation, legal/compliance review, hardware/HSM assessment where applicable, and production
  deployment authorization. Until they are signed the verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES`;
  here it is `INCONCLUSIVE`.
- **No live-fire or artifact-bound smoke/E2E result exists**, because those stages require the artifact to
  be installed and run (EP-009/EP-010), not merely built.

## Measured release state

The measurements taken for this milestone — the three sentinels, the tarball digest, the container digests
of the two builds and their reconciliation, and the identity digest before and after the reproducibility
run — are recorded in `.agent/evidence/EP-009/M1-reproducibility.txt`, in
`.agent/verification/state/ARTIFACT_IDENTITY.json`, and in the `EP-009` rows of
`.agent/state/LEDGER.md`. Those files are the record; this file does not restate numbers that a later
rebuild would silently invalidate.

## Release checklist, with its true status

| item | status |
|---|---|
| Declared format set produced with digests | PASS for the four producible formats (EP-009 M1) |
| Reproducible build | PASS with a recorded reconciliation for tar-container metadata and SBOM run identifiers (EP-009 M1) |
| Artifact identity populated and every digest resolvable | PASS (EP-009 M1) |
| Artifact signature | EXTERNAL_REQUIRED (ADR-006 open) |
| Container image | BLOCKED_ON_IMPLEMENTATION (no build definition exists) |
| Configuration validated before startup | OWED (EP-009 M2) |
| CI pipeline executed | OWED (EP-009 M3); CI has never run in this repository |
| Staging deployment and artifact-bound verification | OWED, EXTERNAL_REQUIRED (EP-009 M4) |
| Published install and upgrade commands executed | OWED (EP-009 M5) |
| Rollback, upgrade, backup/restore drills | OWED (EP-009 M6) |
| Release gate | OWED (EP-009 M7); the verdict stays INCONCLUSIVE/FORGE_ONLY until the external gates are signed |
