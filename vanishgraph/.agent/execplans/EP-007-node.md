NODE-META-BEGIN
ID: EP-007
DEPS: EP-006
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-test-hardening.sh
VERIFY_SENTINEL: gate-test-hardening: ok
GREEN_TAG: green/EP-007
NODE-META-END

# EP-007 — Testing Hardening

## 1. Purpose / Big Picture

The product layer exists after EP-002…EP-006, but existence is not proof. This node makes
the test suite **discriminating**: every claimed behaviour is bound to a requirement ID, an
executed test, and a retained evidence path; a test that passes because it observes nothing
is a defect, not a result (DOD-018); a suite that collects zero tests is a harness `ERROR`,
not a green (DOD-007); a double that stands in for a real dependency may isolate a unit but
may never be the sole proof of a production claim (DOD-010).

At the end of this node a cold executor must be able to run one command —
`sh scripts/gate-test-hardening.sh` — and receive an honest answer about whether the suite
proves the product, not merely whether it ran. Nothing in this node may produce a green that
is not backed by a real assertion against real logic.

This node is where the pack's central sentence is cashed out: *"Software that appears to work
is a failure state. Only software proven by live-fire counts."* A permanently green test is
the most expensive form of false evidence, because it is the artifact everyone trusts.

## 2. Scope

In scope:

- The normative testing targets: thresholds, test-double boundaries, flake policy, collection
  rules, and mutation sensitivity, written into `TESTING.md` so that later gates have an
  oracle that is data, not opinion.
- Regression coverage for all twelve `LIVE-FIRE-PROOF-01`…`LIVE-FIRE-PROOF-12` outcomes.
- Real forced-failure tests for fail-closed behaviour (DOD-014).
- Mutation sensitivity for every critical feature (DOD-018).
- Flaky-test purge and the collection-guard negative controls (DOD-006, DOD-007).
- Test-double boundary enforcement and the anti-simulation check (DOD-010, DOD-019).
- Wiring the new gates into the existing CI workflow and into `COMMANDS.md`.
- Evidence-backed updates to the traceability files for the IDs this node actually proves.

## 3. Non-goals

- No product feature work. A missing behaviour is EP-002…EP-006's defect and is reported as
  `FAIL` here, never implemented here.
- No observability implementation (EP-008), no packaging, release, staging, or rollback work
  (EP-009), no candidate-epoch freeze, verification subgraph, DOD gate, or release verdict
  (EP-010).
- No weakening of any gate, threshold, oracle, or waiver rule; no retry-until-green; no
  skipping, quarantining, or `xfail`-ing a required test to obtain a pass (DOD-006, DOD-024,
  DOD-027).
- No mocks as final proof, and no test-double in a live-fire or artifact-bound suite
  (DOD-010, DOD-020).
- No production deployment (prohibited: VG-SCOPE-009).
- No deletion of a test suite without an ADR; no removal of an
  `.agent/verification/EXPECTED_TEST_MANIFEST.txt` line to make the guard pass (DOD-027).

## 4. Context and Orientation

Laws and authorities: `AGENTS.md` is authoritative; `.agent/specs/SPEC-000-product-scope.md`
is the specification oracle (§4 vocabulary lock, §5 truth model, §6 requirement catalogue, §9
acceptance oracle, §10 traceability). `.agent/DONE_LAW.md` holds the 42 clauses. Commands come
only from `COMMANDS.md`; names come only from the vocabulary tables.

Reality of the repository at the time this plan was authored — the executor must re-confirm it
rather than assume it:

- The only product code is the domain layer: `src/domain/errors.ts`, `src/domain/truth-state.ts`,
  `src/domain/state-machine.ts`, `src/domain/values.ts`, with two suites,
  `tests/domain/values.test.ts` and `tests/domain/state-machine.test.ts`. TypeScript 5.9.3 and
  `@types/node` 24.10.1 are exact-pinned devDependencies; Node is pinned at `>=24.0.0`
  (`package.json`), and `tsconfig.json` is `strict` with `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`, and `verbatimModuleSyntax`.
- `scripts/test-unit.sh`, `scripts/test-integration.sh`, `scripts/test-collection-guard.sh`,
  `scripts/reality-gate.sh`, `scripts/lint.sh`, `scripts/typecheck.sh`, `scripts/build.sh`,
  and the remaining gates were **loud-fail placeholders** that printed an unconditional
  success sentinel against an empty repository. EP-000 replaced the false greens with a loud
  failure (`scripts/lib/loud-fail.sh`) and each script names the node that must implement it:
  `test-unit`/`test-collection-guard`/`reality-gate` → EP-001, `test-integration` → EP-002.
  By the time EP-007 runs, those scripts must be real implementations. If any of them still
  prints `ERROR: … is an unimplemented placeholder …`, that is a finding about the upstream
  node, not something this node papers over.
- `.agent/verification/MASTER_TEST_REGISTRY.csv` contains exactly **484** unique IDs with
  prefix counts GEN 122 / HIPAA 125 / BC 202 / E2E 20 / SUP 15. This node must not add,
  delete, or renumber a row.
- `.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv` holds 12 rows for
  `LIVE-FIRE-PROOF-01`…`-12`. Their current values are placeholders (`"planned public
  entrypoint"`, `"EP-000 binding"`, `"planned production path"`, `"evidence required"`,
  `"UNPINNED"`, `"PLANNED"`). They are **not** evidence and must be replaced with real,
  discovered values or left honestly `UNVERIFIED`.
- `.agent/verification/REQUIREMENT_TRACEABILITY.csv` maps `LIVE-FIRE-PROOF-01`…`-12` to
  `E2E-001`…`E2E-012`. That mapping is a **placeholder mapping**: the registry's `E2E-001` is
  titled *Smoke & Infrastructure Verification* and `E2E-003` is *Full Functional
  Verification*. The correct owner is decided from
  `.agent/verification/MASTER_TEST_REGISTRY.csv` titles and `.agent/verification/GRAPH.md`
  stage ownership, and the decision is recorded (see §7.6).
- Two of the twelve outcomes are externally constrained today:
  `LIVE-FIRE-PROOF-08` (provider transport) carries `EXTERNAL_REQUIRED` because no provider
  entitlement is provisioned, and `LIVE-FIRE-PROOF-12` (enterprise authorization) carries
  `EXTERNAL_REQUIRED` for the human sign-off. Their **in-product rules** (official transports
  only; tenant and authority boundaries) are still testable here and must be tested here; the
  external runs stay `EXTERNAL_REQUIRED`.
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt` currently lists two suites. Every suite this
  node creates must be added to it.
- `.agent/verification/state/RUN_STATE.json` is `PLANNED`; `.agent/verification/state/
  RELEASE_GATE.json` is `INCONCLUSIVE` with reason `FORGE_ONLY`; `.agent/verification/state/
  TEST_LEDGER.jsonl`, `DOD_STATUS.jsonl`, and `STATUS_TRANSITION_AUDIT.jsonl` are empty;
  `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv` and
  `.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv` have **zero data rows**.
  This node does not change the verdict and does not begin the 484 accounting: that is EP-010.

**TESTING.md is currently a stub.** It states topics ("Real dependency tests, artifact-bound
E2E, mutation proof, collection guards, and test-double boundaries") but contains **no
coverage target, no threshold, and no double-zone enumeration**. Because the master prompt
requires "coverage to TESTING.md targets" and this node must reach them, milestone M1 authors
those targets into `TESTING.md` as normative, machine-readable values and records the authoring
as a decision. Until M1 completes, "the TESTING.md target" has no referent and no coverage claim
in this repository is meaningful.

## 5. Files to Read First

Control plane and laws:

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`
- `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/DONE_LAW.md` (all 42 clauses)
- `.agent/checklists/implementation.md`, `.agent/checklists/validation.md`
- `.agent/prompts/execute-active-execplan.md`, `.agent/prompts/continue-execplan.md`
- `.agent/state/LEDGER.md`

Specifications:

- `.agent/specs/SPEC-000-product-scope.md` (§4 vocabulary lock, §5 truth model, §6 catalogue,
  §7 coverage honesty, §9 acceptance oracle, §10 traceability, §11 human-authority items)
- `.agent/specs/SPEC-001-core-domain.md` (§1 layer contract, §4 state machine, §5 ports)
- `.agent/specs/SPEC-006-errors.md` (§4 verification status taxonomy, §7 fail-closed rules,
  §8 no-masking rules, §9 no-PII-in-errors, §10 retry and the bounded ladder)
- `.agent/specs/SPEC-008-production-readiness.md` (§1 shippable, §7 artifact-bound acceptance,
  §10 no-masking, §11 evidence preservation)

Test doctrine and harness vocabulary:

- `TESTING.md`, `ARCHITECTURE.md`, `SECURITY.md`, `REMOVAL_EFFECTIVENESS_METRICS.md`
- `.agent/verification/HARNESS_LAWS.md`, `.agent/verification/GRAPH.md`,
  `.agent/verification/EXECUTION_DAG.md`
- `.agent/verification/MASTER_TEST_REGISTRY.csv`, `.agent/verification/DOD_REGISTRY.csv`
- `.agent/verification/APPLICABILITY_MATRIX.csv`,
  `.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`,
  `.agent/verification/REQUIREMENT_TRACEABILITY.csv`
- `.agent/verification/E2E_SUITE_LIBRARY.md`, `.agent/verification/ATOMIC_TEST_FACTORY.md`
  (read the sections for the E2E IDs this node maps, not the whole file)
- `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`,
  `.agent/verification/CAPABILITY_MATRIX.md`
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`

Code and gates actually present:

- `package.json`, `tsconfig.json`, `.gitignore`, `.env.example`
- `src/domain/errors.ts`, `src/domain/truth-state.ts`, `src/domain/state-machine.ts`,
  `src/domain/values.ts`, and every other file under `src/**` produced by EP-002…EP-006
- every file under `tests/**`
- `scripts/test-unit.sh`, `scripts/test-integration.sh`, `scripts/test-collection-guard.sh`,
  `scripts/count-tests.mjs`, `scripts/import-boundary.sh`, `scripts/reality-gate.sh`,
  `scripts/lib/loud-fail.sh`, and `.github/workflows/ci.yml`

## 6. Expected Changed Files

Created:

- `scripts/coverage-gate.sh`
- `scripts/regression-proof.sh`
- `scripts/forced-failure.sh`
- `scripts/mutation-gate.sh` (extends `scripts/mutation-check.sh` and `scripts/lib/mutations.ts`, which EP-002 created; it must IMPORT that mechanism, never reimplement it — two mutation systems would let the same guard be proven and unproven at once)
- `scripts/flake-guard.sh`
- `scripts/double-boundary-guard.sh`
- `scripts/gate-test-hardening.sh`
- `.agent/verification/MUTATION_CATALOG.md`
- `config/testing/coverage-thresholds.json`
- `config/testing/flake-runs.json`
- `tests/regression/live-fire-proof-01.test.ts` … `tests/regression/live-fire-proof-12.test.ts`
  (twelve files)
- `tests/failure/fail-closed-authority.test.ts`
- `tests/failure/fail-closed-recipe.test.ts`
- `tests/failure/fail-closed-credentials.test.ts`
- `tests/failure/fail-closed-dependency.test.ts`
- `tests/failure/fail-closed-egress.test.ts`
- `tests/doubles/README.md` (the in-repo, non-normative pointer to the TESTING.md zone)
- `.agent/evidence/EP-007/**`

Modified:

- `TESTING.md`
- `COMMANDS.md`
- `.github/workflows/ci.yml`
- `.agent/verification/EXPECTED_TEST_MANIFEST.txt`
- `.agent/verification/REQUIREMENT_TRACEABILITY.csv`
- `.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`
- `.agent/verification/state/RUN_MANIFEST.json`
- `.agent/state/LEDGER.md`
- `tests/**` — only where a flaky test is fixed in M5; the exact files are named in that
  milestone's CONTENT and recorded in its evidence. No other test file may change.

Conditionally modified, only if the milestone's FALLBACK is taken (and then named in the
Decision Log):

- `package.json`, `package-lock.json` (only if a coverage or mutation tool is added under the
  dependency rules)

Nothing else may change. Any other diff is a scope violation and must be reverted, not
explained (`.agent/EXECUTION_RULES.md`, anti-drift).

## 7. Interfaces and Contracts

### 7.1 Gate-script contract

Every script this node adds is POSIX `sh`, `#!/usr/bin/env sh`, `set -eu`, runs from the
repository root, exports
`CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive`,
passes `sh -n`, prints its **exact sentinel only on genuine success**, and exits non-zero on
failure. No script may print a success sentinel from a path that performed no check, and no
script may use `|| true`, `continue-on-error`, or a swallowed exit code (DOD-024).

Sentinels introduced by this node, declared in `COMMANDS.md` in the milestone that creates them:

| Command | Sentinel |
|---|---|
| `sh scripts/coverage-gate.sh` | `coverage: ok` |
| `sh scripts/regression-proof.sh` | `regression proof: ok` |
| `sh scripts/forced-failure.sh` | `forced failure: ok` |
| `sh scripts/mutation-gate.sh` | `mutation: ok` |
| `sh scripts/flake-guard.sh` | `flake guard: ok` |
| `sh scripts/double-boundary-guard.sh` | `double boundary: ok` |
| `sh scripts/gate-test-hardening.sh` | `gate-test-hardening: ok` |

### 7.2 Test runner interface

This node **does not** call a test runner directly except in M1's discovery step. It calls the
stack-neutral wrappers owned by earlier nodes — `sh scripts/test-unit.sh`,
`sh scripts/test-integration.sh`, `sh scripts/test-e2e.sh` — so that the runner chosen in
EP-001 (currently `node --test` per `package.json`) is a single point of change. If an earlier
node replaced the runner, the wrappers are unchanged and this plan still applies.

### 7.3 Requirement-to-test binding

Every test this node writes names its requirement ID(s) in the test title or an adjacent
comment, using **canonical vocabulary only** (SPEC-000 §4). A test name containing a forbidden
synonym (`client`, `target`, `victim`, `hit`, `listing`, `match`, `ticket`, `job`, `task`,
`submission`, `request`, `sanitizer`, `cleaner`, `scraper`, `script`, `bot`) as an identifier
for a canonical concept is itself a defect that
`scripts/gate-test-hardening.sh` reports. `MATCH_CONFIRMED`, `REQUEST_SUBMITTED`,
`REQUEST_READY`, and `RequestCase` are canonical tokens and are not synonyms.

### 7.4 Truth-model invariants the regression suites must assert

These are non-negotiable and each has its own required negative case (SPEC-000 §5.1):

- `REQUEST_SUBMITTED` is never rendered, counted, or logged as a removal.
- `ACKNOWLEDGED` never satisfies a removal acceptance criterion.
- `SEARCH_DELISTED` never increments a source-removal count; search and source are separate
  effects.
- `VERIFIED_REMOVED` requires a linked `VerificationObservation` from a path **different**
  from the acting path (DOD-012); same-session self-report is insufficient.
- `VERIFIED_NOT_PRESENT` requires a valid in-scope scan and is reported with coverage bounds
  when coverage is partial.
- `NOT_REMOVABLE` and `HUMAN_REQUIRED` are first-class results and are never hidden to improve
  an apparent success rate.
- Every coverage percentage carries its denominator; a percentage without a denominator is a
  defect.

### 7.5 Taxonomy vocabulary for statuses written by this node

Any status this node writes into a ledger, CSV, JSONL, or report uses exactly one token from
SPEC-006 §4.1: `PASS`, `FAIL`, `ERROR`, `BLOCKED_PREREQUISITE`, `BLOCKED_ENVIRONMENT`,
`BLOCKED_CAPABILITY`, `BLOCKED_CREDENTIALS`, `BLOCKED_SAFETY`, `EXTERNAL_REQUIRED`,
`DEFERRED_LONG_RUNNING`, `INCONCLUSIVE`, `PARTIAL`, `SIMULATED`, `UNVERIFIED`,
`NOT_APPLICABLE`, `WITHDRAWN`. `PASS` requires executed evidence in the current epoch with
`command`, `exitCode`, `sentinel`, `artifactDigest`, `testIds[]`, `evidenceDigest`. Paraphrases
("mostly passing", "effectively complete") are DOD-026 defects.

### 7.6 Rulings this plan makes, to be re-recorded in §13 by the executor

1. **Node verify command.** The stub header declared `VERIFY: sh scripts/verify.sh` /
   `VERIFY_SENTINEL: verify: ok` for all eleven nodes. `verify.sh` ends with artifact-identity,
   artifact-bound smoke, artifact-bound E2E, and artifact-bound live-fire, which cannot pass
   before EP-009 builds an artifact and EP-010 implements live-fire. Keeping that header would
   make EP-007 permanently unclosable and would pressure an executor to fake a green. This
   node's verify is therefore `sh scripts/gate-test-hardening.sh` with sentinel
   `gate-test-hardening: ok`. No stage is removed from `verify.sh`, its order is unchanged, and
   nothing is weakened; the narrowing is recorded and ratified like EP-000's D1.
2. **TESTING.md targets are authored here.** The master prompt requires coverage to TESTING.md
   targets, but TESTING.md has none. M1 authors them as normative data with a stated rationale.
   The targets are a plan-level ruling, ratifiable by the owner, and are not to be lowered
   afterwards to obtain a pass (DOD-027).
3. **`LIVE-FIRE-PROOF-NN` → `E2E-0NN` is a placeholder mapping.** The real owner of each
   outcome inside the 484 registry is decided from the registry's `title` and `default_stage`
   columns and from stage ownership in `.agent/verification/GRAPH.md`, and the decision is
   written into the Decision Log. A placeholder mapping may never be used to move a claim to
   `PASS`.
4. **CI observation.** Remote CI observation requires the GitHub credentials declared in
   `PREFLIGHT.md` (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`). If they
   are not provisioned, the CI stages are executed locally with `CI=true` and remote pipeline
   observation is recorded as `BLOCKED_CREDENTIALS` with the probe evidence — never reported as
   a green pipeline.

## 8. Milestones

### M1: Normative testing targets in TESTING.md and a real coverage gate

GOAL: `TESTING.md` states machine-checkable targets and `sh scripts/coverage-gate.sh` measures
coverage against them and can genuinely fail.

READ: `TESTING.md`, `.agent/DONE_LAW.md` (DOD-001, DOD-006, DOD-007, DOD-008, DOD-018),
`.agent/specs/SPEC-000-product-scope.md` §9–§10, `.agent/specs/SPEC-001-core-domain.md` §1,
`.agent/specs/SPEC-006-errors.md` §4.1, `scripts/test-unit.sh`, `scripts/count-tests.mjs`,
`scripts/lib/loud-fail.sh`, `COMMANDS.md`, `package.json`, `tsconfig.json`.

CHANGE: `TESTING.md`, `config/testing/coverage-thresholds.json`, `config/testing/flake-runs.json`,
`scripts/coverage-gate.sh`, `COMMANDS.md`, `.agent/state/LEDGER.md`.

CONTENT:

(a) Anchored edit to `TESTING.md`. Current exact text (lines 12–18):

```
## Project requirements
- LIVE-FIRE-PROOF-01 through LIVE-FIRE-PROOF-12
- REQUEST_SENT is distinct from VERIFIED_REMOVED
- SEARCH_DELISTED is distinct from source deletion
- verified authority is required before external writes
- provider-authorized transports only
- manual production deployment only
```

Replace it with the following complete section (transcribe verbatim; the shell block is the
machine-readable copy and must equal `config/testing/coverage-thresholds.json`):

````
## Project requirements
- LIVE-FIRE-PROOF-01 through LIVE-FIRE-PROOF-12
- REQUEST_SENT is distinct from VERIFIED_REMOVED
- SEARCH_DELISTED is distinct from source deletion
- verified authority is required before external writes
- provider-authorized transports only
- manual production deployment only

## Test pyramid and layer ownership

| Layer | Suite location | Required test kinds | Real dependency required |
|---|---|---|---|
| `domain` | `tests/domain/` | unit, boundary, invariant, state-transition, negative | no (pure, standard library only) |
| `application` | `tests/application/` | unit with port doubles, command precondition, idempotency | no |
| `adapters` | `tests/adapters/`, `tests/integration/` | contract, integration against production-type dependencies | yes |
| `http` / `ui` / `mcp` | `tests/api/`, `tests/e2e/` | contract, black-box acceptance, browser E2E through the real entry point | yes |
| `infrastructure` | `tests/infrastructure/`, `tests/release/` | composition, smoke, artifact-bound acceptance | yes, exact artifact |

## Coverage targets (DOD-008)

Targets are enforced per layer by `scripts/coverage-gate.sh`. Line coverage is measured over
the layer's own sources; generated, vendored, and type-only files are excluded, and every
exclusion carries a reason in the coverage configuration. Lowering a target requires a
specification change and a recorded rationale; lowering a target to obtain a pass is
prohibited (DOD-027).

```json
{
  "targets": {
    "domain":         { "lines": 90, "branches": 85, "functions": 95 },
    "application":    { "lines": 85, "branches": 80, "functions": 90 },
    "adapters":       { "lines": 75, "branches": 70, "functions": 80 },
    "http":           { "lines": 70, "branches": 65, "functions": 75 },
    "ui":             { "lines": 70, "branches": 65, "functions": 75 },
    "mcp":            { "lines": 70, "branches": 65, "functions": 75 },
    "infrastructure": { "lines": 60, "branches": 55, "functions": 65 }
  }
}
```

Coverage is a floor, not a proof: a covered line with no assertion is not evidence (DOD-008),
and mutation sensitivity (DOD-018) is what shows a suite observes the behaviour it claims.

## Test-double zone (DOD-010)

Doubles are legal **only** in: `tests/**`. Within `tests/**`, doubles are further restricted:

| Directory | Doubles permitted | Rationale |
|---|---|---|
| `tests/domain/`, `tests/application/` | yes, including in-memory ports | pure logic; the port is the seam |
| `tests/adapters/`, `tests/integration/` | allowed only for a dependency that is genuinely absent, and then the row is `SIMULATED` | at least one production-type dependency run is required |
| `tests/e2e/`, `tests/live-fire/`, `tests/release/` | **no doubles of any kind** | these suites are the acceptance boundary |
| `src/**` | **no doubles, ever** | a double in a production path is DOD-020 |

A double is never the sole evidence for a claim in
`.agent/verification/CLAIM_TO_RELEASE_TRACEABILITY.csv`; a claim resting on a double is
`SIMULATED` and cannot satisfy a release gate. `Clock` and `IdGenerator` are injected ports
(SPEC-001 §5) and are not doubles of the thing under test.

## Flaky-test policy (DOD-006)

A flaky test is a defect in the product, the test, the environment, or the oracle until
explained. Retry-until-green is prohibited. The permitted resolutions are exactly: fix the
defect; fix the oracle with a recorded reason; or delete the test with an ADR that names what
it was protecting and what now protects it. `scripts/flake-guard.sh` runs each suite
`flakeRuns` times (default 5, `config/testing/flake-runs.json`) with a fixed seed and fails on
any verdict change. The first failing output is preserved, never overwritten.

## Collection rules (DOD-007)

- Zero collected tests is an `ERROR`, never a pass.
- Every path in `.agent/verification/EXPECTED_TEST_MANIFEST.txt` must contribute at least one
  collected test.
- All-skipped and shrunk collections fail.
- Removal of a manifest line requires an ADR.

## Mutation sensitivity (DOD-018)

At least one controlled defect exists for every critical feature listed in
`.agent/verification/MUTATION_CATALOG.md`, and the mapped test must **fail** while the defect
is present and pass after restoration. A mutation that does not change any observed verdict
means the mapped test is non-discriminating and its pass proves nothing.
````

Verification grep: `grep -c 'Coverage targets (DOD-008)' TESTING.md` must print `1`, and
`node -e "JSON.parse(require('fs').readFileSync('config/testing/coverage-thresholds.json','utf8'))"`
must exit 0. If the current text of `TESTING.md` differs from the anchor above because an
earlier node already edited it, append the same section after the last existing line instead
of replacing, and record the substitution in the Decision Log in one clause.

(b) `config/testing/coverage-thresholds.json` — the JSON block above, byte-identical.
(c) `config/testing/flake-runs.json` — `{ "flakeRuns": 5, "seed": "vg-flake-1" }`.
(d) `scripts/coverage-gate.sh` — discovers the coverage capability, measures per layer, compares
to the thresholds file, and prints `coverage: ok` only when every measured layer meets every
target. It must fail (non-zero, no sentinel) when any target is unmet, when the configuration
file is missing, and when coverage cannot be measured at all (that last case is `ERROR`, not
`PASS`). Fill the runner flag blank with the discovery output below.
(e) `COMMANDS.md` — append the two new commands and their exact sentinels to the declared
command table. Do not reformat unrelated lines.

Exact discovery commands whose output fills the flag blank in (d):

```
node --help | grep -i -n 'coverage'
node --test --experimental-test-coverage tests/domain/ 2>&1 | tail -30
git ls-files 'src/**/*.ts' | sed 's#/[^/]*$##' | sort -u
```

The first two confirm how this Node build exposes coverage; the third fills the layer-path list
used for the per-layer measurement. Record both outputs verbatim in
`.agent/evidence/EP-007/M1-discovery.txt`.

RUN:

```
node --version
node --help | grep -i coverage
node --test --experimental-test-coverage tests/domain/ 2>&1 | tail -30
sh scripts/coverage-gate.sh
grep -c 'Coverage targets (DOD-008)' TESTING.md
grep -c 'coverage-gate.sh' COMMANDS.md
```

EXPECT: `coverage: ok` on the line produced by `sh scripts/coverage-gate.sh`; the two `grep -c`
commands print `1` and `1`. If the measured coverage is below target, the milestone FAILS and
the missing tests are added — the thresholds are not lowered. Note on line endings: several
pack-authored files (including `TESTING.md`, `PREFLIGHT.md`, and the verification CSVs) use CRLF.
Grep patterns in this plan therefore avoid the `$` anchor; if you add one, make it CR-tolerant.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 MILESTONE_PASS "M1 coverage: ok; TESTING.md targets normative"`

FALLBACK: if this Node build cannot emit coverage with a built-in flag, add `c8` as an
exact-pinned devDependency (dependency rules: check existing deps, prefer existing tools, pin
exact version, document, update install docs) and measure with `npx c8 --reporter=json-summary
--reporter=text node --test tests/`; record the addition and the version in `COMMANDS.md`,
`ARCHITECTURE.md`'s toolchain table, and the Decision Log. Never reduce a target, and never
substitute an assertion-count proxy for measured coverage.

COMMIT: `git add -A && git commit -m "[EP-007][M1] normative testing targets and real coverage gate"`

### M2: Regression proof for all twelve LIVE-FIRE-PROOF outcomes

GOAL: All twelve core outcomes have a real regression test that asserts the outcome's own rule
and its negative case, and the traceability files point at those tests instead of at
placeholders.

READ: `TESTING.md` (as amended in M1), `.agent/verification/REQUIREMENT_TRACEABILITY.csv`,
`.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`,
`.agent/verification/MASTER_TEST_REGISTRY.csv` (E2E rows), `.agent/verification/GRAPH.md`,
`.agent/verification/E2E_SUITE_LIBRARY.md` (the E2E sections this milestone maps),
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/specs/SPEC-000-product-scope.md`
§5–§6, `tests/**`, `src/**`.

CHANGE: `tests/regression/live-fire-proof-01.test.ts` … `-12.test.ts`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`,
`.agent/verification/REQUIREMENT_TRACEABILITY.csv`,
`.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`, `scripts/regression-proof.sh`, `COMMANDS.md`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) Twelve regression suites. One file per outcome, each asserting the outcome's rule **and**
its negative case, at the layer the outcome actually lives in. The twelve outcomes and the rule
each file must assert:

| # | Outcome | Rule the suite must assert | Required negative case |
|---|---|---|---|
| 01 | Subject-bound discovery | Discovery is read-only by default and declares its coverage surface (VG-DISC-001, VG-DISC-002) | A discovery run attempting a write is denied and audited; a partial run cannot report "no exposure found" unqualified |
| 02 | Controller removal closed loop | `VERIFIED_REMOVED` requires a linked `VerificationObservation` from a distinct path and the elapsed observation window (VG-VERIFY-001, VG-VERIFY-002) | Immediate same-second recheck is insufficient; a `Controller` claiming deletion without an observation stays `ACKNOWLEDGED` |
| 03 | Multi-channel escalation | Channel selection follows the documented priority order with rejected alternatives and reasons recorded (VG-CHANNEL-001) | A lower-priority channel cannot be selected while a lawful higher-priority one is available |
| 04 | Source and search separation | `SEARCH_DELISTED` and source removal are separate effects and separate states (SPEC-000 §5.1) | A delisted search result never increments a source-removal count and never renders as source deletion |
| 05 | Reappearance monitoring | `REAPPEARED` links to the prior `VERIFIED_REMOVED` event and re-enters the flow with preserved history (VG-REAPPEAR-001, VG-REAPPEAR-002) | A first-ever discovery is never labelled `REAPPEARED` |
| 06 | Custom internet removal | Unknown or unsafe routes are quarantined and a required approval is obtained before any `ExternalAction` (SPEC-000 §8, VG-CHANNEL-002, VG-CHANNEL-003) | A quarantined route produces no external write |
| 07 | Privacy preservation | Tenant isolation holds at the database layer and egress is default-deny for `CUSTOMER_PII`, `HIGH_RISK_PII`, `IDENTITY_DOCUMENT`, `AUTH_SECRET` (VG-TENANT-001, VG-EGRESS-001) | Cross-tenant read returns zero rows; an identity document cannot reach any model or any telemetry sink |
| 08 | Provider transport | Only official, permitted transports exist; no undocumented endpoint and no extracted browser-session credential is reachable (ADR-004, VG-CHANNEL-002) | A request to an undocumented endpoint is refused and audited. The provider-entitlement **run** stays `EXTERNAL_REQUIRED` |
| 09 | Failure recovery | Interruption during a campaign resumes from durable state without a second external effect for one `IdempotencyKey` (VG-ACTION-001, DOD-015, DOD-017) | A replayed submission with the same key yields exactly one external effect |
| 10 | Bug-to-draft-PR loop | A sanitized crash event is deduplicated into a repair capsule and cannot auto-merge or auto-deploy when it touches privacy, security, authorization, legal policy, billing, or production data paths | A change touching a protected path cannot merge or deploy automatically |
| 11 | Coverage honesty | The report states exactly what was checked and what was not, every percentage carries its denominator, and no partial scan becomes "entire Internet scanned" (VG-DISC-002, SPEC-000 §7) | A partial-coverage report cannot present absence without coverage bounds; a percentage without a denominator fails validation |
| 12 | Enterprise authorization | A `ProtectedSubject` is enrolled only through an explicit `AuthorityGrant` or documented lawful authority, and one tenant cannot reach another's evidence (VG-IDENT-001, VG-TENANT-002) | An expired or forged grant is refused with no subject row created; a bypass of one authorization layer still fails the other. The enterprise human sign-off stays `EXTERNAL_REQUIRED` |

Each file names its requirement IDs in the test titles, uses runtime-generated canary values
for identifier-shaped data (DOD-013), asserts a real observable result rather than a call count,
and contains at least one negative case. Where an outcome's honest test at this node is a
contract-level test rather than a full end-to-end run (for example outcome 06, whose controller
route depends on an external `Controller`), the file states the boundary in a comment and the
matched traceability row's status is written from the taxonomy — `PARTIAL` or
`EXTERNAL_REQUIRED`, never `PASS`.

(b) Exact discovery commands whose output fills the `FUNCTIONAL_PROOF_MATRIX.csv` blanks
(`entrypoint_ui_or_api`, `command_or_route`, `code_path`):

```
git ls-files 'src/http/**' 'src/ui/**' 'src/mcp/**'
grep -rn "register" src/http src/mcp 2>/dev/null | head -40
git ls-files 'src/application/**' 'src/adapters/**'
```

The output is recorded in `.agent/evidence/EP-007/M2-discovery.txt` and pasted into the matrix
rows. Any blank that discovery cannot fill is written `UNVERIFIED`, with `plannedCommand` and
`owner` fields per SPEC-006 §4.1 — never a guess and never a placeholder sentence.

(c) Traceability rows. In `.agent/verification/REQUIREMENT_TRACEABILITY.csv`, each of the twelve
`LIVE-FIRE-PROOF-NN` rows keeps its schema and receives: `test_id` unchanged, `acceptance`
retaining the oracle's meaning, `evidence_path` set to the real regression file path plus
`.agent/evidence/EP-007/live-fire-proof-NN/`, and `status` written from the taxonomy **after**
execution. `LIVE-FIRE-PROOF-08` and `LIVE-FIRE-PROOF-12` remain `EXTERNAL_REQUIRED` for their
external portion even when their in-product rule test passes.

(d) `scripts/regression-proof.sh` — asserts: all twelve files exist; each is listed in
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`; each names at least one canonical requirement
ID; no file references a double; the twelve traceability rows point at existing paths and use a
taxonomy status; and `sh scripts/test-unit.sh` passes. Prints `regression proof: ok` only then.

(e) `COMMANDS.md` — append `sh scripts/regression-proof.sh` / `regression proof: ok`.

RUN:

```
sh scripts/test-unit.sh
sh scripts/regression-proof.sh
grep -c 'tests/regression/live-fire-proof-' .agent/verification/EXPECTED_TEST_MANIFEST.txt
grep -c ',PLANNED' .agent/verification/REQUIREMENT_TRACEABILITY.csv
```

EXPECT: `regression proof: ok`; the manifest grep prints `12`; the `PLANNED` grep prints the
count of rows still honestly unexecuted, which the executor records — the number is not
required to be zero, and setting it to zero without executed evidence is a fabrication defect
(DOD-026, DOD-027).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 MILESTONE_PASS "M2 regression proof: ok; 12 outcomes bound"`

FALLBACK: if an outcome's real entry point does not exist yet because an upstream node is
incomplete, the suite tests the rule at the deepest implementation that **does** exist, asserts
the contract, and the row is marked `BLOCKED_PREREQUISITE` with the missing prerequisite named
as a dependency edge — never a skipped test and never a mock standing in for the entry point
(DOD-010, DOD-031).

COMMIT: `git add -A && git commit -m "[EP-007][M2] regression proof for all twelve live-fire outcomes"`

### M3: Real forced-failure tests for fail-closed behaviour (DOD-014)

GOAL: Wrong credentials, expired or revoked authority, stale or unsigned recipes, unavailable
dependencies, and prohibited egress each produce accurate fail-closed behaviour with no side
effect, proven by a real forced failure rather than by reasoning.

READ: `.agent/specs/SPEC-006-errors.md` §7 (fail-closed matrix), §8 (no-masking), §9
(no-PII-in-errors), `.agent/specs/SPEC-000-product-scope.md` §6.3–§6.6,
`.agent/specs/SPEC-001-core-domain.md` §4–§5, `.agent/DONE_LAW.md` (DOD-012, DOD-014, DOD-027),
`SECURITY.md`, `tests/**`, `src/**`.

CHANGE: `tests/failure/fail-closed-authority.test.ts`,
`tests/failure/fail-closed-recipe.test.ts`, `tests/failure/fail-closed-credentials.test.ts`,
`tests/failure/fail-closed-dependency.test.ts`, `tests/failure/fail-closed-egress.test.ts`,
`scripts/forced-failure.sh`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `COMMANDS.md`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) Each suite forces exactly one failure through the real code path and asserts all four of:
the typed error or refusal contract (SPEC-006 §5–§6), no side effect (verified through a second
read, not by the returning call), a recorded negative evidence row, and correct behaviour after
remediation.

| Suite | Forced condition | Must assert |
|---|---|---|
| `fail-closed-authority` | expired `AuthorityGrant`; revoked grant; forged agent instrument | External write refused with the typed error; no `ExternalAction` row; audit row present; `HUMAN_REQUIRED` where the spec requires a human step, never a bypass (VG-AUTHZ-001, VG-AUTHZ-002) |
| `fail-closed-recipe` | tampered signature; expired freshness; unclear permission | Execution refused with the classified reason; recipe auto-disabled; no write; staleness counter incremented (VG-CHANNEL-002, VG-CHANNEL-003) |
| `fail-closed-credentials` | provider credential rejected; token expired; permission denied | Typed refusal, no external effect, classified `reason_code`; no default or cached credential substituted (VG-SEC-002, DOD-014) |
| `fail-closed-dependency` | PostgreSQL, Valkey, object store, and `keycloak-jwks` unavailable in turn | Operation fails closed with a dependency-specific error; no partial write; no false success; recovery after the dependency returns |
| `fail-closed-egress` | `IDENTITY_DOCUMENT` and `AUTH_SECRET`-classified values attempting every egress sink; base64-, URL-, and truncated-encoded canaries | Denied unconditionally, no payload emitted, denial counted, and the canary value absent from exported bytes (VG-EGRESS-001, VG-EGRESS-002) |

Canary values are generated at run time from a recorded seed (DOD-013). Every suite asserts
"no side effect" by an independent read, not by the absence of an exception (DOD-012).

(b) `scripts/forced-failure.sh` — runs the five suites, asserts each suite contains at least one
assertion that the refusal happened **and** at least one that nothing was written, and prints
`forced failure: ok` only when all five pass. A suite that passes while its forced condition is
disabled is non-discriminating: the script must also run each suite with the forced condition
masked and require the suite to FAIL. That negative control is mandatory — a fail-closed test
that cannot fail proves nothing.

(c) `COMMANDS.md` — append `sh scripts/forced-failure.sh` / `forced failure: ok`.

RUN:

```
sh scripts/test-unit.sh
sh scripts/forced-failure.sh
grep -rl 'IDENTITY_DOCUMENT\|AUTH_SECRET' tests/failure | sort
```

EXPECT: `forced failure: ok`. The grep lists the egress suite; a run in which the negative
control did not fail must be reported as a harness `ERROR`, not as a pass.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 MILESTONE_PASS "M3 forced failure: ok"`

FALLBACK: where a dependency cannot be brought up in this environment, the forced failure is
applied at the boundary the code actually owns (the port implementation's error mapping) and
the row is recorded `BLOCKED_ENVIRONMENT` or `BLOCKED_PREREQUISITE` with the provisioning
attempt log — never converted into a pass and never replaced by a mock of the failing
dependency.

COMMIT: `git add -A && git commit -m "[EP-007][M3] real forced-failure tests for fail-closed behaviour"`

### M4: Mutation sensitivity for every critical feature (DOD-018)

GOAL: For every critical feature, a controlled defect is introduced and the mapped test is
observed to fail, then the defect is removed and the test is observed to pass.

READ: `.agent/DONE_LAW.md` (DOD-018), `.agent/specs/SPEC-000-product-scope.md` §5–§6,
`.agent/specs/SPEC-001-core-domain.md` §4, `TESTING.md` (mutation section), `tests/**`, `src/**`,
`.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`.

CHANGE: `.agent/verification/MUTATION_CATALOG.md`, `scripts/mutation-gate.sh`, `COMMANDS.md`,
`.agent/evidence/EP-007/mutation/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `.agent/verification/MUTATION_CATALOG.md` — one row per critical feature, with columns
`mutation_id`, `critical_feature`, `requirement_ids`, `exact_defect`, `mapped_test`,
`expected_verdict_with_defect`, `restoration`, `evidence_path`. The minimum critical-feature set,
each of which must appear, is:

1. The eleven truth states and the closed legal transition table (SPEC-000 §5, SPEC-001 §4).
2. Explicitly illegal transitions, including `REQUEST_SUBMITTED` → `VERIFIED_REMOVED`.
3. `VERIFIED_REMOVED` independence: an observation recorded on the acting path must refuse.
4. The observation window: a same-second recheck must refuse.
5. `AuthorityGrant` scope and expiry at execution time.
6. `PolicyDecision` completeness (jurisdiction, legal basis, channel, policy version).
7. `RemovalRecipe` signature and freshness.
8. `IdempotencyKey`: one key, at most one external effect.
9. Ambiguous external results reconciling rather than retrying blindly.
10. Effect budgets per subject, per source, and per window.
11. Tenant scoping at the database layer and at the service layer independently.
12. Egress default-deny by `EgressClass`, including `IDENTITY_DOCUMENT` and `AUTH_SECRET`.
13. The effectiveness metric's numerator, denominator, exclusion components, and confidence
    interval (VG-OBS-002) — the defect is defined here; the metric itself is implemented in
    EP-008 and the mutation is executed when the metric exists, otherwise the row is
    `BLOCKED_PREREQUISITE` with the edge to EP-008.
14. Coverage honesty: a partial scan cannot become an absence claim.
15. The release verdict vocabulary: a free-form completion string is rejected (VG-REL-001) —
    defect defined here; executed when the verdict machine exists in EP-010.

Each `exact_defect` is a real, minimal behaviour change (an inverted guard, a removed
validation, an off-by-one window, a swapped state token) applied by an anchored patch, never a
floating "break something" instruction.

(b) `scripts/mutation-gate.sh` — for each catalogue row: record `git diff --stat` as the
pre-state; apply the defect; run the mapped test and require a **failing** verdict; restore the
file exactly (`git checkout -- <path>`); run the mapped test and require a passing verdict;
require `git diff --exit-code` to be clean afterwards. It prints `mutation: ok` only when every
applicable row demonstrated both verdicts and the tree was restored. A row whose mapped test
passes with the defect present is a non-discriminating test and fails the gate.

(c) `COMMANDS.md` — append `sh scripts/mutation-gate.sh` / `mutation: ok`.

(d) Evidence: raw output per mutation under `.agent/evidence/EP-007/mutation/<mutation_id>/`,
plus the catalogue hash. Restoration failure is an `ERROR` and must be fixed before continuing.

RUN:

```
git status --short
sh scripts/mutation-gate.sh
git diff --exit-code
git status --short
```

EXPECT: `mutation: ok`; `git diff --exit-code` exits 0 (only the milestone's intended files are
modified, and every mutation was restored); the final `git status --short` shows no leftover
defect.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 MILESTONE_PASS "M4 mutation: ok"`

FALLBACK: if applying real patches is unsafe on a tree with uncommitted work, run the mutation
gate only from a clean committed tree, and where a critical feature does not yet exist, mark the
row `BLOCKED_PREREQUISITE` with its dependency edge — never weaken the mutation to a no-op and
never mark a non-discriminating test as sensitive.

COMMIT: `git add -A && git commit -m "[EP-007][M4] mutation sensitivity for critical features"`

### M5: Flaky-test purge and collection-guard negative controls (DOD-006, DOD-007)

GOAL: No test verdict changes across repeated identical runs, and the collection guard is proven
to fail on a zero-test collection and on a manifest suite that produced no results.

READ: `.agent/DONE_LAW.md` (DOD-006, DOD-007, DOD-024), `TESTING.md` (flake and collection
sections), `scripts/count-tests.mjs`, `scripts/test-collection-guard.sh`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/specs/SPEC-006-errors.md` §4.1
(`ERROR` vs `FAIL`), `tests/**`.

CHANGE: `scripts/flake-guard.sh`, `config/testing/flake-runs.json`, `COMMANDS.md`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `tests/**` (only where a flake was fixed),
`.agent/evidence/EP-007/flake/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/flake-guard.sh` — runs each suite listed in
`.agent/verification/EXPECTED_TEST_MANIFEST.txt` `flakeRuns` times (default 5) with the seed from
`config/testing/flake-runs.json`, captures each run's verdict and collected count, and fails
when any suite changes verdict or count between runs. On divergence it preserves the **first**
failing output under `.agent/evidence/EP-007/flake/<suite>/run-<n>.txt` and names the diverging
test. It prints `flake guard: ok` only when every suite is stable across every run.

(b) Collection-guard negative controls, implemented inside `scripts/gate-test-hardening.sh` and
re-executed here so the control evidence is produced at the moment of the claim:
- Zero-test control: point the guard at an empty directory; it must exit non-zero with the
  `zero tests were collected` diagnostic. Restore immediately.
- Missing-suite control: temporarily move one manifest-listed suite aside; the guard must fail
  naming that suite. Restore immediately and prove restoration with `git status --short` plus a
  re-run that passes.
- Both controls are real executions; neither may be simulated by asserting on the script text.

(c) Flake repairs: for every divergence, either fix the defect, or fix the oracle with a
recorded reason, or delete the test with an ADR. Retry-until-green and increasing a timeout to
hide a race are prohibited.

(d) `COMMANDS.md` — append `sh scripts/flake-guard.sh` / `flake guard: ok`.

RUN:

```
sh scripts/flake-guard.sh
sh scripts/test-collection-guard.sh
git status --short
```

EXPECT: `flake guard: ok`; `test collection guard: ok`; `git status --short` shows no control
artifact left behind.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 MILESTONE_PASS "M5 flake guard: ok; test collection guard: ok"`

FALLBACK: if 5 repetitions exceed the available budget for a long suite, the long suite is run
3 times and its row is recorded `PARTIAL` with the covered and uncovered repetition counts. The
count is never reduced to 1, and a single green run never closes a flake finding.

COMMIT: `git add -A && git commit -m "[EP-007][M5] flake purge and collection-guard negative controls"`

### M6: Test-double boundary and anti-simulation checks (DOD-010, DOD-019)

GOAL: Doubles exist only inside the documented zone, no production path selects a simulated
adapter, and no release claim rests on double-only evidence.

READ: `.agent/DONE_LAW.md` (DOD-010, DOD-019, DOD-020), `TESTING.md` (test-double zone),
`ARCHITECTURE.md` (code law), `.agent/specs/SPEC-001-core-domain.md` §1 and §5,
`.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`,
`.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv`, `src/**`, `tests/**`.

CHANGE: `scripts/double-boundary-guard.sh`, `tests/doubles/README.md`, `COMMANDS.md`,
`.agent/evidence/EP-007/double-boundary/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/double-boundary-guard.sh` performs four real checks and prints
`double boundary: ok` only when all four pass:

1. No file under `src/**` imports, constructs, or selects a double, a fake, an in-memory
   adapter, a demo adapter, or a sample adapter. The check enumerates candidate names from a
   versioned list and fails on any hit that is not allowlisted with a recorded reason.
2. No file under `tests/e2e/**`, `tests/live-fire/**`, or `tests/release/**` references a
   double.
3. Production configuration resolution never selects a simulated adapter for a feature
   represented as production-ready (DOD-020): the check resolves the configuration for each
   declared environment and fails if a simulated implementation is reachable.
4. No non-empty row of `.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv` rests on
   double-only evidence; such a row must carry status `SIMULATED` and therefore cannot satisfy a
   release gate.

(b) `tests/doubles/README.md` — a short pointer to the TESTING.md zone, stating that the
normative zone lives in `TESTING.md` and that this file is an index, not a second source of
truth.

(c) `COMMANDS.md` — append `sh scripts/double-boundary-guard.sh` / `double boundary: ok`.

RUN:

```
sh scripts/double-boundary-guard.sh
grep -rn 'in-memory\|InMemory\|Fake\|Stub' src 2>/dev/null | head -20
```

EXPECT: `double boundary: ok`. The grep is a diagnostic readback: any hit requires an
allowlist entry with a recorded reason or removal of the double from the production path.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 MILESTONE_PASS "M6 double boundary: ok"`

FALLBACK: if a genuine in-memory adapter is the documented production architecture for a
component (for example a local development composition root), allowlist it by exact path with a
one-clause justification and a check that the production environment resolution cannot select
it. The allowlist may never cover a path reachable from a production environment.

COMMIT: `git add -A && git commit -m "[EP-007][M6] test-double boundary and anti-simulation checks"`

### M7: Node close-out

GOAL: The node's own gate passes end to end, the traceability files reflect executed evidence,
and no unproven claim is carried forward.

READ: `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md` (DOD-024, DOD-025, DOD-026),
`.agent/checklists/final-review.md`, `TESTING.md`, `COMMANDS.md`, `.agent/state/LEDGER.md`,
`.agent/verification/state/RUN_MANIFEST.json`, `.agent/verification/state/RELEASE_GATE.json`.

CHANGE: `scripts/gate-test-hardening.sh`, `COMMANDS.md`,
`.agent/verification/state/RUN_MANIFEST.json`, `.agent/state/LEDGER.md`,
`.agent/evidence/EP-007/**`.

CONTENT:

(a) `scripts/gate-test-hardening.sh` runs, in order, `sh scripts/test-unit.sh`,
`sh scripts/test-integration.sh`, `sh scripts/coverage-gate.sh`,
`sh scripts/regression-proof.sh`, `sh scripts/forced-failure.sh`, `sh scripts/mutation-gate.sh`,
`sh scripts/flake-guard.sh`, `sh scripts/double-boundary-guard.sh`,
`sh scripts/test-collection-guard.sh`, plus the two collection-guard negative controls and the
canonical-vocabulary scan over test names described in §7.3. It prints
`gate-test-hardening: ok` **only** when every step exits zero and printed its own sentinel. Any
missing sentinel is a failure; a skipped step is an `ERROR` (DOD-007, DOD-024).

(b) `RUN_MANIFEST.json` — add the `test_overlay_sha` for the test overlay touched by this node,
without changing `registry_count` (484), `dod_count` (42), or `candidate_epoch`. The candidate
epoch is frozen in EP-010; this node records only the overlay revision.

(c) `RELEASE_GATE.json` — **do not change it here.** The verdict remains `INCONCLUSIVE` with
reason `FORGE_ONLY`. This node cannot produce a verdict (SPEC-008 §13, DOD-042).

(d) Ledger and evidence index: append the milestone events and index the EP-007 evidence
directory with content hashes.

RUN:

```
sh scripts/gate-test-hardening.sh
sh scripts/ledger.sh append <AGENT_ID> EP-007 NODE_DONE "EP-007 complete: gate-test-hardening: ok"
git tag green/EP-007
sh scripts/ledger.sh tail 30
git log --oneline -1
```

EXPECT: `gate-test-hardening: ok`; the ledger tail shows the `NODE_DONE` line for `EP-007`; tag
`green/EP-007` exists locally.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-007 NODE_DONE "EP-007 complete: gate-test-hardening: ok"`

FALLBACK: if one stage cannot pass because an upstream node is incomplete, the node stays open:
record the finding as the exact taxonomy status on the affected rows, report it, and close the
node only when the gate genuinely passes. Tagging on a partial gate is prohibited.

COMMIT: `git add -A && git commit -m "[EP-007][M7] close testing hardening node"`

## 9. Validation and Acceptance

Node-level acceptance, each item an executed observation in the current working tree:

1. `sh scripts/gate-test-hardening.sh` prints `gate-test-hardening: ok` and exits 0.
2. `TESTING.md` contains the coverage-targets, test-double-zone, flake, collection, and mutation
   sections, and `config/testing/coverage-thresholds.json` parses as JSON.
3. `sh scripts/coverage-gate.sh` prints `coverage: ok`; every declared layer meets its target;
   no target was lowered.
4. All twelve `tests/regression/live-fire-proof-NN.test.ts` files exist, are listed in the
   expected manifest, name canonical requirement IDs, and pass.
5. `sh scripts/forced-failure.sh` prints `forced failure: ok` **and** its disabled-condition
   negative control failed as required.
6. `sh scripts/mutation-gate.sh` prints `mutation: ok` and `git diff --exit-code` is clean
   afterwards.
7. `sh scripts/flake-guard.sh` prints `flake guard: ok` across the configured repetitions.
8. `sh scripts/double-boundary-guard.sh` prints `double boundary: ok`.
9. `sh scripts/test-collection-guard.sh` prints `test collection guard: ok`, and both negative
   controls (zero collection; missing manifest suite) were observed to fail and were restored.
10. Every status written into `.agent/verification/REQUIREMENT_TRACEABILITY.csv` or
    `.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv` by this node is a SPEC-006 §4.1 token and
    carries the fields that token requires.
11. `.agent/verification/MASTER_TEST_REGISTRY.csv` still has exactly 484 rows with prefix counts
    122/125/202/20/15; the DOD registry still has exactly 42 rows. Neither file was modified.
12. No file outside §6's list changed: `git status --short` is the audit list.

**Never claim:** that `sh scripts/verify.sh` passes (its final stages require the artifact and
live-fire that EP-009 and EP-010 own), that the product is complete, that the 484 IDs are
accounted, or that the repository is production-ready. The ship verdict remains `INCONCLUSIVE`
with reason `FORGE_ONLY` until EP-010 legitimately changes it.

## 10. Idempotence and Recovery

To re-enter cold: read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, this plan's §11 Progress,
then `.agent/state/LEDGER.md` and `sh scripts/ledger.sh status EP-007`. Resume at the first
milestone with no `MILESTONE_PASS` event. Before proceeding, re-run the previous milestone's
gate and confirm its sentinel still appears — cached green is not green (SPEC-008 §3,
VG-SHIP-006).

Every milestone is re-runnable: all artefacts are files, all checks are idempotent, and no
milestone destroys state. The two mutation controls and the two collection-guard controls
temporarily modify or move files; each must restore and prove restoration with
`git diff --exit-code` and a passing re-run. If a mutation or control leaves the tree dirty,
restore it with `git checkout -- <path>` before any other work; a dirty tree after a control is
an `ERROR`, not a finding about the product.

If a dependency is unavailable, only tests with an explicit dependency edge are blocked; every
independent suite continues (DOD-031, VG-REL-003). Blanket blocking is invalid.

Bounded retry: a failing check follows the ladder — targeted fix, diagnosis, real fallback,
rollback, structured block — with at most six attempts per milestone and never the same fix
twice.

## 11. Progress

- [ ] M1: Normative testing targets in TESTING.md and a real coverage gate
- [ ] M2: Regression proof for all twelve LIVE-FIRE-PROOF outcomes
- [ ] M3: Real forced-failure tests for fail-closed behaviour (DOD-014)
- [ ] M4: Mutation sensitivity for every critical feature (DOD-018)
- [ ] M5: Flaky-test purge and collection-guard negative controls (DOD-006, DOD-007)
- [ ] M6: Test-double boundary and anti-simulation checks (DOD-010, DOD-019)
- [ ] M7: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the exact command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
<!-- The executor records here the rulings of §7.6 and every substitution made under a FALLBACK. -->

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. -->
