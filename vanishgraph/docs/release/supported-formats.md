# Supported artifact formats

The declared format set for this repository, per EP-009 §7.2, derived from **measured** discovery
(`.agent/evidence/EP-009/M1-discovery.txt`). Every declared format is produced by
`sh scripts/build-artifact.sh` with a recorded digest; a format declared here and not produced, or
produced but not digest-pinned, is a `FAIL` of DOD-003.

## Declared and producible

| # | format | exact build command | output path pattern | digest | consumer |
|---|---|---|---|---|---|
| 1 | Package tarball (`npm pack`) | `npm pack --pack-destination dist` | `dist/vanishgraph-<version>.tgz` | SHA-256 | the installable surface a consumer installs; `scripts/install.sh` installs it |
| 2 | Software bill of materials | `npm sbom --sbom-format cyclonedx` | `dist/vanishgraph-<version>.cdx.json` | SHA-256 | dependency-closure evidence; the M7 release gate reads it |
| 3 | Build provenance | `sh scripts/build-artifact.sh` (records tool and source identity) | `dist/provenance.json` | SHA-256 | `scripts/artifact-identity.sh`; the §7.3 identity fields |
| 4 | Checksums | `sh scripts/build-artifact.sh` | `dist/SHA256SUMS` | SHA-256 of each entry | every downstream stage verifies against it; `scripts/artifact-identity.sh` resolves them |

**Toolchain, measured:** `node v24.14.1`, `npm 11.11.0`, `git` present, `docker 29.7.2`.

## Declared in §7.2 and NOT producible here — recorded, never silently dropped

| # | format | status | reason | next action |
|---|---|---|---|---|
| 5 | OCI container image per declared service role | **`BLOCKED_ON_IMPLEMENTATION`** | A container runtime IS available (`docker 29.7.2`, measured), so the environment is not the blocker. **The repository contains no `Dockerfile` and no container build definition** (`git ls-files | grep -i dockerfile` returns nothing), and EP-009 §6's expected-changed-files list contains no such file, so this node has nothing to build an image FROM. | Add a container build definition (one per declared service role, or one image with a role selector), then produce and digest-pin the images. Until then no test, deployment or evidence path may reference an image. |

**THIS IS NOT A CLAIM THAT CONTAINER DELIVERY WORKS.** §7.2's rule is followed exactly: the format is
recorded with its exact taxonomy status rather than dropped, a format may not be declared supported
without being produced, and no later gate may represent an image as "the artifact".

## What the deployment targets consume

**There is no `deploy/` tree in this repository (measured: `Get-ChildItem deploy` returns nothing), so no
deployment path is claimed here as existing.** What the declared formats are for is fixed by the spec: an
artifact-bound stage consumes the artifact, never a source tree (SPEC-008 VG-SHIP-021). The M4 staging
deployment and the M6 rollback/restore drills own the procedures, and production deployment is manual-only
and authorized by an external participant (SPEC-008 §9, VG-SCOPE-009) — an agent may not perform or
simulate it.

| consumer (present or owed) | consumes | notes |
|---|---|---|
| `scripts/artifact-identity.sh` | every digest | present; prints `artifact identity: ok` only when every §7.3 field is populated and every digest resolves against the bytes on disk |
| `scripts/install.sh` | the tarball | present; M5 owns executing the published install and upgrade commands as written (VG-SHIP-029) |
| the M7 release gate | every declared format plus its digest | **OWED — the script does not exist yet.** A declared format that is missing, empty, or unhashed must fail that gate; until it exists no `gate-release` sentinel exists and none is claimed |
| the M4 staging verification | the tarball plus `SHA256SUMS` plus the SBOM and provenance | **OWED and `EXTERNAL_REQUIRED`**: no staging host, credential or endpoint was reached in this environment, so no deployment is claimed |

## Reproducibility

`sh scripts/build-reproducibility.sh` builds the declared formats twice and requires **byte-identical**
outputs, except for formats with documented non-determinism whose reconciliation is recorded in
`ARTIFACT_IDENTITY.json` rather than assumed. The two builds run from **one verified-clean tree** into two
scratch output directories (`${TMPDIR}/vg-repro-<pid>/{a,b}`), which is a recorded deviation from §3's
wording "two clean checkouts of the same commit": a second checkout of the lockfile-carrying tree would
need its own dependency installation (in an offline environment, from a warm cache) for `npm sbom` to see
the dependency closure, so a same-tree double build is what is measured here. **What this does exercise:**
output-path independence, container-metadata non-determinism, and the identity document itself. **What it
does not exercise:** dependence of the build on the absolute path of the source directory. That gap is
recorded, not hidden, and closes only with a second checkout that can install its own dependencies.
