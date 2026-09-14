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
