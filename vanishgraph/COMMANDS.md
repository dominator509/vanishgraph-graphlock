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
| `sh scripts/build.sh` | `build: ok` |
| `sh scripts/artifact-identity.sh` | `artifact identity: ok` |
| `sh scripts/smoke-test.sh` | `smoke test: ok` |
| `sh scripts/live-fire.sh` | `live-fire: ok` |

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
`sh scripts/gate-foundation.sh` (gate-foundation: ok, node EP-001). Later nodes add
`gate-domain: ok` (EP-002) and `gate-data: ok` (EP-003) the same way.

## Evidence

`sh scripts/evidence-index.sh` (evidence index: ok) rebuilds
`.agent/evidence/EP-001/INDEX.txt`, classifying each artifact as `STABLE` (digest is a
durable identity, safe to bind evidence to under DOD-029) or `VOLATILE` (the file embeds
a timestamp, UUID or measurement, so no digest is recorded for it). A single
indiscriminate hash of every evidence file is wrong by construction, because run
transcripts legitimately differ on every run.