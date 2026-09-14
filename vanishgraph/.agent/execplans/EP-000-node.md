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

Establish the real, locked toolchain and the real gate wiring for a project that is
currently a governance control plane with **no product implementation**. At the end
of this node a cold executor must be able to run every command in `COMMANDS.md` and
get an **honest** answer — a genuine pass where the thing exists, and a loud,
specific failure where it does not. Nothing in this node may produce a green that
is not backed by real work.

This node is the reason the rest of the graph is executable at all. Before it, the
repository contained 35 scripts that printed unconditional success sentinels
without performing any check, so every gate reported green against an empty
repository.

## 2. Scope

In scope: toolchain discovery and locking; project skeleton; lockfile; real
lint / typecheck / unit / build / test-collection-guard implementations replacing
loud-fail placeholders; the domain import-boundary check; the toolchain gate;
repository inventory; and evidence-backed updates to `COMMANDS.md`,
`ARCHITECTURE.md`, and `ASSUMPTIONS.md`.

## 3. Non-goals

- No application feature work (that is EP-002 onward).
- No database, Keycloak, Temporal, Valkey, object store, or cloud provisioning.
- No production deployment (prohibited: VG-SCOPE-009, ADR-005).
- No unrelated refactor, no dependency swap, no cleanup outside the plan.
- No weakening of any gate, and no sentinel printed from a path that did no work.

## 4. Context and Orientation

The repository is a 6LAYER GRAPHLOCK pack. `AGENTS.md` is authoritative;
`SPEC-000` is the specification oracle. The pack was generated but never executed:
`RUN_STATE.json` was `PLANNED`, `RELEASE_GATE.json` was `INCONCLUSIVE` /
`FORGE_ONLY`, the ledger held one `RUN_INIT` event, and all 11 ExecPlans were
338-byte stubs with no milestones.

Prior session finding, recorded as the reason this node exists: `scripts/verify.sh`,
`scripts/preflight.sh`, `scripts/production-readiness-check.sh`, all 15
`verify.sh` stages, and all 11 credential probes printed success sentinels with no
check of any kind. That is the "software that appears to work is a failure state"
condition named in `AGENTS.md`, and a fabrication defect under DOD-024 / DOD-027.

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
- `ARCHITECTURE.md`, `PREFLIGHT.md`, `TESTING.md`, `ENVIRONMENT.md`
- `.agent/verification/HARNESS_LAWS.md`, `.agent/verification/CAPABILITY_MATRIX.md`
- `.agent/checklists/agent-readiness.md`, `.agent/checklists/preflight.md`
- `scripts/` (all), `package.json`, `tsconfig.json`
- `.agent/state/LEDGER.md`

## 6. Expected Changed Files

Created: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`,
`src/domain/**`, `tests/domain/**`, `scripts/lib/loud-fail.sh`,
`scripts/gate-toolchain.sh`, `scripts/import-boundary.sh`,
`scripts/count-tests.mjs`, `.github/workflows/ci.yml`.

Modified: `scripts/lint.sh`, `scripts/typecheck.sh`, `scripts/test-unit.sh`,
`scripts/build.sh`, `scripts/test-collection-guard.sh`, `scripts/verify.sh`,
`scripts/preflight.sh`, `COMMANDS.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`,
`.agent/state/LEDGER.md`.

Nothing else may change. Any other diff is a scope violation.

## 7. Interfaces and Contracts

- Canonical vocabulary: `SPEC-000` §4. Gate scripts must not introduce forbidden
  synonyms as identifiers.
- Gate contract (`6Layer-MasterPrompt` §10 Scripts): every shell script is
  `#!/usr/bin/env sh`, `set -eu`, POSIX-clean (`sh -n` passes), runs from repo root,
  exports the 5.8 environment, prints its exact sentinel **only on success**, and
  exits non-zero on harness failure.
- Placeholder contract: a script whose real command is unknowable pre-discovery
  must fail loudly with
  `ERROR: <stage> is an unimplemented placeholder; replaced during EP-000 discovery milestone M1; see .agent/execplans/EP-000-node.md; unblocked by <NODE>`
  and exit 1. Placeholders never pass silently.
- `verify.sh` stage order is fixed by the master prompt: preflight, lint,
  format-check, typecheck, unit, integration, security-check, dependency-audit,
  reality-gate, test-collection-guard, build, artifact-identity, artifact-bound
  smoke, artifact-bound E2E, artifact-bound live-fire.
- Code law (`ARCHITECTURE.md`): `domain` imports **only the standard library**.

## 8. Milestones

### M1: Toolchain discovery and lock

GOAL: Record the real toolchain versions and lock the dependency set so a clean
checkout builds reproducibly.

READ: `PREFLIGHT.md`, `ENVIRONMENT.md`, `LICENSE_POLICY.md`, `.agent/verification/CAPABILITY_MATRIX.md`.

CHANGE: `package.json`, `package-lock.json`, `ARCHITECTURE.md`, `.agent/state/LEDGER.md`.

CONTENT: `package.json` pins `typescript` and `@types/node` to exact versions
(no `^`/`~` ranges) with `"engines": { "node": ">=24.0.0" }` and `"type": "module"`.
Record the toolchain table from §4 into `ARCHITECTURE.md`.

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

EXPECT: `package-lock.json` exists and is committed; `git status --short` shows only
the expected files from §6.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M1 toolchain locked; lockfile committed"`

FALLBACK: if the npm registry is unreachable, vendor `typescript` and `@types/node`
from a pinned local tarball and record the digest; do **not** drop typechecking.

COMMIT: `git add -A && git commit -m "[EP-000][M1] lock toolchain and dependency set"`

### M2: Real test harness and collection guard

GOAL: Unit tests run for real, and the harness fails when zero tests are collected.

READ: `TESTING.md`, `.agent/DONE_LAW.md` (DOD-006, DOD-007), `tsconfig.json`.

CHANGE: `src/domain/**`, `tests/domain/**`, `scripts/count-tests.mjs`, `scripts/test-unit.sh`, `scripts/test-collection-guard.sh`, `COMMANDS.md`.

CONTENT: `scripts/test-unit.sh` runs `node --test "tests/**/*.test.ts"`.
`scripts/count-tests.mjs` parses the TAP stream, counts executed tests, and exits 1
when the count is zero — implementing DOD-007. `scripts/test-collection-guard.sh`
compares the collected count against the expected manifest and prints
`test collection guard: ok` only when the count is non-zero and matches.

RUN:
```
sh scripts/test-unit.sh
sh scripts/test-collection-guard.sh
```

EXPECT: `test-unit: ok` and `test collection guard: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M2 test-unit: ok; test collection guard: ok"`

FALLBACK: if glob discovery misbehaves on this platform, pass an explicit file list
generated by `git ls-files 'tests/**/*.test.ts'`. Never disable the zero-test check.

COMMIT: `git add -A && git commit -m "[EP-000][M2] real unit tests and zero-collection guard"`

### M3: Real static gates replacing loud-fail placeholders

GOAL: `lint`, `typecheck`, and `build` perform real checks and can genuinely fail.

READ: `scripts/lint.sh`, `scripts/typecheck.sh`, `scripts/build.sh`, `tsconfig.json`, `ARCHITECTURE.md`.

CHANGE: `scripts/typecheck.sh`, `scripts/lint.sh`, `scripts/import-boundary.sh`, `scripts/build.sh`, `COMMANDS.md`.

CONTENT: `typecheck.sh` runs `npx tsc --noEmit` and prints `typecheck: ok` only on
exit 0. `import-boundary.sh` scans `src/domain/**` for imports outside the standard
library and node builtins, enforcing the `ARCHITECTURE.md` code law; it prints
`import boundary: ok` or lists violations and exits 1. `lint.sh` runs typecheck
plus the import-boundary check. `build.sh` emits the compiled domain layer and
prints `build: ok`.

RUN:
```
sh scripts/typecheck.sh
sh scripts/import-boundary.sh
sh scripts/lint.sh
sh scripts/build.sh
```

EXPECT: `typecheck: ok`, `import boundary: ok`, `lint: ok`, `build: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M3 typecheck: ok; import boundary: ok; lint: ok; build: ok"`

FALLBACK: if a compiled build is not yet meaningful at this node, `build.sh`
performs a real typecheck-and-emit of the domain layer and states its scope in
output; it must still exit non-zero on failure. Never print `build: ok`
unconditionally.

COMMIT: `git add -A && git commit -m "[EP-000][M3] real static gates and domain import boundary"`

### M4: Toolchain gate and honest placeholder classification

GOAL: One command proves the toolchain is locked and correctly classifies every
remaining unimplemented gate as a loud-fail placeholder.

READ: `6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md` §10 Scripts, `scripts/verify.sh`, `COMMANDS.md`.

CHANGE: `scripts/gate-toolchain.sh`, `scripts/verify.sh`, `COMMANDS.md`, `.agent/state/LEDGER.md`.

CONTENT: `scripts/gate-toolchain.sh` asserts: node major ≥ 24; `package-lock.json`
exists; `node_modules` present; `tsc --noEmit` exits 0; `sh -n` passes on every
`scripts/**/*.sh`; no script prints a success sentinel from a path that performs no
check (a scan for unconditional `echo "... : ok"` with no prior command). It prints
`gate-toolchain: ok` only when all assertions hold.

RUN:
```
sh scripts/gate-toolchain.sh
sh scripts/graph-next.sh
sh scripts/ledger.sh status EP-000
```

EXPECT: `gate-toolchain: ok`; `NEXT EP-000` (or a later node if this one is closed).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M4 gate-toolchain: ok"`

FALLBACK: none needed — the assertions use only `node`, `git`, and `sh`, all
verified present in M1.

COMMIT: `git add -A && git commit -m "[EP-000][M4] toolchain gate and placeholder classification"`

### M5: Inventory and evidence-backed documentation update

GOAL: `COMMANDS.md`, `ARCHITECTURE.md`, and `ASSUMPTIONS.md` describe what is
actually true, with evidence.

READ: `.agent/DONE_LAW.md` (DOD-025), `CAPABILITY_MATRIX.md`, `PREFLIGHT.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`.

CHANGE: `COMMANDS.md`, `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `.agent/state/LEDGER.md`.

CONTENT: `COMMANDS.md` lists every command that actually works and its sentinel.
`ARCHITECTURE.md` records the locked stack, the code law, and the current layer
inventory. `ASSUMPTIONS.md` updates each row's status with the evidence that
confirmed or changed it, including that no credentials are provisioned and that
cloud/KMS selection remains open (ADR-006).

RUN:
```
sh scripts/preflight.sh
python3 scripts/validate-generated-pack.py .
sh scripts/ledger.sh tail 30
```

EXPECT: `preflight: ok`; `generated pack validation: ok`.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-000 MILESTONE_PASS "M5 preflight: ok; generated pack validation: ok"`

FALLBACK: if pack validation reports an unrelated pre-existing defect, record it as
a finding and do not "fix" it by weakening the validator.

COMMIT: `git add -A && git commit -m "[EP-000][M5] evidence-backed documentation update"`

### M6: Node close-out

GOAL: The node's own gate passes, evidence is indexed, and no unproven claim is
carried forward.

READ: `.agent/EXECUTION_RULES.md`, `.agent/DONE_LAW.md` (DOD-025, DOD-026, DOD-029), `RELEASE_GATE.json`.

CHANGE: `.agent/state/LEDGER.md`, `.agent/verification/state/RUN_STATE.json`, `.agent/evidence/EP-000/**`.

CONTENT: append `NODE_DONE` for EP-000 **only** if every milestone above has a
`MILESTONE_PASS` event carrying a real observed sentinel. Record the candidate
commit SHA. Do not change `RELEASE_GATE.json`: the verdict remains `INCONCLUSIVE`
because no artifact, no verification subgraph, and no external gates exist.

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
   (verified by temporarily pointing it at an empty directory, then restoring).
5. `sh scripts/import-boundary.sh` fails when a domain file imports a
   non-stdlib module (verified by a temporary deliberate violation, then restored).
6. `python3 scripts/validate-generated-pack.py .` prints `generated pack validation: ok`.

**Decision requiring ratification — VERIFY sentinel.** The stub header for this
node (and for all 11 nodes) declared `VERIFY: sh scripts/verify.sh` /
`VERIFY_SENTINEL: verify: ok`. That header was generic boilerplate: `verify.sh`
requires all fifteen stages, including artifact-bound smoke, E2E, and live-fire,
which cannot pass before an artifact exists (EP-009). Keeping the stub header would
make EP-000 permanently unclosable and would pressure an executor to fake a green.
This ExecPlan therefore narrows EP-000's node verify to `gate-toolchain.sh`, which
covers this node's actual deliverable and must genuinely pass. This is **not** a
gate weakening: no stage is removed from `verify.sh`, the stage order is unchanged,
and EP-001 still requires `verify.sh` green end-to-end for the skeleton. The change
is recorded in §13 Decision Log and requires owner ratification.

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
- [ ] M5: Inventory and evidence-backed documentation update
- [ ] M6: Node close-out

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
| D1 | Node verify narrowed from `sh scripts/verify.sh` to `sh scripts/gate-toolchain.sh`. | The stub header was generic; `verify.sh` cannot pass before an artifact exists (EP-009). Narrowing prevents pressure to fake a green and weakens nothing. | PENDING OWNER RATIFICATION |
| D2 | TypeScript + `node:test` with no runtime dependencies for the domain layer. | Satisfies the `ARCHITECTURE.md` code law (domain imports only the standard library) and makes DOD-002 clean-build trivially reproducible. | ACCEPTED |
| D3 | Exact-pinned devDependencies (no ranges). | DOD-002 requires a frozen/locked dependency set; floating ranges hide undeclared state. | ACCEPTED |

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence. -->
