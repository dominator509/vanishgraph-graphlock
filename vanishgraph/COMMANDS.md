# Commands

Run from repo root with CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive.

**Coding agents must not invent commands.** Every command below is declared here, and
a milestone that needs a new one must add it here in the same change.

## Governance and control plane

| Command | Sentinel on success |
|---|---|
| `sh scripts/preflight.sh` | `preflight: ok` |
| `sh scripts/graph-next.sh` | `NEXT <NODE>` or `ALL_DONE` |
| `sh scripts/ledger.sh tail 30` | ledger lines |
| `sh scripts/ledger.sh status EP-000` | `DONE` or `PENDING` |
| `sh scripts/ledger.sh append <agent> <node> <event> "<detail>"` | (appends) |
| `python3 scripts/validate-generated-pack.py .` | `generated pack validation: ok` |
| `python3 scripts/anti-gaming-scan.py .` | `anti-gaming scan: ...` |

## Toolchain and static gates

| Command | Sentinel on success |
|---|---|
| `sh scripts/gate-toolchain.sh` | `gate-toolchain: ok` |
| `sh scripts/import-boundary.sh` | `import boundary: ok` |
| `sh scripts/typecheck.sh` | `typecheck: ok` |
| `sh scripts/lint.sh` | `lint: ok` |
| `sh scripts/format-check.sh` | `format check: ok` |
| `sh scripts/dependency-audit.sh` | `dependency audit: ok` |
| `sh scripts/security-check.sh` | `security check: ok` |
| `sh scripts/reality-gate.sh` | `reality gate: ok` |

## Tests and build

| Command | Sentinel on success |
|---|---|
| `sh scripts/test-unit.sh` | `test-unit: ok` |
| `sh scripts/test-collection-guard.sh` | `test collection guard: ok` |
| `sh scripts/test-integration.sh` | `test-integration: ok` |
| `sh scripts/test-e2e.sh` | `test-e2e: ok` |
| `sh scripts/coverage-gate.sh` | `coverage: ok` |
| `sh scripts/flake-guard.sh` | `flake guard: ok` |
| `sh scripts/double-boundary-guard.sh` | `double boundary guard: ok` |
| `sh scripts/mutation-gate.sh` | `mutation gate: ok` |
| `sh scripts/forced-failure.sh` | `forced failure: ok` |
| `sh scripts/regression-proof.sh` | `regression proof: ok` |
| `sh scripts/gate-test-hardening.sh` | `gate-test-hardening: ok` |
| `sh scripts/build.sh` | `build: ok` |
| `sh scripts/build-artifact.sh` | `artifact: built` |
| `sh scripts/build-reproducibility.sh` | `artifact reproducible: ok` |
| `sh scripts/artifact-identity.sh` | `artifact identity: ok` |
| `sh scripts/external-gates-status.sh` | `external gates status: N/M signed` |
| `sh scripts/external-gate-requests.sh` | `external gate requests: written` — writes one per-gate REQUEST packet (what is attested, what to return, the exact accepted record shape); it writes requests and never signatures, and `sentAt` stays absent until a human records the send |
| `sh scripts/config-validate.sh` | `config: ok` |
| `sh scripts/ci-guard.sh` | `ci pipeline: ok` |
| `sh scripts/epoch-pin.sh` | `epoch: pinned` |
| `sh scripts/harness-init.sh` | `harness init: ok` |
| `sh scripts/applicability-decide.sh` | `applicability: decided` |
| `sh scripts/harness-validate.sh` | `harness validation: ok` |
| `sh scripts/harness-accounting.sh` | `accounting: 484/484 accounted` — **not printed yet**: no per-ID status exists for epoch FORGE-SPEC-2, and the invariant is reported as `0/484 accounted` until the verification stages run |
| `sh scripts/harness-next.sh` | `NEXT <V-0NN>` or `ALL_STAGES_ACCOUNTED` |
| `sh scripts/harness-run-stage.sh <V-0NN>` | `stage <V-0NN>: accounted` (exit 0 on accounting completion even when candidate tests recorded FAIL; non-zero only on a harness ERROR) |
| `sh scripts/clean-room.sh` | `clean room: ok` — **not printed yet**: the virgin-room procedure runs and reports its inventory, and any undocumented prerequisite is a defect that suppresses the sentinel |
| `sh scripts/live-fire.sh` | `live-fire: ok` — **not printed yet**: 10 outcomes prove their rule at the domain/contract layer (`PARTIAL`) and 2 need a named external participant (`EXTERNAL_REQUIRED`) |
| `sh scripts/dod-gate.sh` | `definition of done: ok` — **not printed yet**: 15 of 42 clauses pass with linked evidence; every clause that does not carries the registry's exact `or_else` consequence |
| `sh scripts/staging-deploy.sh` | `staging deploy: ok` |
| `sh scripts/staging-verify.sh` | `staging verify: ok` |
| `sh scripts/install.sh` | `install: ok` |
| `sh scripts/published-commands.sh` | `published commands: ok` |
| `sh scripts/rollback-drill.sh` | `rollback drill: ok` — **never printed yet**: rollback to a previous version is `BLOCKED_ON_IMPLEMENTATION` because only one artifact version exists |
| `sh scripts/upgrade-drill.sh` | `upgrade drill: ok` — **never printed yet**: the from-prior path is `BLOCKED_ON_IMPLEMENTATION` because no released prior schema exists and `scripts/test-migrations.sh` is missing |
| `sh scripts/backup-restore-drill.sh` | `backup restore: ok` |
| `sh scripts/smoke-test.sh` | `smoke test: ok` |
| `sh scripts/live-fire.sh` | `live-fire: ok` |
| `sh scripts/egress-canary-test.sh` | `canary egress: ok` |
| `sh scripts/log-contract-guard.sh` | `log contract: ok` |
| `sh scripts/metrics-catalogue-guard.sh` | `metrics catalogue: ok` |
| `sh scripts/alert-catalogue-guard.sh` | `alert catalogue: ok` |
| `sh scripts/slo-evaluate.sh` | `slo: evaluated` (plus one `slo <objective>: <VERDICT>` line per objective) |
| `sh scripts/retention-config-guard.sh` | `retention config: ok` |
| `sh scripts/induced-failure-readiness.sh` | `readiness induced failure: ok` |

## Aggregates

| Command | Sentinel on success |
|---|---|
| `sh scripts/verify.sh` | `verify: ok` |
| `sh scripts/production-readiness-check.sh` | `production-readiness: accounted` |

## Notes

- `sh scripts/verify.sh` runs its fifteen stages in the order fixed by the master
  prompt (§10 Scripts): preflight, lint, format-check, typecheck, unit, integration,
  security-check, dependency-audit, reality-gate, test-collection-guard, build,
  artifact-identity, artifact-bound smoke, artifact-bound E2E, artifact-bound
  live-fire. It stops at the first failing stage and prints no sentinel unless all
  fifteen genuinely pass.
- `sh scripts/build-artifact.sh` produces the four declared formats under `dist/`
  (package tarball, CycloneDX SBOM, provenance, checksums) and publishes the §7.3
  identity. It refuses to build from a tree whose source is not committed, because an
  artifact that cannot be described by a commit SHA cannot be bound to a test. A
  build into a scratch directory keeps its identity inside that directory and does
  not publish, so a reproducibility run can never overwrite the identity that
  describes `dist/`.
- The OCI container-image format of SPEC-008 §7.2 is NOT produced: no container
  build definition exists anywhere in this repository. The status and the named next
  action are recorded in `docs/release/supported-formats.md`, and `RELEASE.md`
  states that container-format support is not claimed. Container-format support must
  not be reported as available.
- `sh scripts/config-validate.sh` validates the declared configuration surface
  against itself, against the code, and against SPEC-007 §7.2, and then validates a
  real environment when one is named (`--environment <class> --file <path>`). It
  never prints a value, only key names and reason codes, and it executes its own
  negative controls on every run: a control that stops discriminating fails the
  guard. See `ENVIRONMENT.md`.
- A stage that is not yet implemented exits non-zero with the mandated
  `ERROR: <stage> is an unimplemented placeholder; ...` signature. **Placeholder
  stages never pass silently** — that is a deliberate, load-bearing property.
- `scripts/count-tests.mjs` is an implementation detail of
  `scripts/test-collection-guard.sh` and is not intended to be run directly.

## Toolchain entry points

Toolchain (Node >= 24, npm, from the project root): `npm ci`; `npm run test:unit`;
`npm run gate:foundation`. These are the only package-manager entry points; the gates
themselves are the `sh scripts/*.sh` commands above.

`npm run` scripts are thin delegations to the shell gates, so there is exactly one
implementation of each check. They exist so a contributor or CI job can use the
conventional npm entry points without a second, divergent definition of "the tests":

| npm script | Delegates to |
|---|---|
| `npm ci` | installs the committed lockfile exactly (DOD-002) |
| `npm run typecheck` | `sh scripts/typecheck.sh` |
| `npm run lint` | `sh scripts/lint.sh` |
| `npm run format-check` | `sh scripts/format-check.sh` |
| `npm run build` | `sh scripts/build.sh` |
| `npm run test:unit` | `sh scripts/test-unit.sh` |
| `npm run test:collection-guard` | `sh scripts/test-collection-guard.sh` |
| `npm run reality-gate` | `sh scripts/reality-gate.sh` |
| `npm run dependency-audit` | `sh scripts/dependency-audit.sh` |
| `npm run gate:foundation` | `sh scripts/gate-foundation.sh` |
| `npm run verify` | `sh scripts/verify.sh` |

**`npm run test:unit` delegates to `scripts/test-unit.sh`, deliberately.** The
EP-001 ExecPlan originally prescribed `node --test "tests/**/*.test.ts"` here. That
glob sweeps in suites under `tests/integration/`, `tests/db/`, `tests/blackbox/`,
`tests/api/`, `tests/e2e/`, `tests/live-fire/` and `tests/release/`, which require a
provisioned database, a running API or a built artifact — so the entry point would
fail on a clean checkout and present a harness limitation as a product failure
(DOD-032). `scripts/test-unit.sh` excludes those roots; `TESTING.md` holds the
binding suite table. One definition of "the unit tests" exists, in the script.

## Gate commands and sentinels

`sh scripts/preflight.sh` (preflight: ok); `sh scripts/typecheck.sh` (typecheck: ok);
`sh scripts/import-boundary.sh` (import boundary: ok); `sh scripts/lint.sh` (lint: ok);
`sh scripts/format-check.sh` (format-check: ok); `sh scripts/test-unit.sh`
(test-unit: ok); `sh scripts/test-collection-guard.sh` (test collection guard: ok);
`sh scripts/build.sh` (build: ok); `sh scripts/gate-toolchain.sh` (gate-toolchain: ok);
`sh scripts/dependency-audit.sh` (dependency audit: ok); `sh scripts/reality-gate.sh`
(reality gate: ok); `sh scripts/validate-env.sh` (env validation: ok);
`sh scripts/mutation-check.sh` (mutation check: ok).

## Node gates

`sh scripts/gate-toolchain.sh` (gate-toolchain: ok, node EP-000);
`sh scripts/gate-foundation.sh` (gate-foundation: ok, node EP-001);
`sh scripts/gate-domain.sh` (gate-domain: ok, node EP-002);
`sh scripts/gate-data.sh` (gate-data: ok, node EP-003);
`sh scripts/gate-api.sh` (gate-api: ok, node EP-004). Later nodes add their own
`gate-<purpose>.sh` the same way. `gate-data` provisions, migrates, asserts the liveRLS inventory against `db/tenant-scoped-tables.txt`, proves cross-tenant read AND write
refusal as `vg_app`, proves `audit_event` is append-only, runs the database suites and
the mutation check, proves `verify.sh` now advances past `integration`, and tears the
container down with proof.

`gate-api` type-checks the service, enforces the three-rule layer import boundary, scans
the HTTP layer for a route that accepts a truth state as input (SM-6), runs the contract
suite that compares the route and error registries against SPEC-003 and SPEC-006, and
prints a `UNVERIFIED-BY-THIS-GATE` block naming each credential-dependent path it did not
exercise. It reports those as `BLOCKED_CREDENTIALS`; it never reports them as passing and
never substitutes a stub for one (EP-004 decision D4).

`sh scripts/copy-lint-gate.sh` (copy lint gate: ok, added by EP-004 M8, consumed by EP-005 M2)
is the vocabulary gate SPEC-003 VG-API-067 and SPEC-004 VG-UI-080…083 require. It regenerates
the OpenAPI document from the route registry, then scans the document, the registry, the route
modules, the DTOs and the application ports for SPEC-000 §4's forbidden synonyms used as
production identifiers — `client`, `target`, `victim`, `match`, `finding`, `score`, `request`,
`submission`, `file`, `job`, `task`, `check` and the rest — plus the ad-hoc status tokens
`DONE`, `COMPLETE`, `SUCCESS`, `REMOVED`. Two tokens are allowlisted **by exact name only**:
`X-Request-Id` and `requestId`, which SPEC-003 §7.3 sanctions as HTTP call tracing; every other
`request*` identifier fails. Allowlist entries carry a reason, and an entry without one fails the
gate (VG-UI-080). A hit prints the file, line and token and exits non-zero; a scan that read no
files also fails, because a gate that read nothing has verified nothing. **A hit is a defect to
fix, never a baseline to accept** (SPEC-006 §8 row 8).

The gate scans IDENTIFIERS, not prose: SPEC-000 §4 forbids these synonyms "used as production
identifiers", so SEMANTIC error messages — sentences shown to a human — are out of its scope by
construction, and the wording rules for what a user READS are the UI-copy rules EP-005 M2
applies through this same script.

### The security node (EP-006)

`sh scripts/gate-security.sh` (`gate-security: ok`) is this node's gate. It verifies what can be verified without a
provisioned Keycloak realm, PostgreSQL, Valkey or KMS: that the security modules type-check, that the layer import
boundary holds, that the scope vocabulary and role bundles are closed and equal to the specification, that the
credential-free security suites pass, and that no SPEC-006 §8 masking pattern exists in a gate script. **It prints an
`UNVERIFIED-BY-THIS-GATE` block on every run**, probing `KEYCLOAK_ISSUER`, `DATABASE_URL`, `VALKEY_URL` and
`CLOUD_WORKLOAD_IDENTITY` and recording each as `BLOCKED_CREDENTIALS` when the probe exits non-zero, plus the RLS second
layer as `BLOCKED_PREREQUISITE` and the two human gates as `EXTERNAL_REQUIRED`.

`sh scripts/security-check.sh` (`security check: ok`) runs the security stage in four steps: the secret scan, the
security contract suites (`tests/security/**` and the scope catalogue), the SSRF target-classification suite (arriving
with M9, and reported as `BLOCKED_PREREQUISITE` until then), and the masking-pattern scan. It fails closed and names what
it could not run.

`sh scripts/secret-scan.sh` (`secret scan: ok`) scans every tracked file except the lockfile and itself for private-key
headers, AWS access-key ids, real JSON Web Tokens and credential-shaped assignments, and refuses to report a clean scan
over too small a tree.

The credential probes that produce every `BLOCKED_CREDENTIALS` row are declared in `PREFLIGHT.md`:
`sh scripts/probes/keycloak.sh`, `sh scripts/probes/database_url.sh`, `sh scripts/probes/valkey_url.sh`,
`sh scripts/probes/object_store.sh`, `sh scripts/probes/github_app.sh`, `sh scripts/probes/stripe.sh`,
`sh scripts/probes/postal_api.sh`, `sh scripts/probes/search_api_key.sh`, `sh scripts/probes/local_model.sh`,
`sh scripts/probes/cloud_identity.sh`.

**THE PROBE CONTRACT (EP-010 M20; implemented in `scripts/lib/loud-fail.sh`).** A probe answers ONE question about ONE
declared credential and has exactly THREE outcomes, each a distinct exit code so that a caller never has to parse prose:
`0` REACHABLE (`vg_probe_ok <NAME> <detail>`, prints `<NAME>: ok - <detail>`); `1` UNPROVISIONED (`vg_require_env`, the
declared variable is unset); `2` CANNOT PROBE (`vg_probe_cannot <NAME> <why>`, this environment cannot host the check at
all). Two rules bind every probe: **it never prints a value** — not the credential, not a connection string, not a token,
only the key's name, a reason and a measured fact — and **it is discriminating** (SPEC-007 §7.2 rule 3), passing with the
dependency healthy and failing with it unavailable on the same code path, so a probe that cannot fail and a probe that
cannot pass are both defects. Outcome `2` is reserved for a check this environment genuinely cannot host; "I did not
implement the check" is a defect to record as a blocker, not an environment problem.
### The portal (EP-005)

`sh scripts/gate-ui.sh` (gate-ui: ok, node EP-005) is this node's gate. It verifies what can be
verified without launching a browser or a database: the UI type-checks (`tsc -p tsconfig.ui.json`),
the browser suites type-check (`tsc -p tsconfig.ui-tests.json`, which is where the DOM lib lives —
the root project has none, so the API layer cannot reach for a browser global), the layer import
boundary holds (including the UI rule that the browser bundle may not import
`src/domain|adapters|http|infrastructure`), the committed route manifest is the one the route tree
produces, the credential-free contract suites pass, the copy and vocabulary gate passes, and the
manifest equals SPEC-004 §1's declared route set. **It prints an `UNVERIFIED-BY-THIS-GATE` block on
every run** naming the browser stage, the manual assistive-technology validation (`EXTERNAL_REQUIRED`,
VG-UI-064/DOD-039), and the real-data flows (`BLOCKED_CREDENTIALS`), and it never reports those as
passing.

`npm run build:web` (`vite build`) emits `ui/src/route-manifest.json` from
`scripts/emit-route-manifest.ts` and then builds the static bundle into `ui/dist`. The manifest
emitter walks `ui/src/routes/**` and normalises TanStack's `$param` to SPEC-004's `[param]`; the
equality against the specification is asserted by `tests/contract/route-manifest.test.ts`, which
PARSES the specification's table rather than copying it. From M4 the bundle also carries the
stylesheet (`ui/src/tokens/truth-state.css` and `app.css`, imported by `src/main.tsx`): before that
milestone no CSS was imported at all, and every contrast or focus measurement would have measured a
browser default.

`npm run dev:web` (`vite`) runs the development server. **Acceptance never runs against it**:
`sh scripts/test-e2e.sh` (`end-to-end tests: ok`) requires the built bundle at `ui/dist/index.html`,
discovers the suites under `tests/ui/` and `tests/e2e/`, makes a real attempt at them, and classifies
honestly — a missing browser runtime is `BLOCKED_ENVIRONMENT` with the property named, no suites at
all is `FAIL`, and its sentinel appears only after the suites ran and passed against the built
artefact (SPEC-008 VG-SHIP-021/022). Playwright starts the artefact's own server
(`vite preview`, port 4173, bound to `127.0.0.1` because on this machine Vite's default host binds
IPv6 loopback only).

`npm run test:ui` (`playwright test`) runs both Playwright projects against the built bundle;
`npm run test:a11y` runs the axe-core project alone, so an accessibility failure is never reported as
a functional one. The suites are `tests/ui/states.spec.ts` (the seven region states, measured in a
real engine), `tests/ui/keyboard.spec.ts` (focus management on the built application, plus the five
keyboard flows recorded as `BLOCKED_PREREQUISITE` on M5/M6), `tests/ui/a11y.spec.ts` (axe-core over
every declared route, with the tool versions and per-route results written to
`.agent/evidence/EP-005/accessibility/`), and `tests/ui/reduced-motion.spec.ts` (a declared
transition is removed, not shortened, under `prefers-reduced-motion: reduce`). `npx playwright
--version` prints the pinned version.

### The service

`node src/infrastructure/main.ts` (serve, `npm run serve`) starts the `/v1` listener. It lives in
`src/infrastructure/` because it is the composition root: it reads configuration and constructs
the HTTP layer, and ARCHITECTURE.md §2 permits `infrastructure` to import everything while
forbidding `http` from importing infrastructure. Configuration is read from the
environment by `src/infrastructure/config.ts`, which fails closed: an absent required
variable aborts bootstrap with `dependency unavailable: <NAME> is unset; see PREFLIGHT.md
and .env.example`, naming the variable and never its value. `PORT=0` binds an ephemeral
port and prints the real one.

`node scripts/scan-truth-state-input.ts` (scan-truth-state-input) is the handler scan:
no request schema may declare `truthState` and no route path may name a truth state.
Exits non-zero with the offending file and line. `gate-api` runs it.

`sh scripts/import-boundary.sh` (import boundary: ok) enforces three rules: `src/domain`
imports only `node:*` and relative paths; `src/application` may additionally reach
`src/domain`; `src/http` must not reach `src/domain` internals, `src/adapters` or
`src/infrastructure` (its own framework is permitted — ARCHITECTURE.md §2 forbids
frameworks for `domain` only).

## Evidence

`sh scripts/evidence-index.sh` (evidence index: ok) rebuilds
`.agent/evidence/EP-001/INDEX.txt`, classifying each artifact as `STABLE` (digest is a
durable identity, safe to bind evidence to under DOD-029) or `VOLATILE` (the file embeds
a timestamp, UUID or measurement, so no digest is recorded for it). A single
indiscriminate hash of every evidence file is wrong by construction, because run
transcripts legitimately differ on every run. Pass a node id to index that node's
evidence: `sh scripts/evidence-index.sh EP-002`.

## Database (disposable, provisioned by the graph; never production)

`sh scripts/db-provision.sh` (db provision: ok); `sh scripts/db-teardown.sh`
(db teardown: ok).

`db-provision.sh` starts a pinned `postgres:16` container on a free local port and creates
two roles — `vg_owner` (owns schema objects, runs migrations) and `vg_app` (runtime, no
ownership, **no `BYPASSRLS`**, no `TRUNCATE`) — plus four isolated databases:
`vanishgraph_main` (integration), `vanishgraph_empty` (MIG-1), `vanishgraph_prior`
(MIG-2) and `vanishgraph_failure` (MIG-4). It is idempotent: a running container with a
valid state file is reused.

Generated passwords live **only** in a mode-0600 state file outside the repository
(`${TMPDIR}/vanishgraph-db.env`), never in the repository and never in `argv`
(VG-SEC-002). When the Docker daemon is unreachable and `DATABASE_URL` is unset, the
command classifies the outcome `BLOCKED_ENVIRONMENT` and prints no sentinel — it never
reports success and never records a candidate failure (DOD-032, DOD-033).

### Migrations

`sh scripts/migrate.sh up --dsn <owner-dsn>` (migrate: ok) applies `db/migrations/*.sql`
in order and records each in `schema_migration`; `up` is the declared entry point, and
`--dsn` defaults to `VG_TEST_DSN_OWNER`. `sh scripts/generate-rls.ts --write|--check`
(rls generation: ok) embeds the RLS block for every tenant-scoped table into the
migration that creates it; `--check` is what the gates run, and it also refuses a table
with a `tenant_id` column that `db/tenant-scoped-tables.txt` does not name.
`sh scripts/check-rls-coverage.sh` (rls coverage: ok) verifies the live database
instead of the source text.

### Database test suites

The database suites run against the provisioned PostgreSQL, never a substitute, so they
are **not** in the unit stage. Run them through the integration manifest:

```sh
sh scripts/db-provision.sh
. "${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}"
sh scripts/migrate.sh up --dsn "$VG_TEST_DSN_OWNER"
export VG_TEST_DSN_OWNER VG_TEST_DSN_APP
VG_TEST_GLOB="tests/db/**/*.test.ts" \
  VG_EXPECTED_MANIFEST=.agent/verification/EXPECTED_INTEGRATION_MANIFEST.txt \
  sh scripts/test-collection-guard.sh
```

`tests/db/rls.test.ts` proves tenant isolation (VG-DATA-001…003) and
`tests/db/job-queue.test.ts` proves the transactional enqueue property of ADR-016 — that
a rolled-back transition leaves no job row. Each asserts against the real database because
RLS, FORCE RLS and constraint behaviour are exactly what an in-memory substitute would
change.

### Encryption and retention

`tests/db/encryption.test.ts` exercises envelope encryption (SPEC-002 §4): ciphertext
differs from plaintext, a wrong key fails closed rather than returning garbage, rotation
leaves old rows readable via `key_version`, and cross-tenant decryption is impossible.
`tests/db/retention.test.ts` exercises RET-1…RET-3: windows are resolved from
`jurisdiction_policy` rows so a policy change alters them with no code change, an unstated
window resolves to `UNRESOLVED` rather than an invented default, and a shredded subject's
PII becomes unrecoverable while its audit events remain.

Both run against the local file-backed provider in `src/adapters/crypto/`, which is
**tests only** (ADR-006 is OPEN; SPEC-002 §4). The managed-KMS adapter is `BLOCKED_CREDENTIALS` while
ADR-006 is open and throws on every operation rather than faking success. No command in
this file configures a production KMS, because none exists yet.

### Backup and restore drill

`sh scripts/backup-drill.sh` (backup drill: ok) is a **destructive** drill (DOD-036). It
seeds a disposable database, crypto-shreds one subject, dumps the database, destroys it,
restores it from the dump alone, and then reports eight post-conditions individually: the
erased subject's PII is unrecoverable, its tombstone is present and names it, RLS is
enabled and forced on every tenant-scoped table, a cross-tenant read as `vg_app` returns
nothing while the tenant's own rows stay visible, the audit chain and its append-only rules
are intact, every evidence digest verifies, and the restore did **not** resurrect erased
PII. The last is a severity-1 assertion, not a warning.

It operates only on the disposable container from `db-provision.sh` and refuses to run
against anything else. Evidence goes to `.agent/evidence/EP-003/restore-drill/`; the dump
itself is identified by digest and is not committed.

**PITR is not exercised.** Point-in-time recovery needs WAL archiving to object storage
that is not provisioned, so it is recorded `BLOCKED_CREDENTIALS` in
`.agent/evidence/EP-003/restore-drill/pitr-status.txt`. No RPO, RTO or MTTR figure is
claimed anywhere, and no command in this file produces one.
