# Doubles in this repository

This directory is a pointer, not a mechanism. The binding rule lives in `TESTING.md`
("Test-double zone (DOD-010)"), and this file exists so that a reader who lands here — because a suite under
`tests/**` reached for a double — finds the rule before writing another one.

## The zone, as `TESTING.md` states it

| Directory | Doubles permitted | Rationale |
|---|---|---|
| `tests/domain/`, `tests/application/` | yes, including in-memory ports | pure logic; the port is the seam |
| `tests/adapters/`, `tests/integration/` | only for a dependency that is genuinely absent, and then the row is `SIMULATED` | at least one production-type dependency run is required |
| `tests/e2e/`, `tests/live-fire/`, `tests/release/` | none of any kind | these suites are the acceptance boundary |
| `src/**` | none, ever | a double in a production path is DOD-020 |

## What that means in this tree today

- The roots named `tests/application/`, `tests/adapters/`, `tests/e2e/`, `tests/live-fire/` and `tests/release/` do
  not exist here. The roots in use are `tests/domain`, `tests/harness`, `tests/architecture`, `tests/contract`,
  `tests/security`, `tests/db`, `tests/integration`, `tests/blackbox` and `tests/ui`; `TESTING.md` records the same
  divergence with the reason it is not being renamed.
- A double is never the sole evidence for a claim in `.agent/verification/CLAIM_TO_RELEASE_TRACEABILITY.csv`. A claim
  that rests on one is `SIMULATED` and cannot satisfy a release gate.
- `Clock` and `IdGenerator` are injected ports (SPEC-001 §5). Using them is not doubling the subject under test.
- Suites that need a real dependency get one: `tests/db/**` runs against the provisioned PostgreSQL, and the
  integration stage provisions it rather than skipping. A suite that silently skips when the dependency is absent
  reports the same green as one that ran, which is why the stages fail loudly instead.

## Where the enforcement is

`scripts/double-boundary-guard.sh` (EP-007 M6) is the guard that reads the tree for doubles outside the zone. Until it
exists, the rule is enforced by review and by the import boundary (`scripts/import-boundary.sh`), which already keeps
`src/**` from importing test-only modules.
