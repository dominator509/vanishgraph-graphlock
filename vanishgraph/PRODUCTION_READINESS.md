# Production Readiness

**Verdict: `INCONCLUSIVE`.** Not "ready", not "complete", not "production-ready".
See `.agent/verification/state/RELEASE_GATE.json`. Any stronger claim in any
document, UI, commit message, or summary is a fabrication defect under DOD-027.

This file previously asserted "Complete 42 DOD clauses, 484 IDs, artifact proof and
external gates" in three lines. That was an aspiration written as a status. It is
replaced with what is actually true and evidenced.

## 1. What exists and genuinely passes

Verified by execution in the EP-000 session. Commands and observed sentinels are in
`.agent/verification/state/TEST_LEDGER.jsonl` (94 rows) and
`.agent/verification/state/DOD_STATUS.jsonl` (42 clauses).

| Item | Evidence |
|---|---|
| Domain core: value objects, typed errors, the eleven truth states, the closed T1–T21 transition table, guard engine | `sh scripts/test-unit.sh` → `test-unit: ok`, 94 tests / 94 pass / 0 fail |
| Illegal and forbidden transitions refused; removal theater impossible; self-verification impossible | 12 dedicated negative tests, including the full 11×11 transition-pair matrix |
| Tests are discriminating, not decorative | DOD-018 mutation check: weakening the T14 guard and removing a forbidden pair each failed a test; baseline restored to 94/94 |
| Collection honesty | `sh scripts/test-collection-guard.sh` → `test collection guard: ok`; four negative proofs (zero collected, emptied file, emptied manifest suite, failing test) each correctly fail |
| Domain purity | `sh scripts/import-boundary.sh` → `import boundary: ok`; negative proof caught a seeded `express` import |
| Type safety | `sh scripts/typecheck.sh` → `typecheck: ok` under strict + `erasableSyntaxOnly` |
| Reproducible build | `sh scripts/build.sh` → `build: ok`, artifact digest recorded |
| No gate can fake success | `sh scripts/gate-toolchain.sh` → `gate-toolchain: ok` |
| Pack integrity | `python3 scripts/validate-generated-pack.py .` → `generated pack validation: ok` |

## 2. What does **not** exist

The product does not exist. This is a specification pack plus a verified domain
core. Specifically absent: HTTP API, UI, database schema and migrations, RLS
policies, identity and authority enforcement, durable workflows, evidence storage,
discovery, provider transports, observability pipeline, CI execution on a clean
runner, and any release artifact.

`sh scripts/verify.sh` currently stops at the `format-check` stage with the
mandated loud-fail signature. **That is the correct state**: the stages that exist
genuinely pass, and the stages that do not exist genuinely fail. Fifteen stages
must pass before `verify: ok` is printed.

## 3. DOD posture (42 clauses)

| Status | Count |
|---|---|
| PASS | 5 |
| PARTIAL | 12 |
| NOT_STARTED | 24 |
| EXTERNAL_REQUIRED | 1 |

`PASS` is claimed only where the clause was verified by execution in this session.
The 5 are DOD-006, DOD-007, DOD-018, DOD-026 and DOD-027 — collection honesty,
discriminating tests, honest status taxonomy, and the removal of fabricated green
sentinels. Full detail: `.agent/verification/state/DOD_STATUS.jsonl`.

## 4. Registry accounting (484 IDs)

**Not begun.** `COMPLETE_TEST_ACCOUNTING.csv` holds no data rows and no registry ID
has yet received an individual applicability decision. DOD-030 requires all 484 IDs
accounted with zero missing or duplicated; that accounting is EP-010 work and cannot
be claimed now.

## 5. Blocking conditions

| Class | Condition |
|---|---|
| `BLOCKED_CREDENTIALS` | `DATABASE_URL`, `TEMPORAL_ADDRESS`, `VALKEY_URL`, `S3_ENDPOINT`, `KEYCLOAK_ISSUER`, `LOCAL_MODEL_ENDPOINT`, `GITHUB_APP_ID` are all unprovisioned. Reported by `sh scripts/preflight.sh`; blocks integration, E2E, live-fire and deploy work only. |
| `BLOCKED_ENVIRONMENT` | No PostgreSQL, Temporal, Valkey, object store or browser runtime provisioned. Docker 29.7.2 and psql 16.14 are available, so this is provisionable. |
| `EXTERNAL_REQUIRED` | Human UAT, manual assistive-technology validation (WCAG 2.2 AA), and legal/counsel review have **no named participants**. An agent cannot satisfy these (DOD-039). |
| `EXTERNAL_REQUIRED` | Cloud/KMS selection (ADR-006) remains unresolved. |
| `MANUAL_ONLY` | Production deployment is explicitly unauthorised (ADR-005, VG-SCOPE-009). |

## 6. Known defects carried forward (not hidden)

1. **`materialize-atomic-sources.sh` fails** with `base64: invalid input`. The
   embedded `.agent/verification/atomic-security-sources.tar.gz.b64` payload is
   corrupt, blocking the 15 reconstructed Blockchain test bodies that
   `HARNESS_LAWS.md` counts toward the 484. Not repaired, because repairing it would
   require fabricating test source bodies.
2. **Empty `describe` blocks are not detected** by the collection guard. Node reports
   a file containing only an empty `describe` as one passing test whose name is the
   suite title, which is indistinguishable from a real test by name. Documented in
   `ASSUMPTIONS.md`; the guard does catch emptied files, emptied manifest suites,
   zero collection, and failing tests.
3. **Specification conflicts requiring owner ratification** are recorded rather than
   silently resolved: node-level `VERIFY` sentinels narrowed per node (EP-000 D1);
   `AuthorityGrant` kind vocabulary split between SPEC-003 and SPEC-005;
   `HUMAN_REQUIRED` HTTP status disagreement between SPEC-003 and SPEC-006; error-code
   ownership between SPEC-003 §8.2 and SPEC-006 §8.4. Every specification file
   records these in its own conflict section.

## 7. What would change this verdict

In dependency order: provision dependencies (EP-003, EP-004) → implement API, UI and
security (EP-004, EP-005, EP-006) → harden tests (EP-007) → wire observability
(EP-008) → build and release an artifact with rollback drill (EP-009) → run the
V-000…V-021 verification subgraph, account all 484 IDs, and evaluate all 42 DOD
clauses against the exact artifact digest (EP-010). Only then can the verdict become
`GO`, or `CONDITIONAL_EXTERNAL_GATES` if human and counsel gates remain outstanding.

Until a machine-validated ship gate produces one of the four permitted verdicts, the
answer is `INCONCLUSIVE`.
