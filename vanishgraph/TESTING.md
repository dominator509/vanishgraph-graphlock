# Testing

Purpose: Real dependency tests, artifact-bound E2E, mutation proof, collection guards, and test-double boundaries.

Status: BLUEPRINT_ONLY. This file defines an executable contract; it is not application implementation.

Rule: every claim is tied to a requirement, command, and evidence path.
Because: VanishGraph handles high-risk personal data and false success is unsafe.
Required evidence: current candidate identity, command output, independent readback, and hashed evidence index.
Or else: the item remains INCOMPLETE, BLOCKED, or NO_GO; it is never promoted by narrative.

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

### Where this repository's actual layout differs from the table above (EP-007 M1)

The layer table and the coverage configuration are the specification of intent. The layout this
repository actually has is narrower, and the difference is recorded here rather than implied:

- `tests/application/`, `tests/adapters/`, `tests/api/`, `tests/e2e/`, `tests/infrastructure/` and
  `tests/release/` **do not exist**. The roots in use are `tests/domain`, `tests/harness`,
  `tests/architecture`, `tests/contract`, `tests/security`, `tests/db`, `tests/integration`,
  `tests/blackbox`, `tests/ui`. EP-003 and EP-004 chose `tests/db` and `tests/contract` before this
  table was written, and renaming the roots now would invalidate every recorded evidence path.
- `config/testing/coverage-thresholds.json` therefore carries a `layers` binding that names, per
  layer, the sources measured and the suites that measure them, each with its basis. That binding
  is normative for `scripts/coverage-gate.sh`; this table is not.
- There is no `src/mcp` directory: the MCP tool surface is `src/adapters/agent`, and the coverage
  binding names it as the `mcp` layer and excludes it from `adapters` so one file is not counted in
  two layers.


---

## Test suite layout (binding)

This table is the **single definition of which stage runs which suites**. It exists
because the ExecPlans originally disagreed: EP-003 put its database suites under
`tests/db/` while EP-004/EP-006/EP-007 used `tests/integration/`, and the unit stage
globbed `tests/**/*.test.ts` — which would have run database and browser suites in a
stage that must work on a bare checkout. The unit stage would have failed on a clean
machine, turning a harness limitation into an apparent product failure, which is
exactly the confusion DOD-032 forbids.

| Root | Depends on | Run by | Stage sentinel |
|---|---|---|---|
| `tests/domain/`, `tests/architecture/`, `tests/harness/`, `tests/application/`, `tests/adapters/`, `tests/contract/`, `tests/observability/`, `tests/doubles/`, `tests/fixtures/` | nothing (pure) | `sh scripts/test-unit.sh` | `test-unit: ok` |
| `tests/ui/` (Playwright `*.spec.ts`) | a browser runtime and the built UI | `sh scripts/test-e2e.sh` and `npm run test:ui` | `test-e2e: ok` |
| `tests/integration/` | provisioned PostgreSQL / Valkey / object store | `sh scripts/test-integration.sh` | `test-integration: ok` |
| `tests/db/` | provisioned PostgreSQL | `sh scripts/test-integration.sh` | `test-integration: ok` |
| `tests/blackbox/`, `tests/api/` | a running API | `sh scripts/test-integration.sh` | `test-integration: ok` |
| `tests/e2e/` | a running app through the real entry point | `sh scripts/test-e2e.sh` | `test-e2e: ok` |
| `tests/live-fire/` | the exact built artifact | `sh scripts/live-fire.sh` | `live-fire: ok` |
| `tests/release/` | the exact built artifact | `sh scripts/gate-release.sh` | `gate-release: ok` |

**`tests/ui/` is browser-dependent, not pure.** EP-005 puts its Playwright suites there
(`states.spec.ts`, `keyboard.spec.ts`, `a11y.spec.ts`, `reduced-motion.spec.ts`,
`privacy.spec.ts` — the last arriving with M7) and they require a provisioned browser runtime plus the
built application. They are named `*.spec.ts`, not `*.test.ts`, so the unit stage's
`find -name '*.test.ts'` does not pick them up — but the distinction must not be relied
on by accident: a browser-dependent suite added as `tests/ui/*.test.ts` would be swept
into the unit stage and fail on a clean checkout. Put browser work in `*.spec.ts` under
`tests/ui/`, or in `tests/e2e/`.

**M4 makes three things about that root concrete.** (a) `playwright.config.ts` sets
`testDir: 'tests/ui'` and `scripts/test-e2e.sh` discovers suites under both `tests/ui/` and
`tests/e2e/`, so a suite the plan names cannot be invisible to the stage that runs it — the first
version of the runner looked only at `tests/e2e/`. (b) The specs are type-checked by
`tsconfig.ui-tests.json` (DOM lib), which `scripts/gate-ui.sh` runs; the root `tsconfig.json`
excludes `tests/ui/**` so the API layer's type environment stays browser-free. (c) The states suite
measures component output through `page.setContent` with the stylesheet the build emitted, because
the region states are not mounted in any route until M5/M6 wire them to a request; what such a page
CANNOT prove (application-shell focus behaviour, timers, live requests) is asserted elsewhere or
recorded, never implied.

Rules:

1. **`test-unit.sh` must never require a service.** It excludes every
   service-dependent root listed above. The exclusion list lives in
   `scripts/test-unit.sh` and is the implementation of this table; if you add a
   service-dependent root, update the table, `scripts/test-unit.sh`, and
   `scripts/test-integration.sh` together.
2. **A suite that needs a service belongs in a service-dependent root.** Putting a
   database test under `tests/domain/` would break the unit stage on a clean checkout.
3. **Service-dependent suites are not skipped — they are run by a different stage.**
   `BLOCKED_ENVIRONMENT` is recorded when the service cannot be provisioned
   (DOD-032, DOD-033), never as a silent skip.
4. **The collection guard is parameterised.** `scripts/test-collection-guard.sh`
   honours `VG_TEST_GLOB` (default: the pure suite roots `tests/domain/**`,
   `tests/harness/**` and `tests/architecture/**`, matching `scripts/test-unit.sh`)
   and `VG_EXPECTED_MANIFEST` (default
   `.agent/verification/EXPECTED_TEST_MANIFEST.txt`), so one guard serves
   every suite. Each suite has its own manifest, and a manifest suite that produces
   no results fails the guard.

   The default is deliberately **not** `tests/**/*.test.ts`. EP-003 added the
   service-dependent `tests/db/**` suite, and under the broad default the unit guard
   collected it and failed with seven errors on a checkout with no PostgreSQL —
   rule 1 above, violated by the guard that was supposed to enforce it. The guard and
   the stage it guards now name the same roots, so they cannot disagree about what
   "the unit suite" means.
5. **Expected manifests are per suite.** `EXPECTED_TEST_MANIFEST.txt` for the unit
   stage and `EXPECTED_INTEGRATION_MANIFEST.txt` for the integration stage. Removing a
   line to make a guard pass is gate weakening (DOD-027).

## Coverage targets

`TESTING.md` previously stated no coverage thresholds, so EP-007 authors them. Until
EP-007 records them here, **no coverage claim may be made** and no threshold may be
invented by a node. The targets must be authored as normative data before any
coverage gate exists, and must never be lowered afterwards to obtain a pass.

## Mutation proof

DOD-018 requires that a critical feature's tests actually observe the behaviour they
claim. The mechanism is created once, by EP-002 (`scripts/lib/mutations.ts`, driven by
`scripts/mutation-check.sh`) and generalised by EP-007 (`scripts/mutation-gate.sh`),
which must **import** EP-002's mechanism rather than reimplement it. Two independent
mutation systems would allow the same guard to be simultaneously proven and unproven.
A mutation that does not cause a test failure means the test is non-discriminating,
and its pass proves nothing.

## Test doubles

Mocks may isolate a unit but may never be the sole proof of an integration or
production claim (DOD-010). `tests/e2e/`, `tests/live-fire/` and `tests/release/`
permit **no doubles of any kind** — they are the acceptance boundary. Where a
production-type dependency is genuinely absent, the row is recorded `SIMULATED` with
the reason, never quietly passed.
