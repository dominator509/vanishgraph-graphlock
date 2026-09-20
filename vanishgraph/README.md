# vanishgraph

Removal verification and evidence for exposed personal data. The product's rule is stated in
`PROJECT_BRIEF.md`: **software that appears to work is a failure state**, and only
`VERIFIED_REMOVED` — an independent observation inside the declared window — asserts that something was removed.

## What is in this repository

| path | what it is |
|---|---|
| `src/` | the domain, application, adapter and HTTP layers, run directly by Node 24's TypeScript type stripping |
| `ui/` | the portal and console surfaces, built by Vite, exercised by Playwright |
| `db/` | migrations, the seed fixture and the upgrade matrix |
| `config/` | the declared configuration: telemetry, metrics catalogue, dashboards, alerts, SLOs, retention, environment schema |
| `scripts/` | every gate, every installer and every drill; each prints a sentinel only on genuine success |
| `docs/` | runbooks, release procedure, supported artifact formats |
| `.agent/` | the blueprint pack's own state: ledger, evidence, specifications, verification state. **Not shipped**: it is outside the package `files` allowlist |

## Prerequisites

- Node 24 or newer (the sources are TypeScript and run through type stripping).
- `sh` (POSIX shell), `tar`, `git`.
- For the gates that need them: Docker (disposable PostgreSQL, Valkey, MinIO, Keycloak) and a Playwright
  browser runtime.

## Install

```sh
sh scripts/build-artifact.sh
sh scripts/artifact-identity.sh
sh scripts/install.sh
```

`build-artifact.sh` produces the declared formats under `dist/` and publishes the artifact identity;
`artifact-identity.sh` recomputes every recorded digest from the bytes on disk and prints `artifact identity: ok`
only when they all resolve; `install.sh` verifies the tarball's digest **before** installing it, unpacks it to a
destination outside the repository, and prints `install: ok`. Set `VG_INSTALL_DIR` (or pass `--dir <path>`) to
choose the destination; the default is `${TMPDIR:-/tmp}/vanishgraph-install`.

### Installing in a virgin environment (the clean-room path)

A clean room receives the artifact and its checksums and nothing else, so it cannot read the repository's identity
document. The shipped installer therefore accepts the artifact and its expected digest directly — the same command
the clean-room procedure runs:

```sh
sh scripts/install.sh --artifact dist/vanishgraph-0.1.0.tgz --digest sha256:<digest from dist/SHA256SUMS> --dir /opt/vanishgraph
```

`sh scripts/clean-room.sh` performs that whole procedure in a zero-state directory: it transfers the artifact by
digest, verifies it against the transferred `SHA256SUMS`, installs it with the shipped installer, boots the
installed package, completes the unauthenticated golden path, and then lists **everything it had to supply beyond
this document** with each item classified `DOCUMENTED` or `UNDOCUMENTED`. **An undocumented prerequisite is a
defect, not a note**, and the procedure fails rather than printing its sentinel when it finds one.

## Verify an installation

```sh
sh scripts/config-validate.sh
sh scripts/ci-guard.sh
```

`config-validate.sh` checks the configuration contract against `PREFLIGHT.md`, `.env.example`, the code and
SPEC-007 §7.2, runs its own negative controls, and prints `config: ok`. `ci-guard.sh` validates
`.github/workflows/ci.yml` structurally and prints `ci pipeline: ok`.

## Run

Running the service requires the configuration declared in `PREFLIGHT.md` and `.env.example`: `DATABASE_URL`,
`VALKEY_URL`, `KEYCLOAK_ISSUER`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` and `SESSION_SECRET` are all
required, and the service refuses to start without them rather than inventing a default.

```sh
# requires operator credentials: the six variables above must be provisioned first
npm run serve
```

## Upgrade and rollback

`docs/release/upgrade.md` states the upgrade paths that were **executed against a real prior state** and nothing
else: this repository has no prior released schema, so the upgrade matrix rows it would exercise are recorded
`UNPROVEN` rather than described as verified. Rollback is by **digest**: the previous artifact digest is
redeployed as-is and the durable state is read back through an independent connection. `ROLLBACK.md` holds the
procedure, and the drill scripts that prove it (`scripts/rollback-drill.sh`, `scripts/backup-restore-drill.sh`)
are owned by EP-009 M6: until they exist and have been executed, no command for them is published here, because a
published command nobody has run is exactly the drift DOD-023 forbids.

## What is NOT claimed

- **No container image.** SPEC-008 §7.2 names one per service role; this repository contains no container build
  definition, so the format is recorded `BLOCKED_ON_IMPLEMENTATION` in `docs/release/supported-formats.md` and
  container support is not claimed.
- **The artifact is unsigned**, because no signing key or managed KMS exists in this environment (ADR-006 open).
- **No deployment has been performed**: staging is `NOT_PROVISIONED` and production deployment is manual-only and
  unauthorized. See `DEPLOYMENT.md` and `deploy/staging/README.md`.
- **The artifact-bound smoke test does not currently pass**: the running service's health surface does not
  implement the contract SPEC-003 §5.17 declares. The measured divergences are recorded in
  `.agent/evidence/EP-009/M4-artifact-smoke.txt`.
- The release verdict in `.agent/verification/state/RELEASE_GATE.json` remains `INCONCLUSIVE` with reason
  `FORGE_ONLY`; nothing in this repository may raise it without the external signatures SPEC-008 §9 names.
