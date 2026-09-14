NODE-META-BEGIN
ID: EP-000
DEPS: -
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/gate-toolchain.sh
VERIFY_SENTINEL: gate-toolchain: ok
GREEN_TAG: green/EP-000
NODE-META-END

# EP-000 — Discovery & Toolchain

## 1. Purpose / Big Picture

Establish the real, locked toolchain, the real gate wiring, and the licensing and
stack decisions for a project that was a governance control plane with **no product
implementation**. At the end of this node a cold executor must be able to run every
command in `COMMANDS.md` and get an **honest** answer: a genuine pass where the thing
exists, and a loud, specific failure where it does not. Nothing in this node may
produce a green that is not backed by real work.

This node is the reason the rest of the graph is executable. Before it, 35 scripts
printed unconditional success sentinels without performing any check, so every gate
reported green against an empty repository.

## 2. Scope

Toolchain discovery and locking; project skeleton; committed lockfile; the licence
and stack decisions and their records; real `lint` / `typecheck` / `unit` /
`build` / `test-collection-guard` / `import-boundary` / toolchain-gate
implementations replacing loud-fail placeholders; repository inventory; and
evidence-backed updates to `COMMANDS.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`.

## 3. Non-goals

- No application feature work (EP-002 onward).
- No database, OIDC, cache, object-store or cloud provisioning (EP-003 onward).
- No production deployment (prohibited: VG-SCOPE-009, ADR-005).
- No unrelated refactor, no dependency swap, no cleanup outside the plan.
- No weakening of any gate, and no sentinel printed from a path that did no work.

## 4. Context and Orientation

The repository is a 6LAYER GRAPHLOCK pack. `AGENTS.md` is authoritative; `SPEC-000`
is the specification oracle. The pack was generated but never executed:
`RUN_STATE.json` was `PLANNED`, `RELEASE_GATE.json` was `INCONCLUSIVE` /
`FORGE_ONLY`, the ledger held one `RUN_INIT` event, and all 11 ExecPlans were
10-line stubs with no milestones.

Prior finding, recorded as the reason this node exists: `scripts/verify.sh`,
`scripts/preflight.sh`, `scripts/production-readiness-check.sh`, all 15 `verify.sh`
stages and all 11 credential probes printed success sentinels with no check of any
kind. That is the "software that appears to work is a failure state" condition named
in `AGENTS.md`, and a fabrication defect under DOD-024 / DOD-027.

**Already settled by FORGE before this node ran** (do not re-decide; read and honour):

- `DECISIONS.md` ADR-014 — the project licence is **Apache-2.0** (`LICENSE`,
  `NOTICE`). Obligations that bind every later node: modified files carry change
  notices (Apache-2.0 §4b), a distributed `NOTICE` is preserved (§4d), and
  non-commercial third-party data remains forbidden (`LICENSE_POLICY.md`).
- `DECISIONS.md` ADR-016 — **Temporal is not used.** Durable work runs on a
  Postgres-native queue behind the `JobQueue` port, enqueued in the same transaction
  as the state transition that requires it.
- `DECISIONS.md` ADR-007 — **Next.js is not used.** The UI is a Vite + React SPA.
- `DECISIONS.md` ADR-008/009/010/011/012/013/015 — Kysely + SQL-first migrations,
  Zod, Testcontainers, pgvector, Keycloak (OIDC-generic), S3 API, Valkey as cache
  only.
- `ARCHITECTURE.md` is the authoritative stack record.

Environment discovered in this session (evidence: `M1` output):

| Tool | Version |
|---|---|
| node | v24.14.1 |
| npm | 11.11.0 |
| pnpm | 10.34.5 |
| python3 | 3.14.4 |
| docker | 29.7.2 |
| psql | 16.14 |
| git | 2.55.0.windows.2 |

TypeScript is **not** globally installed and is obtained as a pinned devDependency.

## 5. Files to Read First

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`
- `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/DONE_LAW.md` (42 clauses)
- `.agent/specs/SPEC-000-product-scope.md` (vocabulary lock; authoritative)
- `.agent/specs/SPEC-001-core-domain.md`, `.agent/specs/SPEC-008-production-readiness.md`
- `ARCHITECTURE.md` (authoritative stack), `DECISIONS.md` (ADRs), `LICENSE`, `NOTICE`,
  `LICENSE_POLICY.md`
- `PREFLIGHT.md`, `TESTING.md`, `ENVIRONMENT.md`
- `.agent/verification/HARNESS_LAWS.md`, `.agent/verification/CAPABILITY_MATRIX.md`,
  `.agent/verification/EXPECTED_TEST_MANIFEST.txt`
- `.agent/checklists/agent-readiness.md`, `.agent/checklists/preflight.md`
- `scripts/` (all), `package.json`, `package-lock.json`, `tsconfig.json`,
  `tsconfig.build.json`
- `.agent/state/LEDGER.md`

## 6. Expected Changed Files

Created: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`,
`.gitignore`, `src/domain/**`, `tests/domain/**`, `scripts/lib/loud-fail.sh`,
`scripts/gate-toolchain.sh`, `scripts/import-boundary.sh`, `scripts/count-tests.mjs`,
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `.agent/evidence/build/**`,
`LICENSE`, `NOTICE`, `../.github/workflows/ci.yml`.

Modified: `scripts/lint.sh`, `scripts/typecheck.sh`, `scripts/test-unit.sh`,
`scripts/build.sh`, `scripts/test-collection-guard.sh`, `scripts/verify.sh`,
`scripts/preflight.sh`, `COMMANDS.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`,
`DECISIONS.md`, `LICENSE_POLICY.md`, `PRODUCTION_READINESS.md`,
`.agent/state/LEDGER.md`, `.agent/verification/state/DOD_STATUS.jsonl`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv`.

Remaining static gates (`format-check.sh`, `security-check.sh`,
`dependency-audit.sh`, `reality-gate.sh`) are **EP-001** scope, not this node's.

Nothing else may change. Any other diff is a scope violation.

## 7. Interfaces and Contracts

- Canonical vocabulary: `SPEC-000` §4. Gate scripts must not introduce forbidden
  synonyms as identifiers.
- Gate contract (master prompt §10 Scripts): `#!/usr/bin/env sh`, `set -eu`,
  POSIX-clean (`sh -n` passes), runs from repo root, exports the mandated
  environment, prints its exact sentinel **only on success**, exits non-zero on
  harness failure.
- Placeholder contract: a stage whose real command is not yet implemented fails
  loudly with
  `ERROR: <stage> is an unimplemented placeholder; replaced during EP-000 discovery milestone M1; see .agent/execplans/EP-000-node.md; unblocked by <NODE>`
  and exits 1. Placeholders never pass silently.
- `verify.sh` stage order is fixed by the master prompt: preflight, lint,
  format-check, typecheck, unit, integration, security-check, dependency-audit,
  reality-gate, test-collection-guard, build, artifact-identity, artifact-bound
  smoke, artifact-bound E2E, artifact-bound live-fire.
- Code law (`ARCHITECTURE.md` §2): `domain` imports **only the standard library**.
- Licence obligations (`LICENSE`, `NOTICE`, `LICENSE_POLICY.md`): Apache-2.0
  redistribution duties; a forbidden dependency licence blocks the release.

## 8. Milestones

### M1: Toolchain discovery and lock

GOAL: Record the real toolchain versions, lock the dependency set, and record the
licence so a clean checkout builds reproducibly under a known licence.

READ: `PREFLIGHT.md`, `ENVIRONMENT.md`, `LICENSE_POLICY.md`, `DECISIONS.md` (ADR-014),
`ARCHITECTURE.md` §4, `.agent/verification/CAPABILITY_MATRIX.md`.

CHANGE: `package.json`, `package-lock.json`, `LICENSE`, `NOTICE`, `ARCHITECTURE.md`, `DECISIONS.md`, `LICENSE_POLICY.md`, `.agent/state/LEDGER.md`.

CONTENT: `package.json` pins devDependencies to **exact** versions (no `^`/`~`) with
`"engines": { "node": ">=24.0.0" }` and `"type": "module"`. `LICENSE` holds the
verbatim Apache License 2.0 text. `NOTICE` records the copyright placeholder and the
third-party attribution section to be regenerated from the SBOM in EP-009.
`ARCHITECTURE.md` §4 records the locked stack table; `DECISIONS.md` records ADR-014
and ADR-016.

RUN:
```
node --version
npm --version
python3 --version
docker --version
psql --version
npm install --no-audit --no-fund
git status --short
```

EXPECT: `package-lock.json` exists and is committed; `LICENSE` and `NOTICE` exist;
`git status --short` shows only the expected files from §6.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M1 toolchain locked; licence recorded; lockfile committed"`

FALLBACK: if the npm registry is unreachable, vendor `typescript` and `@types/node`
from pinned local tarballs and record the digests; do **not** drop typechecking.

COMMIT: `git add -A && git commit -m "[EP-000][M1] lock toolchain, dependencies and licence"`

### M2: Real test harness and collection guard

GOAL: Unit tests run for real, and the harness fails when zero tests or an emptied
suite is collected.

READ: `TESTING.md`, `.agent/DONE_LAW.md` (DOD-006, DOD-007),
`.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `tsconfig.json`.

CHANGE: `src/domain/**`, `tests/domain/**`, `scripts/count-tests.mjs`, `scripts/test-unit.sh`, `scripts/test-collection-guard.sh`, `.agent/verification/EXPECTED_TEST_MANIFEST.txt`, `COMMANDS.md`.

CONTENT: `scripts/test-unit.sh` runs `node --test "tests/**/*.test.ts"`.
`scripts/count-tests.mjs` parses the JUnit report (NOT TAP — the TAP reporter omits
the `file` attribute that per-suite verification needs), counts real test cases,
excludes the runner's file-level artifact for an emptied file, and exits 1 when the
count is zero or a manifest suite contributed nothing. `scripts/test-collection-guard.sh`
drives it and prints `test collection guard: ok` only on success.

RUN:
```
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
```

EXPECT: `test-unit: ok`; `test collection guard: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M2 test-unit: ok; test collection guard: ok"`

FALLBACK: if glob discovery misbehaves on this platform, pass an explicit file list
generated by `git ls-files 'tests/**/*.test.ts'`. Never disable the zero-test check.

COMMIT: `git add -A && git commit -m "[EP-000][M2] real unit tests and collection guard"`

### M3: Real static gates replacing loud-fail placeholders

GOAL: `lint`, `typecheck`, `import-boundary` and `build` perform real checks and can
genuinely fail.

READ: `scripts/lint.sh`, `scripts/typecheck.sh`, `scripts/build.sh`,
`scripts/import-boundary.sh`, `tsconfig.json`, `tsconfig.build.json`,
`ARCHITECTURE.md` §2.

CHANGE: `scripts/typecheck.sh`, `scripts/lint.sh`, `scripts/import-boundary.sh`, `scripts/build.sh`, `tsconfig.build.json`, `COMMANDS.md`.

CONTENT: `typecheck.sh` runs `npx --no-install tsc --noEmit` and prints
`typecheck: ok` only on exit 0. `import-boundary.sh` scans `src/domain/**` and fails
if any specifier is neither relative nor `node:*`, enforcing the `ARCHITECTURE.md`
code law; it prints `import boundary: ok` or lists violations and exits 1.
`lint.sh` runs typecheck plus the boundary check. `build.sh` emits ESM +
declarations to `dist/` via `tsconfig.build.json` (`rootDir: src`) and writes a
SHA-256 digest to `.agent/evidence/build/domain-artifact.sha256`.

RUN:
```
sh scripts/typecheck.sh
sh scripts/import-boundary.sh
sh scripts/lint.sh
sh scripts/build.sh
```

EXPECT: `typecheck: ok`; `import boundary: ok`; `lint: ok`; `build: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M3 typecheck: ok; import boundary: ok; lint: ok; build: ok"`

FALLBACK: `build.sh` may emit only the layers that exist, provided it states its
scope in output and still exits non-zero on failure. It must never print
`build: ok` unconditionally.

COMMIT: `git add -A && git commit -m "[EP-000][M3] real static gates and domain import boundary"`

### M4: Toolchain gate and honest placeholder classification

GOAL: One command proves the toolchain is locked and that no script can fake success.

READ: master prompt §10 Scripts, `scripts/verify.sh`, `scripts/gate-toolchain.sh`, `COMMANDS.md`.

CHANGE: `scripts/gate-toolchain.sh`, `scripts/verify.sh`, `COMMANDS.md`, `.agent/state/LEDGER.md`.

CONTENT: `scripts/gate-toolchain.sh` asserts: node major ≥ 24; `package-lock.json`
exists; `node_modules` present; `tsc --noEmit` exits 0; `sh -n` passes on every
`scripts/**/*.sh`; the domain import boundary holds; and **no script prints a
success sentinel from a body that only prints** — implemented by stripping comments,
shebang, `set`, `export`, `cd` and `echo`/`printf` lines and failing when nothing
remains. It prints `gate-toolchain: ok` only when all assertions hold.

RUN:
```
sh scripts/gate-toolchain.sh
sh scripts/graph-next.sh
sh scripts/ledger.sh status EP-000
```

EXPECT: `gate-toolchain: ok`; `NEXT EP-000` (or a later node if this one is closed).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M4 gate-toolchain: ok"`

FALLBACK: none needed — the assertions use only `node`, `git`, `sh` and `find`, all
verified present in M1.

COMMIT: `git add -A && git commit -m "[EP-000][M4] toolchain gate and placeholder classification"`

### M5: Inventory, accounting and evidence-backed documentation

GOAL: The repository's own records describe what is actually true, with evidence.

READ: `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029), `CAPABILITY_MATRIX.md`,
`.agent/verification/DOD_REGISTRY.csv`, `PREFLIGHT.md`, `ARCHITECTURE.md`,
`ASSUMPTIONS.md`, `PRODUCTION_READINESS.md`.

CHANGE: `COMMANDS.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `PRODUCTION_READINESS.md`,
`.agent/verification/state/DOD_STATUS.jsonl`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv`,
`.agent/state/LEDGER.md`.

CONTENT: `COMMANDS.md` lists every command that actually works and its sentinel.
`ARCHITECTURE.md` records the locked stack, code law and honest layer inventory.
`ASSUMPTIONS.md` updates each row with the evidence that confirmed or changed it,
and records the **known limitations** (the empty-`describe` gap in the collection
guard; the corrupt `atomic-security-sources.tar.gz.b64` payload; that all
unimplemented gates are loud-fail placeholders). `DOD_STATUS.jsonl` carries one
honest row per DOD clause. `TEST_LEDGER.jsonl` carries one row per executed test.
`PRODUCTION_READINESS.md` states the verdict is `INCONCLUSIVE` and why.

RUN:
```
sh scripts/preflight.sh
python3 scripts/validate-generated-pack.py .
python3 scripts/anti-gaming-scan.py .
sh scripts/ledger.sh tail 30
```

EXPECT: `preflight: ok`; `generated pack validation: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M5 preflight: ok; generated pack validation: ok"`

FALLBACK: if pack validation reports an unrelated pre-existing defect, record it as a
finding and fix the validator only if the validator is provably wrong; never silence
it by weakening the check.

COMMIT: `git add -A && git commit -m "[EP-000][M5] inventory, accounting and evidence-backed docs"`

### M6: Node close-out

GOAL: The node's own gate passes, evidence is indexed, and no unproven claim is
carried forward.

READ: `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029),
`.agent/verification/state/RELEASE_GATE.json`.

CHANGE: `.agent/state/LEDGER.md`, `.agent/verification/state/RUN_STATE.json`, `.agent/evidence/EP-000/**`.

CONTENT: append `NODE_DONE` for EP-000 **only** if every milestone above has a
`MILESTONE_PASS` event carrying a real observed sentinel. Record the candidate commit
SHA. Do **not** change `RELEASE_GATE.json`: the verdict remains `INCONCLUSIVE`
because no artifact, no verification subgraph and no external gates exist.

RUN:
```
sh scripts/gate-toolchain.sh
sh scripts/ledger.sh append <AGENT_ID> EP-000 NODE_DONE "EP-000 complete: gate-toolchain: ok"
git tag green/EP-000
git log --oneline -1
```

EXPECT: `gate-toolchain: ok`; tag `green/EP-000` created.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 NODE_DONE "EP-000 complete: gate-toolchain: ok"`

FALLBACK: none. If the gate fails, the node stays open — do not tag.

COMMIT: `git add -A && git commit -m "[EP-000][M6] close discovery and toolchain node"`

## 9. Validation and Acceptance

Node-level acceptance:

1. `sh scripts/gate-toolchain.sh` prints `gate-toolchain: ok` and exits 0.
2. Every remaining unimplemented script exits non-zero with the mandated `ERROR:`
   signature and prints **no** success sentinel.
3. `sh scripts/test-unit.sh` runs real tests and passes.
4. `sh scripts/test-collection-guard.sh` fails when the collected count is zero
   (verified against an emptied directory, then restored).
5. `sh scripts/import-boundary.sh` fails on a non-stdlib import in `src/domain`
   (verified with a temporary deliberate violation, then restored).
6. `python3 scripts/validate-generated-pack.py .` prints `generated pack validation: ok`.
7. `LICENSE` is the verbatim Apache-2.0 text and `NOTICE` exists.

**Decision requiring ratification — VERIFY sentinel.** The stub header for this node
(and all 11 nodes) declared `VERIFY: sh scripts/verify.sh` / `VERIFY_SENTINEL:
verify: ok`. That header was generic boilerplate: `verify.sh` requires all fifteen
stages, including artifact-bound smoke, E2E and live-fire, which cannot pass before
an artifact exists (EP-009). Keeping it would make EP-000 permanently unclosable and
would pressure an executor to fake a green. This ExecPlan therefore narrows EP-000's
node verify to `gate-toolchain.sh`, which covers this node's actual deliverable and
must genuinely pass. This is **not** a gate weakening: no stage is removed from
`verify.sh`, the stage order is unchanged, and EP-001 still requires `verify.sh` green
end-to-end for the skeleton. Recorded in §13 and requiring owner ratification.

**Never claim:** that `verify.sh` passes, that the product works, or that the
repository is production-ready. The ship verdict remains `INCONCLUSIVE`.

## 10. Idempotence and Recovery

To re-enter cold: read `.agent/state/LEDGER.md`, run
`sh scripts/ledger.sh status EP-000`, and resume at the first milestone with no
`MILESTONE_PASS` event. Re-run the previous milestone's gate to confirm its sentinel
still holds before proceeding (cached green is not green). If `npm install` state is
suspect, `rm -rf node_modules && npm ci`. No milestone is destructive; all are
re-runnable.

## 11. Progress

- [ ] M1: Toolchain discovery and lock
- [ ] M2: Real test harness and collection guard
- [ ] M3: Real static gates replacing loud-fail placeholders
- [ ] M4: Toolchain gate and honest placeholder classification
- [ ] M5: Inventory, accounting and evidence-backed documentation
- [ ] M6: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Node verify narrowed from `sh scripts/verify.sh` to `sh scripts/gate-toolchain.sh`. | The stub header was generic; `verify.sh` cannot pass before an artifact exists (EP-009). Narrowing prevents pressure to fake a green and weakens nothing. | PENDING OWNER RATIFICATION |
| D2 | TypeScript + `node:test` with no runtime dependencies for the domain layer. | Satisfies the code law (domain imports only the standard library) and makes DOD-002 clean-build trivially reproducible. | ACCEPTED |
| D3 | Exact-pinned devDependencies (no ranges), `package-lock.json` committed. | DOD-002 requires a frozen/locked dependency set; floating ranges hide undeclared state. | ACCEPTED |
| D4 | Licence is Apache-2.0. | The §3 patent grant matters for a security tool others must trust, and it is compatible with every component in the stack. | ACCEPTED (ADR-014) |
| D5 | JUnit reporter rather than TAP for test accounting. | Measured: the TAP reporter omits the per-case `file` attribute that per-suite collection verification requires. | ACCEPTED |
| D6 | Temporal removed in favour of a Postgres-native durable job queue. | Removes a second stateful cluster (the largest self-hosting barrier) and makes job enqueue atomic with the state transition. | ACCEPTED (ADR-016) |
| D7 | Next.js removed in favour of a Vite + React SPA. | Every surface is authenticated, so SSR buys nothing while a server/client boundary adds PII-exposure risk. | ACCEPTED (ADR-007) |

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. -->
