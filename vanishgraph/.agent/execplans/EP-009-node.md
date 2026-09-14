NODE-META-BEGIN
ID: EP-009
DEPS: EP-008
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-release.sh
VERIFY_SENTINEL: gate-release: ok
GREEN_TAG: green/EP-009
NODE-META-END

# EP-009 — Deployment & Release

## 1. Purpose / Big Picture

Source code is not what anyone installs, deploys, or rolls back. This node produces the
**production distribution artifact** in every declared supported format, binds it to a digest,
proves it builds reproducibly from a clean checkout, executes the published install and upgrade
commands exactly as written, deploys it to staging and verifies it there, proves the rollback path
by an actual drill, and proves backup, restore, and recovery against reconciled state (DOD-003,
DOD-004, DOD-023, DOD-035, DOD-036).

At the end of this node a cold executor must be able to run `sh scripts/gate-release.sh` and receive
an honest answer about whether a specific, digest-identified artifact — not a source tree — can be
built, configured, installed, upgraded, deployed, verified, rolled back, and recovered by an
operator who has only the published documentation.

**Production deployment is manual only and is explicitly unauthorized in this run** (VG-SCOPE-009,
ADR-005). Every production-deploy step in this plan is emitted as a `MANUAL` instruction for an
authorised operator and is never executed by an agent. A staging deployment may be automated; a
production deployment may not.

## 2. Scope

In scope:

- The supported artifact formats, the build that produces them, their digests, and build
  reproducibility (DOD-002, DOD-003).
- `scripts/artifact-identity.sh`: source SHA, lockfile digests, builder identity, build command,
  artifact path, artifact digest, SBOM/provenance/signature references, and downstream test
  bindings (DOD-025, DOD-029).
- The environment configuration surface: every key in `.env.example` and `PREFLIGHT.md`, validated
  before start, with no default that silently substitutes for a missing required value.
- The CI/CD pipeline: build, test, scan, artifact production, and provenance — with no
  `continue-on-error`, no ignored exit code, and no filtered failure output (DOD-021, DOD-024).
- The staging deployment of the exact artifact digest, and artifact-bound smoke and E2E
  verification against it (DOD-004, DOD-005).
- The release checklist, and the execution of the published `README`/install/upgrade commands
  exactly as written (DOD-023).
- The rollback drill, the backup/restore drill, and disaster recovery against reconciled state
  (DOD-015, DOD-016, DOD-017, DOD-035, DOD-036).
- The operator-facing documents: `DEPLOYMENT.md`, `RELEASE.md`, `ROLLBACK.md`, `OPERATIONS.md`
  (deployment and recovery sections), `ENVIRONMENT.md`, `README.md`.

## 3. Non-goals

- **No production deployment.** It is unauthorized (VG-SCOPE-009), manual-only (ADR-005), and a
  STOP condition in `AGENTS.md`. The production path is documented, dry-run checked, and emitted as
  a `MANUAL` step; the executor never performs it.
- No change to product behaviour or to the test suite's oracles (EP-002…EP-008).
- No candidate-epoch freeze, verification subgraph, DOD gate, 484 accounting, clean-room, or
  release verdict (EP-010). This node produces the artifact EP-010 pins; it does not declare the
  release.
- No gate weakening to make a pipeline green: not by adding `continue-on-error`, not by narrowing a
  scan, not by excluding a path from a check, and not by relaxing a config validator (DOD-024,
  DOD-027).
- No claimed upgrade, downgrade, or version-skew path that has not been executed; an unexecuted
  path is removed from the support claim or recorded with its actual status (DOD-035).
- No restore that "succeeds" without a reconciliation of pre-disaster and post-restore state
  (DOD-036).
- No production credentials, no real customer data, and no production `Controller` contact.

## 4. Context and Orientation

Laws and authorities: `AGENTS.md` is authoritative; `SPEC-000` supplies the vocabulary lock, the
truth model and the acceptance oracle; `SPEC-008` §1, §7, §8, §10 and §11 govern what "shippable"
means, artifact-bound acceptance, clean-room expectations, no-masking, and evidence preservation.
`.agent/DONE_LAW.md` holds the 42 clauses.

Reality of the repository at the time this plan was authored:

- There is **no artifact**. `scripts/build.sh`, `scripts/artifact-identity.sh`, `scripts/install.sh`,
  and `scripts/smoke-test.sh` were loud-fail placeholders. Their own messages name the nodes that
  must implement them: `build` → EP-001 (skeleton build), `artifact-identity` → EP-009,
  `install` → EP-009, `smoke-test` → EP-009, `test-e2e` → EP-005. `format-check` and
  `dependency-audit` → EP-001; `security-check` → EP-006; `live-fire`, `dod-gate`, `harness-*`, and
  `production-readiness-check` → EP-010.
- `verify.sh` runs the mandated fifteen stages in order and cannot print `verify: ok` until the
  artifact exists, artifact-bound smoke and E2E pass, and EP-010 implements artifact-bound
  live-fire. **This node does not claim `verify: ok`**; it makes the artifact-dependent stages real
  and leaves live-fire to EP-010.
- `package.json` is `"private": true`, `"type": "module"`, Node `>=24.0.0`, with TypeScript 5.9.3
  and `@types/node` 24.10.1 exact-pinned. `.gitignore` exists; `.env.example` declares 25 keys, all
  valued `PROVISION_ME`.
- `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md` declares `clean-local` (disposable checkout;
  pinned tools, PostgreSQL, Valkey, browser) and `staging` (managed US cloud, separate
  account; Kubernetes, KMS, object store, managed PostgreSQL, browser pool) — both
  `NOT_PROVISIONED`, and `production` `UNAUTHORIZED`.
  `.agent/verification/CAPABILITY_MATRIX.md` classifies PostgreSQL/Valkey/browser runtime
  as `PROVISIONABLE_ENVIRONMENT` and cloud/KMS/object store/Kubernetes as
  `BLOCKED_EXTERNAL_CREDENTIAL`; production deployment is `MANUAL_ONLY`.
- `PREFLIGHT.md` declares 25 credential rows with probes under `scripts/probes/`. A missing
  credential blocks only its dependent work; the lanes are `REQUIRED_NOW`,
  `REQUIRED_BEFORE_INTEGRATION`, `REQUIRED_BEFORE_E2E`, `REQUIRED_BEFORE_DEPLOY`, `OPTIONAL`, and
  `HUMAN_EXTERNAL`.
- `.agent/verification/state/RUN_STATE.json` is `PLANNED`; `.agent/verification/state/
  RELEASE_GATE.json` is `INCONCLUSIVE` with reason `FORGE_ONLY`;
  `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv` and
  `CLAIM_TO_RELEASE_TRACEABILITY.csv` have zero data rows. This node changes none of them.
- Consequence for this node's realism: the **local** deliverables (artifact build and digests,
  reproducibility, configuration validation, pipeline definition, published-command execution,
  rollback drill, backup/restore drill against locally provisioned services) can and must genuinely
  execute here. The **staging** deliverables depend on credentials that are not provisioned; those
  rows are recorded `BLOCKED_CREDENTIALS` with the probe command, probe exit code, and the
  `PREFLIGHT.md` row — never `PASS`, never skipped silently, and never replaced by a local
  deployment reported as staging.

## 5. Files to Read First

Control plane and laws:

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`
- `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/DONE_LAW.md` (all 42 clauses)
- `.agent/checklists/release.md`, `.agent/checklists/rollback.md`,
  `.agent/checklists/production-readiness.md`, `.agent/checklists/validation.md`
- `.agent/state/LEDGER.md`

Specifications:

- `.agent/specs/SPEC-008-production-readiness.md` §1 (shippable), §2 (the four verdicts), §3
  (epoch and artifact identity), §7 (artifact-bound acceptance), §8 (environment and clean room),
  §9 (mandatory external gates), §10 (no masking), §11 (evidence preservation)
- `.agent/specs/SPEC-000-product-scope.md` §3 (VG-SCOPE-009), §4 (vocabulary lock), §9 (acceptance
  oracle), §11 (items requiring human authority)
- `.agent/specs/SPEC-002-data-model.md` (schema, migrations, and what "supported prior schema"
  means for the upgrade paths)
- `.agent/specs/SPEC-006-errors.md` §4.1 (taxonomy and required fields), §8 (no masking)
- `.agent/specs/SPEC-005-auth-permissions.md` (secret handling and the identity surface the
  deployment must satisfy)

Operational documents, environment, and harness:

- `DEPLOYMENT.md`, `RELEASE.md`, `ROLLBACK.md`, `OPERATIONS.md`, `ENVIRONMENT.md`, `PREFLIGHT.md`,
  `.env.example`, `SECURITY.md`, `ARCHITECTURE.md`, `README.md` (if present — if absent, M5 creates
  it), `LICENSE_POLICY.md`
- `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`,
  `.agent/verification/CAPABILITY_MATRIX.md`, `.agent/verification/HARNESS_LAWS.md`
- `.agent/verification/MASTER_TEST_REGISTRY.csv` (the SUP rows for packaging, reproducibility,
  upgrade path, configuration, support matrix, executable documentation, deployment/promotion/
  canary/rollback)
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`

Code and gates actually present:

- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`
- every file under `src/**` and `tests/**`
- every file under `scripts/**`, including `scripts/lib/loud-fail.sh` and `scripts/probes/*.sh`
- `.github/workflows/ci.yml` (created by EP-001)

## 6. Expected Changed Files

Created:

- `scripts/gate-release.sh`
- `scripts/build-artifact.sh`
- `scripts/build-reproducibility.sh`
- `scripts/config-validate.sh`
- `scripts/ci-guard.sh`
- `scripts/staging-deploy.sh`
- `scripts/staging-verify.sh`
- `scripts/published-commands.sh`
- `scripts/rollback-drill.sh`
- `scripts/backup-restore-drill.sh`
- `scripts/upgrade-drill.sh`
- `config/environment/schema.json`
- `config/environment/required.json`
- `deploy/staging/README.md`
- `deploy/production/README.md` (the manual-only procedure; contains no executable deployment
  credential and no automated deploy path)
- `docs/release/release-checklist.md`
- `docs/release/supported-formats.md`
- `docs/release/upgrade.md`
- `docs/release/rollback-drill.md`
- `docs/release/backup-restore-drill.md`
- `README.md` (only if it does not already exist)
- `.agent/evidence/EP-009/**`
- `.agent/verification/state/ARTIFACT_IDENTITY.json`
- `deploy/ci/steps.yml` (only if the M3 FALLBACK is taken)

Modified:

- `scripts/build.sh`, `scripts/artifact-identity.sh`, `scripts/install.sh`, `scripts/smoke-test.sh`,
  `scripts/test-e2e.sh` (artifact binding only), `scripts/verify.sh` (artifact-bound stage wiring
  only; the mandated stage order is unchanged)
- `.github/workflows/ci.yml`
- `DEPLOYMENT.md`, `RELEASE.md`, `ROLLBACK.md`, `OPERATIONS.md`, `ENVIRONMENT.md`, `COMMANDS.md`,
  `DECISIONS.md`
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`
- `.agent/verification/REQUIREMENT_TRACEABILITY.csv` (only the release-path rows this node proves)
- `.agent/verification/state/RUN_MANIFEST.json`
- `.agent/state/LEDGER.md`
- `package.json` (build scripts only; no dependency change without an ADR)

Nothing else may change. Any other diff is a scope violation and must be reverted.

## 7. Interfaces and Contracts

### 7.1 Gate-script contract

Every script this node adds or makes real is POSIX `sh`, `set -eu`, runs from the repository root,
exports `CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive`,
passes `sh -n`, prints its exact sentinel only on genuine success, and exits non-zero on failure. No
`|| true`, no `continue-on-error`, no filtered failure output, no unconditional success path
(DOD-024).

| Command | Sentinel |
|---|---|
| `sh scripts/build-artifact.sh` | `artifact: built` |
| `sh scripts/build-reproducibility.sh` | `artifact reproducible: ok` |
| `sh scripts/artifact-identity.sh` | `artifact identity: ok` |
| `sh scripts/config-validate.sh` | `config: ok` |
| `sh scripts/ci-guard.sh` | `ci pipeline: ok` |
| `sh scripts/staging-deploy.sh` | `staging deploy: ok` |
| `sh scripts/staging-verify.sh` | `staging verify: ok` |
| `sh scripts/published-commands.sh` | `published commands: ok` |
| `sh scripts/rollback-drill.sh` | `rollback drill: ok` |
| `sh scripts/backup-restore-drill.sh` | `backup restore: ok` |
| `sh scripts/upgrade-drill.sh` | `upgrade drill: ok` |
| `sh scripts/gate-release.sh` | `gate-release: ok` |

### 7.2 Supported artifact formats

The supported format set is declared in `docs/release/supported-formats.md` from repository
evidence, and every declared format must be produced with a digest. The minimum set, subject to
discovery in M1:

1. An OCI container image per declared service role, referenced by digest (`sha256:…`), never by a
   mutable tag in any test, deployment, or evidence path.
2. A distributable package tarball (`npm pack` output) for the installable surface, with its
   SHA-256 recorded.
3. A software bill of materials for the artifact and its dependency closure, plus build provenance
   and a checksums file covering every produced file.

A format that is declared but not produced, or produced but not digest-pinned, is a `FAIL` of
DOD-003. A format that cannot be produced in this environment is removed from the declared set with
a recorded rationale, or recorded with its exact taxonomy status — never silently dropped and never
represented as "the artifact" in a later gate.

### 7.3 Artifact identity contract

`ARTIFACT_IDENTITY.json` records: source commit SHA, base revision, lockfile digests, builder
identity (tool and version), the exact build command, the artifact path(s), the artifact digest(s),
SBOM reference, provenance/signature references, and the downstream test bindings that consumed
that digest. A test, smoke run, E2E run, or deployment that is not bound to a recorded digest is not
artifact-bound and cannot satisfy acceptance (DOD-004, SPEC-008 §7).

### 7.4 Environment configuration contract

Every key in `.env.example` and every row of `PREFLIGHT.md` is classified in
`config/environment/schema.json` as required or optional, with its lane. Validation runs before
startup: a missing required value fails startup with a typed error naming the key (never its value),
and no default may silently substitute for a required value. No secret value appears in a log, an
error, a metric label, an evidence file, or a commit (VG-SEC-002).

### 7.5 Pipeline contract

The CI/CD pipeline builds, tests, scans, produces the artifact with its SBOM and provenance, and
publishes it to staging. It contains no `continue-on-error`, no ignored exit code, no swallowed
exception, no all-retry policy, no filtered failure output, and no baseline auto-acceptance
(DOD-024, SPEC-008 §10). Every required check is a required status; a job that cannot run is a
failure, not a skip.

### 7.6 Rollback, backup, and recovery contract

A claimed rollback path is executed with realistic persistent state: the newer artifact is
deployed, state is written, the previous artifact is restored, and the state is read back and
reconciled. A claimed backup/restore path is executed against reconciled state: a pre-disaster hash
is recorded, a fault is injected, the restore runs, and the post-restore state is reconciled
against the pre-disaster hash with every difference explained. Measured RPO, RTO, and MTTR are
recorded as measured values; an unmeasured objective is `INCONCLUSIVE`, never a claim (DOD-036).

### 7.7 Production deployment contract

Production deployment is **manual only** and **unauthorized** in this run (VG-SCOPE-009, ADR-005).
`deploy/production/README.md` contains the operator procedure, the pre-conditions, the exact
commands an operator would run, the post-deploy smoke checks, and the rollback trigger — and no
automation that an agent could invoke. The executor records the production path as `MANUAL_ONLY`
with the authorization absent, and never executes it.

### 7.8 Status vocabulary

Every status written by this node uses a SPEC-006 §4.1 token with its required fields. Unprovisioned
external credentials produce `BLOCKED_CREDENTIALS` naming the `PREFLIGHT.md` row, the probe
command, and the probe exit code. A machine that cannot reach a required environment is
`BLOCKED_ENVIRONMENT` with the provisioning attempt log. An executed product failure is `FAIL`. A
broken pipeline or script is `ERROR`.

### 7.9 Rulings this plan makes, to be re-recorded in §13 by the executor

1. **Node verify command.** The stub header declared `VERIFY: sh scripts/verify.sh` /
   `VERIFY_SENTINEL: verify: ok`. `verify.sh`'s final stage is artifact-bound live-fire, which
   `scripts/live-fire.sh` assigns to EP-010; `verify: ok` therefore cannot honestly be printed in
   this node. This node's verify is `sh scripts/gate-release.sh` with sentinel `gate-release: ok`.
   No stage is removed from `verify.sh`, its order is unchanged, and nothing is weakened. EP-010
   runs `sh scripts/verify.sh` and requires `verify: ok` inside the ship gate.
2. **Node close with credential-blocked staging rows.** `gate-release: ok` requires (a) every
   **local** deliverable executed with evidence — artifact build, digests, reproducibility,
   configuration validation, pipeline definition, published commands, rollback drill,
   backup/restore drill, upgrade drill against locally provisioned services — and (b) every
   deliverable that cannot execute carrying an exact taxonomy status with its required fields, a
   dependency edge, and a named next action. A credential-blocked staging row therefore does not
   block this node, and it never becomes a `PASS`. This mirrors SPEC-008 §2's distinction between an
   accounting completion and a release verdict, and it keeps EP-010 as the only place a verdict is
   produced.
3. **`verify: ok` belongs to EP-010.** It is claimed exactly once, inside the ship gate, against a
   fresh-clone-equivalent run for the pinned epoch. This node wires the artifact-bound stages but
   does not claim the sentinel.
4. **Declared support surface.** Only artifact formats, upgrade paths, and environment classes that
   were actually executed may appear as supported in `RELEASE.md` and `DEPLOYMENT.md`. An
   unexecuted path is removed from the claim or carries its taxonomy status (DOD-035, DOD-027).
5. **Local versus staging evidence.** Evidence produced against `clean-local` is labelled with its
   environment identity and may never be presented as staging evidence; the environment fingerprint
   recorded in every evidence file is the discriminator.

## 8. Milestones

### M1: Build artifact creation in every supported format with digests

GOAL: Each declared supported format is produced from a clean checkout with a recorded digest, the
build is reproducible, and the artifact identity is recorded.

READ: `.agent/specs/SPEC-008-production-readiness.md` §3, §7; `.agent/DONE_LAW.md` (DOD-002,
DOD-003, DOD-025, DOD-029); `ARCHITECTURE.md`; `package.json`, `package-lock.json`, `tsconfig.json`,
`.gitignore`; `scripts/build.sh`, `scripts/test-unit.sh`, `scripts/typecheck.sh`; `ENVIRONMENT.md`;
`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`.

CHANGE: `scripts/build-artifact.sh`, `scripts/build-reproducibility.sh`, `scripts/build.sh`,
`scripts/artifact-identity.sh`, `docs/release/supported-formats.md`,
`.agent/verification/state/ARTIFACT_IDENTITY.json`, `RELEASE.md`, `DEPLOYMENT.md`, `COMMANDS.md`,
`.agent/state/LEDGER.md`, and `package.json` build scripts only.

CONTENT:

(a) `docs/release/supported-formats.md` — the declared format set of §7.2 with, for each format:
the exact build command, the output path pattern, the digest algorithm, and the consumer (which
gate, which deployment target). Formats that cannot be produced here are recorded with their
taxonomy status and a named next action instead of being declared supported.

(b) `scripts/build-artifact.sh` — produces every declared format from a clean working tree
(`git status --porcelain` must be empty or contain only ignored files), writes every output under
`dist/`, prints `artifact: built` only when every declared format exists and is non-empty, and
writes the digest of each output to `.agent/verification/state/ARTIFACT_IDENTITY.json`. A format
that fails to build fails the script; no format may be skipped to reach the sentinel.

(c) `scripts/build-reproducibility.sh` — builds twice from two clean checkouts of the same commit
and requires byte-identical (or digest-identical, for formats with a documented
non-determinism and a recorded reconciliation) outputs. A non-reproducible format is either made
reproducible or removed from the supported set with a recorded rationale. Prints
`artifact reproducible: ok`.

(d) `scripts/artifact-identity.sh` — records the §7.3 fields and prints `artifact identity: ok` only
when every field is populated and every digest resolves. It must pass a digest through to the
artifact-bound stages; a downstream stage that cannot resolve the digest fails.

(e) Exact discovery commands whose output fills the format blank:

```
command -v docker || true
docker --version 2>/dev/null || true
node --version
npm --version
cat package.json
git rev-parse HEAD
git status --porcelain
```

Record the output verbatim in `.agent/evidence/EP-009/M1-discovery.txt`. The OCI-image format is
declared only if a container runtime is genuinely available; otherwise it is recorded as
`BLOCKED_ENVIRONMENT` with this output as evidence and the remaining formats still ship.

(f) `COMMANDS.md` — append `sh scripts/build-artifact.sh` / `artifact: built` and
`sh scripts/build-reproducibility.sh` / `artifact reproducible: ok`.

RUN:

```
command -v docker && docker --version || true
sh scripts/typecheck.sh
sh scripts/test-unit.sh
sh scripts/build-artifact.sh
sh scripts/build-reproducibility.sh
sh scripts/artifact-identity.sh
```

EXPECT: `artifact: built`, `artifact reproducible: ok`, and `artifact identity: ok`; the discovery
output recorded in the evidence file. A missing declared format is a failure of this milestone.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 MILESTONE_PASS "M1 artifact: built; artifact reproducible: ok; artifact identity: ok"`

FALLBACK: if no container runtime is available, ship the package tarball plus SBOM plus provenance
plus checksums as the supported format set, record the OCI format as `BLOCKED_ENVIRONMENT` with the
discovery output, and note in `RELEASE.md` that container-format support is not claimed. Never
declare a format supported that was not produced, and never substitute a source archive for the
distribution artifact.

COMMIT: `git add -A && git commit -m "[EP-009][M1] build artifact creation with digests and reproducibility"`

### M2: Environment configuration and configuration validation

GOAL: Every configuration key is classified, validated before startup, and a missing required value
fails closed and names the key without leaking a value.

READ: `ENVIRONMENT.md`, `PREFLIGHT.md`, `.env.example`, `SECURITY.md`,
`.agent/specs/SPEC-005-auth-permissions.md`, `.agent/specs/SPEC-006-errors.md` §7 (fail-closed
matrix), `.agent/DONE_LAW.md` (DOD-014, DOD-020, DOD-021),
`.agent/verification/CAPABILITY_MATRIX.md`.

CHANGE: `config/environment/schema.json`, `config/environment/required.json`,
`scripts/config-validate.sh`, `ENVIRONMENT.md`, `DEPLOYMENT.md`, `COMMANDS.md`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) `config/environment/schema.json` — one entry per configuration key with `name`, `required`,
`lane` (`REQUIRED_NOW`, `REQUIRED_BEFORE_INTEGRATION`, `REQUIRED_BEFORE_E2E`, `REQUIRED_BEFORE_DEPLOY`,
`OPTIONAL`, `HUMAN_EXTERNAL`), `format`, and, where applicable, `enum` of permitted values. The key
set must equal the union of `.env.example` and the `PREFLIGHT-TABLE` rows in `PREFLIGHT.md`; a key
present in one and missing from the other is a defect the guard reports.

(b) `config/environment/required.json` — the exact required set per environment class
(`clean-local`, `staging`, `production`) and per service role, mirroring SPEC-007 §7.2 for
dependencies and `PREFLIGHT.md` for credentials.

(c) `scripts/config-validate.sh` — fails when a required key is absent or malformed for the target
environment, when a default would substitute for a required value, when an unknown key is present
and unreferenced by the schema, when a value that must be an enum is not one, and when the schema
and `.env.example`/`PREFLIGHT.md` disagree on the key set. It never prints a value, only a key name
and a reason code. Prints `config: ok`.

(d) The negative cases the guard must execute: remove one required key from the environment and
require a typed failure naming that key; set a key to an empty string and require a failure; add an
unknown key and require a failure (warn-only is not permitted). Each control is restored and the
restoration is proven by a passing re-run.

(e) `COMMANDS.md` — append `sh scripts/config-validate.sh` / `config: ok`.

RUN:

```
sh scripts/config-validate.sh
grep -c 'PROVISION_ME' .env.example
grep -c '^[A-Z0-9_]*|' PREFLIGHT.md
```

EXPECT: `config: ok`; the `.env.example` grep prints `25`; the `PREFLIGHT.md` grep prints `25`. The
pattern must include digits because four rows contain them (`S3_ENDPOINT`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_BUCKET`) plus `CLICK2MAIL_API_KEY`; a digit-free pattern prints `20` and
would silently under-count the credential surface. A mismatch between the two counts is a defect to
reconcile in the schema, not to ignore.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 MILESTONE_PASS "M2 config: ok"`

FALLBACK: if a required key cannot be resolved in this environment, the guard still classifies it,
records `BLOCKED_CREDENTIALS` with the probe command and exit code from `scripts/probes/`, and
continues validating the remaining keys. The validation itself is never skipped and no default value
is ever invented.

COMMIT: `git add -A && git commit -m "[EP-009][M2] environment configuration and validation"`

### M3: CI/CD pipeline with no failure masking

GOAL: The pipeline builds, tests, scans, produces the artifact with SBOM and provenance, and cannot
hide a failure.

READ: `.agent/specs/SPEC-008-production-readiness.md` §10; `.agent/DONE_LAW.md` (DOD-021, DOD-024,
DOD-003); `.github/workflows/ci.yml`; `COMMANDS.md`; `.agent/specs/SPEC-006-errors.md` §8;
`.agent/verification/state/ARTIFACT_IDENTITY.json`.

CHANGE: `.github/workflows/ci.yml`, `scripts/ci-guard.sh`, `DEPLOYMENT.md`, `COMMANDS.md`,
`.agent/state/LEDGER.md`, plus `deploy/ci/steps.yml` only if the FALLBACK below is taken.

CONTENT:

(a) The pipeline definition provides, as required jobs: static gates (`format-check`, `lint`,
`typecheck`, `import-boundary`), unit and integration tests, `security-check`, `dependency-audit`,
`reality-gate`, `test-collection-guard`, artifact build, `artifact-identity`, artifact-bound smoke,
artifact-bound E2E, SBOM and provenance generation, and an artifact upload keyed by digest. The
stage order mirrors `scripts/verify.sh`.

(b) `scripts/ci-guard.sh` — a real static and structural check of the pipeline definition: no
`continue-on-error`, no `|| true`, no `if: always()` on a gating job, no ignored exit code, no
`--exit-code 0`-style suppression, no filtered failure output, no job whose failure is not
propagated, and every required job present. It also asserts the workflow's stage list equals
`verify.sh`'s stage list, so the pipeline and the local gate cannot drift apart. Prints
`ci pipeline: ok`.

(c) Pipeline observation: remote run observation requires the GitHub credentials declared in
`PREFLIGHT.md` (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`). If they are
unprovisioned, the pipeline definition and its guard are validated locally, the same step sequence
is executed locally with `CI=true`, and remote observation is recorded `BLOCKED_CREDENTIALS` with
the probe command and exit code. A locally executed sequence is never described as a green pipeline
run.

(d) `COMMANDS.md` — append `sh scripts/ci-guard.sh` / `ci pipeline: ok`.

RUN:

```
sh scripts/ci-guard.sh
sh scripts/preflight.sh
grep -c 'jobs:' .github/workflows/ci.yml
```

EXPECT: `ci pipeline: ok`; `preflight: ok`; the jobs grep prints a non-zero count reported in the
evidence file. If `preflight: ok` cannot be printed because a `REQUIRED_NOW` credential is missing,
that is recorded with the probe evidence and the pipeline milestone proceeds only on the parts that
do not depend on it.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 MILESTONE_PASS "M3 ci pipeline: ok"`

FALLBACK: if the hosting platform cannot be reached at all, the pipeline is defined as a
platform-neutral step manifest (`deploy/ci/steps.yml`) that the same `ci-guard.sh` validates and
that a local runner executes in the identical order; remote execution is recorded
`BLOCKED_CREDENTIALS`. No check is ever removed to make the manifest validate.

COMMIT: `git add -A && git commit -m "[EP-009][M3] CI/CD pipeline with no failure masking"`

### M4: Staging deployment and artifact-bound verification

GOAL: The exact artifact digest is deployed to staging and verified there by artifact-bound smoke
and E2E runs, or the staging rows carry a precise credential or environment blocker with evidence.

READ: `.agent/specs/SPEC-008-production-readiness.md` §7, §8;
`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`;
`.agent/verification/CAPABILITY_MATRIX.md`; `DEPLOYMENT.md`; `.env.example`; `PREFLIGHT.md`;
`.agent/DONE_LAW.md` (DOD-004, DOD-005, DOD-009, DOD-012); `scripts/smoke-test.sh`,
`scripts/test-e2e.sh`, `scripts/verify.sh`.

CHANGE: `scripts/staging-deploy.sh`, `scripts/staging-verify.sh`, `scripts/smoke-test.sh`,
`scripts/test-e2e.sh` (artifact binding only), `scripts/verify.sh` (artifact-bound wiring only),
`deploy/staging/README.md`, `DEPLOYMENT.md`, `COMMANDS.md`,
`.agent/verification/state/ARTIFACT_IDENTITY.json`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/staging-deploy.sh` — deploys the digest recorded in `ARTIFACT_IDENTITY.json` to the
staging environment declared in `TEST_ENVIRONMENT_MANIFEST.md`, verifies that the deployed digest
equals the pinned digest by reading it back from the running system, and prints
`staging deploy: ok` only then. It never falls back to a local deployment and never deploys a
source tree. If the staging credentials are unprovisioned it exits non-zero with the
`BLOCKED_CREDENTIALS` evidence path, and the milestone records that status rather than a pass.

(b) `scripts/staging-verify.sh` — runs the artifact-bound smoke suite and the artifact-bound E2E
suite against the deployed digest, asserts `GET /v1/live`, `GET /v1/ready`, `GET /v1/health`, and
`GET /v1/startup` behave as SPEC-007 §7.1 requires, completes the golden path, and performs one
independent read-back through a second connection or client (DOD-012). Prints `staging verify: ok`.

(c) `scripts/smoke-test.sh` and `scripts/test-e2e.sh` — bound to the artifact digest: both refuse to
run unless the environment declares the digest they are testing and it matches
`ARTIFACT_IDENTITY.json`. A source-tree run is not acceptance (DOD-004, SPEC-008 §7).

(d) `deploy/staging/README.md` — the staging procedure, prerequisites, the digest-pinning rule, the
verification commands, and the teardown step.

(e) `COMMANDS.md` — append `sh scripts/staging-deploy.sh` / `staging deploy: ok` and
`sh scripts/staging-verify.sh` / `staging verify: ok`.

RUN:

```
sh scripts/artifact-identity.sh
sh scripts/staging-deploy.sh
sh scripts/staging-verify.sh
sh scripts/smoke-test.sh
sh scripts/test-e2e.sh
```

EXPECT: `artifact identity: ok`, then either `staging deploy: ok` and `staging verify: ok` for the
pinned digest, or a non-zero exit carrying `BLOCKED_CREDENTIALS` with the probe command, the probe
exit code, and the `PREFLIGHT.md` row. Both outcomes are recorded verbatim; the blocked outcome is
never rewritten as a pass, and a local run is never labelled staging.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 MILESTONE_PASS "M4 staging deploy/verify recorded for pinned digest (or BLOCKED_CREDENTIALS with probe evidence)"`

FALLBACK: if staging cannot be provisioned, the same artifact-bound smoke and E2E suites run against
the exact digest deployed to `clean-local`, and both evidence sets are labelled with their
environment fingerprint; the staging rows stay `BLOCKED_CREDENTIALS` and `RELEASE.md` states that
staging verification is not claimed.

COMMIT: `git add -A && git commit -m "[EP-009][M4] staging deployment and artifact-bound verification"`

### M5: Published README, install, and upgrade commands executed exactly as published

GOAL: Every command printed in the README, install, upgrade, deployment, and rollback documentation
is executed exactly as written in a clean environment and produces the documented result.

READ: `.agent/DONE_LAW.md` (DOD-023, DOD-002); `README.md` (or its absence), `DEPLOYMENT.md`,
`RELEASE.md`, `ROLLBACK.md`, `docs/release/release-checklist.md`,
`.agent/checklists/release.md`; `scripts/install.sh`; `.agent/specs/SPEC-008-production-
readiness.md` §8 (VG-SHIP-029); `.agent/verification/state/ARTIFACT_IDENTITY.json`.

CHANGE: `scripts/published-commands.sh`, `scripts/install.sh`, `README.md` (create only if absent),
`docs/release/release-checklist.md`, `docs/release/upgrade.md`, `DEPLOYMENT.md`, `RELEASE.md`,
`ROLLBACK.md`, `OPERATIONS.md`, `COMMANDS.md`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `docs/release/release-checklist.md` — the release pre-conditions, the exact gate sequence with
its sentinels, the evidence requirements, the rollback trigger and decision owner, and the explicit
statement that the production deployment is `MANUAL_ONLY` and unauthorized in this run. Every line
names a command or an artifact; no line is a sentiment.

(b) `scripts/install.sh` — a real, executable installer for the artifact: it installs from the
produced artifact (not from the repository), verifies the digest before installing, prints the
installed version and digest, and exits non-zero on a digest mismatch. Prints `install: ok`.

(c) `docs/release/upgrade.md` — the upgrade procedure from each supported prior released schema or
artifact, with the exact commands, the pre-upgrade backup step, the migration step, the
post-upgrade verification, and the rollback trigger. Only paths that were executed against a real
prior state may be listed as supported (DOD-035, DOD-016).

(d) `scripts/published-commands.sh` — extracts every command from the published documentation
(README, install, upgrade, deployment, rollback sections), executes each exactly as written in a
clean working directory with only the documented prerequisites, compares the actual output with the
documented expected output, and fails on any drift, missing command, or undocumented prerequisite.
Documentation drift is a defect, not a footnote (DOD-023). Prints `published commands: ok`.

(e) `COMMANDS.md` — append `sh scripts/install.sh` / `install: ok` and
`sh scripts/published-commands.sh` / `published commands: ok`.

RUN:

```
sh scripts/install.sh
sh scripts/published-commands.sh
grep -c 'MANUAL' docs/release/release-checklist.md
```

EXPECT: `install: ok`; `published commands: ok`; the checklist grep prints a non-zero count,
confirming the production step is labelled manual-only.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 MILESTONE_PASS "M5 install: ok; published commands: ok"`

FALLBACK: if a published command cannot run in this environment because it needs an unprovisioned
credential, the command is removed from the published documentation or moved to a clearly labelled
"requires operator credentials" section, and the corresponding row is recorded `BLOCKED_CREDENTIALS`.
A command may never remain published and unexecuted without that label.

COMMIT: `git add -A && git commit -m "[EP-009][M5] published install and upgrade commands executed"`

### M6: Rollback drill, backup/restore, and disaster recovery against reconciled state

GOAL: The rollback path is proven by an executed drill with realistic state, and backup, restore,
and recovery are executed against reconciled state with measured objectives.

READ: `.agent/DONE_LAW.md` (DOD-015, DOD-016, DOD-017, DOD-035, DOD-036); `.agent/specs/
SPEC-002-data-model.md`; `ROLLBACK.md`, `OPERATIONS.md`, `docs/release/upgrade.md`;
`.agent/checklists/rollback.md`; `.agent/specs/SPEC-008-production-readiness.md` §1;
`.agent/verification/state/ARTIFACT_IDENTITY.json`.

CHANGE: `scripts/rollback-drill.sh`, `scripts/backup-restore-drill.sh`, `scripts/upgrade-drill.sh`,
`docs/release/rollback-drill.md`, `docs/release/backup-restore-drill.md`, `ROLLBACK.md`,
`OPERATIONS.md`, `RELEASE.md`, `COMMANDS.md`, `.agent/evidence/EP-009/drills/**`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/rollback-drill.sh` — against a locally provisioned disposable environment: deploy the
current artifact, write realistic persistent state through the real entry point, record a state
hash, deploy the previous artifact, read the state back through an independent connection, reconcile
it against the recorded hash with every difference explained, then return to the current artifact
and re-verify. Prints `rollback drill: ok` only when the reconciliation is complete. A rollback that
loses or duplicates state is a `FAIL`, and the affected rollback claim is removed from `ROLLBACK.md`.

(b) `scripts/upgrade-drill.sh` — for each supported prior schema or artifact: install the prior
version, write state, upgrade, assert the post-migration invariants and logical data preservation,
and assert the upgrade is repeatable after an interrupted run (DOD-016). Prints `upgrade drill: ok`.

(c) `scripts/backup-restore-drill.sh` — records a pre-disaster hash, injects a hard fault (process
and container kill, plus a storage-level fault where the environment supports one), restores from
backup, reconciles the post-restore state against the pre-disaster hash, measures RPO, RTO, and MTTR
as observed values, and asserts that no transaction was silently lost, duplicated, or corrupted
(DOD-036). Prints `backup restore: ok` only when the reconciliation is complete; an unmeasured
objective is recorded `INCONCLUSIVE`.

(d) `docs/release/rollback-drill.md` and `docs/release/backup-restore-drill.md` — the executed
procedures, the environment fingerprint, the artifact digests involved, the observed measurements,
and the unresolved findings. `ROLLBACK.md` and `OPERATIONS.md` are updated to state exactly the
paths that were proven, and no path that was not executed is presented as supported.

(e) `COMMANDS.md` — append the three drill commands and their sentinels.

RUN:

```
sh scripts/rollback-drill.sh
sh scripts/upgrade-drill.sh
sh scripts/backup-restore-drill.sh
git status --short
```

EXPECT: `rollback drill: ok`, `upgrade drill: ok`, `backup restore: ok`; the final `git status
--short` shows no drill artefact left in the working tree outside `.agent/evidence/EP-009/drills/`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 MILESTONE_PASS "M6 rollback drill: ok; upgrade drill: ok; backup restore: ok"`

FALLBACK: if the container runtime is unavailable, the drills run directly against locally
provisioned PostgreSQL and Valkey processes with the same fault injection and the same
reconciliation assertions; the environment fingerprint records the difference. A drill that cannot
be executed at all is recorded `BLOCKED_ENVIRONMENT` with the provisioning attempt log, and no
recovery claim is made from it.

COMMIT: `git add -A && git commit -m "[EP-009][M6] rollback, upgrade, backup and recovery drills"`

### M7: Node close-out

GOAL: The node's own gate passes end to end, the release surface describes only executed paths, and
the production deployment remains unauthorized and manual.

READ: `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md` (DOD-024, DOD-025, DOD-026, DOD-028),
`.agent/checklists/release.md`, `.agent/specs/SPEC-008-production-readiness.md` §2 and §9,
`.agent/verification/state/RELEASE_GATE.json`, `.agent/state/LEDGER.md`.

CHANGE: `scripts/gate-release.sh`, `deploy/production/README.md`, `RELEASE.md`, `COMMANDS.md`,
`.agent/verification/state/RUN_MANIFEST.json`, `.agent/state/LEDGER.md`,
`.agent/evidence/EP-009/**`.

CONTENT:

(a) `scripts/gate-release.sh` runs, in order: `sh scripts/config-validate.sh`,
`sh scripts/ci-guard.sh`, `sh scripts/build-artifact.sh`,
`sh scripts/build-reproducibility.sh`, `sh scripts/artifact-identity.sh`,
`sh scripts/install.sh`, `sh scripts/published-commands.sh`, `sh scripts/rollback-drill.sh`,
`sh scripts/upgrade-drill.sh`, `sh scripts/backup-restore-drill.sh`, and then the staging pair
`sh scripts/staging-deploy.sh` and `sh scripts/staging-verify.sh`. It prints `gate-release: ok` only
when every **local** stage exited zero with its sentinel and every stage that could not execute
carries a taxonomy status with its required fields, a dependency edge, and a named next action. A
stage that exits zero without printing its sentinel is a failure, and a stage recorded `PASS`
without evidence fails the gate.

(b) `deploy/production/README.md` — the manual-only operator procedure: pre-conditions, the exact
commands, the digest verification, the post-deploy smoke checks, the rollback trigger, and the
authorization requirement. It must contain no automation an agent could invoke, and it states that
production deployment is unauthorized in this run (VG-SCOPE-009, ADR-005).

(c) `RUN_MANIFEST.json` — record the artifact digest, the supported-format list, the builder
identity, and the environment fingerprints used by the drills. Do not change `registry_count` (484),
`dod_count` (42), or `candidate_epoch`.

(d) `RELEASE_GATE.json` — **do not change it here.** The verdict remains `INCONCLUSIVE` with reason
`FORGE_ONLY`; the release verdict is produced only by EP-010's ship gate (VG-SHIP-001, DOD-042).

(e) Index the EP-009 evidence with content hashes and append the milestone ledger events.

RUN:

```
sh scripts/gate-release.sh
sh scripts/ledger.sh append <AGENT_ID> EP-009 NODE_DONE "EP-009 complete: gate-release: ok"
git tag green/EP-009
sh scripts/ledger.sh tail 30
git log --oneline -1
```

EXPECT: `gate-release: ok`; the ledger tail shows the `NODE_DONE` line for `EP-009`; tag
`green/EP-009` exists locally. `verify: ok` is **not** claimed here.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-009 NODE_DONE "EP-009 complete: gate-release: ok"`

FALLBACK: if a mandatory local stage cannot pass, the node stays open and the finding is reported
with its taxonomy status. Tagging on a partial gate is prohibited.

COMMIT: `git add -A && git commit -m "[EP-009][M7] close deployment and release node"`

## 9. Validation and Acceptance

Node-level acceptance, each item an executed observation:

1. `sh scripts/gate-release.sh` prints `gate-release: ok`.
2. Every declared supported format exists with a recorded digest, and
   `.agent/verification/state/ARTIFACT_IDENTITY.json` populates every §7.3 field.
3. `sh scripts/build-reproducibility.sh` prints `artifact reproducible: ok`, or the non-reproducible
   format is removed from the supported set with a recorded rationale.
4. `sh scripts/config-validate.sh` prints `config: ok`, and its three negative controls (missing
   required key, empty value, unknown key) each failed naming the key.
5. `sh scripts/ci-guard.sh` prints `ci pipeline: ok`, and the pipeline contains no
   `continue-on-error`, ignored exit code, or unconditional success path.
6. `sh scripts/install.sh` prints `install: ok` with a digest check, and
   `sh scripts/published-commands.sh` prints `published commands: ok`.
7. `sh scripts/rollback-drill.sh` prints `rollback drill: ok` with reconciled state;
   `sh scripts/upgrade-drill.sh` prints `upgrade drill: ok`; `sh scripts/backup-restore-drill.sh`
   prints `backup restore: ok` with measured RPO/RTO/MTTR or an explicit `INCONCLUSIVE`.
8. `sh scripts/staging-deploy.sh` and `sh scripts/staging-verify.sh` either print their sentinels
   for the pinned digest, or are recorded `BLOCKED_CREDENTIALS` or `BLOCKED_ENVIRONMENT` with the
   probe command, the probe exit code or provisioning attempt log, and the `PREFLIGHT.md` row.
9. `RELEASE.md`, `DEPLOYMENT.md`, `ROLLBACK.md`, `OPERATIONS.md`, `ENVIRONMENT.md`, and the
   supported-formats document describe only paths that were executed; every unexecuted path carries
   its taxonomy status.
10. `deploy/production/README.md` exists, is manual-only, contains no invocable automation, and
    states that production deployment is unauthorized in this run.
11. No file outside §6's list changed: `git status --short` is the audit list.

**Never claim:** that `sh scripts/verify.sh` passes, that live-fire runs, that the 484 IDs are
accounted, that a release verdict exists, or that production is deployed or deployable by an agent.
The ship verdict remains `INCONCLUSIVE` with reason `FORGE_ONLY` until EP-010 legitimately changes
it.

## 10. Idempotence and Recovery

To re-enter cold: read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, this plan's §11 Progress, then
`.agent/state/LEDGER.md` and `sh scripts/ledger.sh status EP-009`. Resume at the first milestone with
no `MILESTONE_PASS` event, and re-run the previous milestone's gate to confirm its sentinel still
appears before proceeding.

Every stage is re-runnable: `dist/` is regenerated, the drills create and tear down their own
disposable state, and no stage destroys data outside its disposable environment. After each drill,
assert the environment is torn down and the working tree is clean except for
`.agent/evidence/EP-009/drills/**`, and record the teardown proof (DOD-005).

The negative controls in M2 and the fault injection in M6 mutate state; each must restore and prove
restoration with a passing re-run plus `git diff --exit-code`.

If a credential or environment is unavailable, only stages with an explicit dependency on it are
blocked, and every independent stage continues (DOD-031). A blocked stage records its exact
taxonomy token with required fields — `BLOCKED_CREDENTIALS` (probe command, probe exit code,
`PREFLIGHT.md` row), `BLOCKED_ENVIRONMENT` (provisioning attempt log, missing property), or
`ERROR` (provisioning gap the adapter can fix, per DOD-033) — never a `PASS`.

Bounded retry: at most six attempts per milestone following the ladder — targeted fix, diagnosis,
real fallback, rollback, structured block — and never the same fix twice.

## 11. Progress

- [ ] M1: Build artifact creation in every supported format with digests
- [ ] M2: Environment configuration and configuration validation
- [ ] M3: CI/CD pipeline with no failure masking
- [ ] M4: Staging deployment and artifact-bound verification
- [ ] M5: Published README, install, and upgrade commands executed exactly as published
- [ ] M6: Rollback drill, backup/restore, and disaster recovery against reconciled state
- [ ] M7: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the exact command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
<!-- The executor records here the rulings of §7.9, the declared supported-format set, and every substitution made under a FALLBACK. -->

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. -->
