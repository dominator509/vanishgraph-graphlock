# Supported artifact formats

The declared format set for this repository, per EP-009 §7.2, derived from **measured** discovery
(`.agent/evidence/EP-009/M1-discovery.txt`). Every declared format is produced by
`sh scripts/build-artifact.sh` with a recorded digest; a format declared here and not produced, or
produced but not digest-pinned, is a `FAIL` of DOD-003.

## Declared and producible

| # | format | exact build command | output path pattern | digest | consumer |
|---|---|---|---|---|---|
| 1 | Package tarball (`npm pack`) | `npm pack --pack-destination dist` | `dist/vanishgraph-<version>.tgz` | SHA-256 | `scripts/install.sh`; the installable surface a consumer installs |
| 2 | Software bill of materials | `npm sbom --sbom-format cyclonedx` | `dist/vanishgraph-<version>.cdx.json` | SHA-256 | `scripts/gate-release.sh`; dependency-closure evidence |
| 3 | Build provenance | `sh scripts/build-artifact.sh` (records tool and source identity) | `dist/provenance.json` | SHA-256 | `scripts/artifact-identity.sh`; the §7.3 identity fields |
| 4 | Checksums | `sh scripts/build-artifact.sh` | `dist/SHA256SUMS` | SHA-256 of each entry | `scripts/gate-release.sh`; every downstream stage verifies against it |

**Toolchain, measured:** `node v24.14.1`, `npm 11.11.0`, `git` present, `docker 29.7.2`.

## Declared in §7.2 and NOT producible here — recorded, never silently dropped

| # | format | status | reason | next action |
|---|---|---|---|---|
| 5 | OCI container image per declared service role | **`BLOCKED_ON_IMPLEMENTATION`** | A container runtime IS available (`docker 29.7.2`, measured), so the environment is not the blocker. **The repository contains no `Dockerfile` and no container build definition** (`git ls-files | grep -i dockerfile` returns nothing), and EP-009 §6's expected-changed-files list contains no such file, so this node has nothing to build an image FROM. | Add a container build definition (one per declared service role, or one image with a role selector), then produce and digest-pin the images. Until then no test, deployment or evidence path may reference an image. |

**THIS IS NOT A CLAIM THAT CONTAINER DELIVERY WORKS.** §7.2's rule is followed exactly: the format is
recorded with its exact taxonomy status rather than dropped, a format may not be declared supported
without being produced, and no later gate may represent an image as "the artifact".

## What the deployment targets consume

| target | consumes | notes |
|---|---|---|
| `deploy/staging/` | the tarball plus `SHA256SUMS` plus the SBOM and provenance | artifact-bound verification compares the digest it deployed with the digest in `ARTIFACT_IDENTITY.json`; a mismatch fails the stage |
| `deploy/production/` | the same set | the procedure is manual-only and contains no executable deployment (EP-009 §7.7) |
| `scripts/gate-release.sh` | every declared format plus its digest | a declared format that is missing, empty, or unhashed fails the gate |
| `scripts/artifact-identity.sh` | every digest | it prints `artifact identity: ok` only when every §7.3 field is populated and every digest resolves |

## Reproducibility

`sh scripts/build-reproducibility.sh` builds the declared formats twice from two clean checkouts of the
same commit and requires **byte-identical** outputs. A format with documented non-determinism is either
made reproducible or removed from this set with a recorded rationale here; the reconciliation for any
accepted exception is recorded in `ARTIFACT_IDENTITY.json`, never assumed.
