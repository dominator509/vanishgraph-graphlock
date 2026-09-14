# Architecture

Next.js/React portals call Fastify APIs; PostgreSQL is canonical with RLS; Temporal owns durable workflows; Valkey coordinates; encrypted S3 evidence; isolated non-root Crawlee/Playwright workers; Keycloak OIDC/MFA; MCP least-privilege gateway; OTel/Prometheus/GlitchTip DLP-safe telemetry.

Code law: domain imports only standard library; application imports domain; adapters implement ports; HTTP/UI/MCP call application contracts; infrastructure composes implementations. Lower layers never import higher layers.

Invariants: SEARCH_HIT is not SUBJECT_MATCH; REQUEST_SUBMITTED is not REMOVED; controller acknowledgment is not independent verification; source and search are separate; every write has authority, policy, recipe, idempotency and reconciliation; stale recipes cannot write; remote content is untrusted; every claim maps to requirement, test, artifact and evidence.

---

## Locked toolchain (EP-000 M1)

Recorded from executed discovery, not assumed. Verified with `node --version`,
`npm --version`, `python3 --version`, `docker --version`, `psql --version`,
`git --version`.

| Tool | Version in this environment | Role |
|---|---|---|
| node | v24.14.1 | runtime; >=24 required (native TypeScript type stripping) |
| npm | 11.11.0 | package manager; `package-lock.json` is committed |
| python3 | 3.14.4 | pack validators (`validate-generated-pack.py`, `anti-gaming-scan.py`) |
| docker | 29.7.2 | disposable PostgreSQL / dependencies for integration tests |
| psql | 16.14 | PostgreSQL client |
| git | 2.55.0.windows.2 | version control |
| typescript | 5.9.3 (pinned devDependency) | type checking |
| @types/node | 24.10.1 (pinned devDependency) | node typings |

**Dependency policy.** Dev dependencies are pinned to exact versions — no `^` or `~`
ranges — so a clean checkout resolves a frozen set (DOD-002). TypeScript is a build
tool, not a runtime dependency.

## Layer inventory (current, honest)

| Layer | Path | State |
|---|---|---|
| domain | `src/domain/` | Present. Value objects, typed errors, the eleven truth states, the closed T1–T21 transition table, and the machine engine. Imports only the standard library. |
| application | `src/application/` | **Not created** — EP-004 |
| adapters | `src/adapters/` | **Not created** — EP-003/EP-004 |
| http | `src/http/` | **Not created** — EP-004 |
| ui | (Next.js app) | **Not created** — EP-005 |
| infrastructure | (composition root) | **Not created** — EP-009 |

The domain layer is deliberately built first: it holds the privacy rules, and it is
the only layer that can be fully verified without provisioning anything.

## Runtime stack decisions

- **Domain runtime dependencies: none.** The domain layer is pure TypeScript over the
  standard library, enforced by `scripts/import-boundary.sh` (a hard gate, not a
  convention). This keeps the truth model and the authority rules testable in
  isolation and incapable of silently acquiring a network dependency.
- **Test runner: `node:test`** with the JUnit reporter. Chosen because it needs no
  dependency and, unlike the TAP reporter, emits a `file` attribute per test case,
  which is what makes per-suite collection verification possible (DOD-007).
- **Type checking: `tsc --noEmit`** under a strict configuration
  (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly`). `erasableSyntaxOnly` additionally
  guarantees the source can run under Node's native type stripping, so the tested
  code and the shipped code are the same code.
- **Build: `tsc -p tsconfig.build.json`** emitting ESM plus declarations and source
  maps to `dist/`, with a SHA-256 digest recorded under
  `.agent/evidence/build/domain-artifact.sha256` so evidence can bind to an exact
  artifact rather than to a source tree (DOD-029).

## Gate architecture

Gate scripts follow one contract (master prompt §10 Scripts): `#!/usr/bin/env sh`,
`set -eu`, POSIX-clean (`sh -n` must pass), run from repo root, export the mandated
environment, **print their sentinel only on genuine success**, and exit non-zero on
failure.

Two properties are load-bearing and must not be relaxed:

1. **Placeholders fail loudly.** A stage whose real command is not yet implemented
   exits non-zero with `ERROR: ... replaced during EP-000 discovery milestone M1 ...`
   and prints no sentinel. It never passes silently.
2. **A gate that cannot fail is a defect.** `scripts/gate-toolchain.sh` asserts this
   mechanically: it scans every script that prints a success sentinel and fails if
   any of them contains nothing but printing (DOD-024, DOD-027).

`scripts/verify.sh` enforces the fifteen-stage order and stops at the first failure.
A verification-stage command may exit 0 when accounting completed even if candidate
tests recorded FAIL; the final release gate must exit non-zero for `NO_GO` and
`INCONCLUSIVE`. These two behaviours are deliberately different.

## Installed base

`src/domain/errors.ts` (typed taxonomy separating outcome / candidate failure /
system error), `src/domain/values.ts` (`Confidence` requiring a recorded basis,
`IdempotencyKey`, `EvidenceDigest`, `ObservationWindow`, egress and permission
classes), `src/domain/truth-state.ts` (the eleven states with non-collapse facts
encoded as data, plus the closed transition table T1–T21 and the six explicitly
forbidden pairs), `src/domain/state-machine.ts` (guard evaluation, refusal semantics,
initial-state creation).

`tests/domain/` holds 94 executing tests covering the legal path, the illegal path,
the forbidden pairs, guard non-vacuity, the independent-observation requirement, and
value-object boundaries. All 94 pass. This is domain-layer evidence only: it proves
the specification is implementable, **not** that the product works.
