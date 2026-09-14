NODE-META-BEGIN
ID: EP-010
DEPS: EP-009
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/production-readiness-check.sh
VERIFY_SENTINEL: production-readiness: accounted
GREEN_TAG: green/EP-010
NODE-META-END

# EP-010 — Production Readiness, Exhaustive Verification & Ship

## 1. Purpose / Big Picture

This node is the release gate. It freezes one immutable candidate epoch, pins its identity, runs the
complete verification subgraph `V-000`…`V-021` with durable per-ID accounting, evaluates all
**42** clauses of `.agent/DONE_LAW.md`, reconciles all **484** registry IDs with zero missing and
zero duplicated, executes the exact-artifact clean room and the recovery and external gates, and
emits **exactly one** machine-validated verdict: `GO`, `NO_GO`, `CONDITIONAL_EXTERNAL_GATES`, or
`INCONCLUSIVE` (VG-REL-001, DOD-042).

This node is also the place where the pack's honesty law bites hardest. The verdict is not a
narrative and not a status a model may declare: it is the output of the ship gate, and it is
derived from executed evidence bound to the pinned candidate and artifact digest. A green source
build is not an artifact pass. A test-stage accounting sentinel is not a ship pass. A prior epoch's
evidence is not current evidence. Nothing less than the complete gate is shippable (master §13).

**Production deployment is manual only and is explicitly unauthorized in this run** (VG-SCOPE-009,
ADR-005). The ship gate may not deploy. On `GO` the node creates the release tag; the deploy step is
emitted as `MANUAL` for an authorised operator and is never executed by an agent. On any other
verdict the node creates no production-ready tag, performs no deployment, and appends the truthful
verdict with its exact blockers and next action.

## 2. Scope

In scope:

- The candidate-epoch freeze: candidate commit SHA, base revision, test-overlay revision, build
  inputs, toolchain versions, image digests, and the release artifact digest (DOD-029).
- The verification subgraph: `harness-init`, `harness-next`, `harness-run-stage`,
  `harness-accounting`, `harness-validate`, the twenty-two stage plans, and the per-ID durable test
  ledger.
- Registry ingestion and the **484** individual applicability decisions made from repository
  evidence (DOD-030, DOD-041).
- Execution of `V-000`…`V-021`, including artifact-bound smoke, E2E, and live-fire, security and
  domain packs, performance and SLO verification, soak, stress and chaos, recovery and DR, the
  exact-artifact clean room, deployment, and rollback.
- The complete 42-clause DOD gate with per-clause evidence and the exact `or_else` consequence
  where a clause does not pass (DOD-030, VG-SHIP-008…011).
- The non-cascading rule: a candidate failure blocks only tests with an explicit dependency edge;
  independent tests continue to completion (DOD-031).
- The exact SPEC-006 status taxonomy and its per-status required fields (DOD-032).
- `CLAIM_TO_RELEASE_TRACEABILITY.csv` with one resolvable row per claimed capability
  (VG-SHIP-037).
- The change-invalidation graph and the rerun of invalidated descendants (DOD-040).
- Exactly one machine-validated verdict, the final accounting, and the final report set.

## 3. Non-goals

- **No production deployment by an agent.** Unauthorized (VG-SCOPE-009) and a STOP condition in
  `AGENTS.md`. The production deploy is emitted as `MANUAL`.
- **No external gate may be satisfied by an agent.** Human UAT, manual assistive-technology
  validation, legal/compliance review, hardware or accredited assessment, and production
  deployment authorization are `EXTERNAL_REQUIRED` and can be cleared only by the required real
  participant producing a named, scoped, dated sign-off (DOD-039, SPEC-008 §9). Impersonating any
  of them is a fabrication defect. While a mandatory external gate is open, the verdict cannot
  exceed `CONDITIONAL_EXTERNAL_GATES` (VG-SHIP-030).
- No reduction, sampling, approximation, or summary of the 42 DOD clauses or the 484 registry IDs.
  A clause may not be satisfied by a blanket statement about a group (VG-SHIP-010); a bulk status
  assignment is invalid unless every affected ID has an individually recorded applicability
  decision and dependency edge (DOD-030, DOD-041).
- No blanket blocking and no fabricated substitute: `BLOCKED_CAPABILITY` is invalid before the
  harness has attempted non-invasive provisioning (DOD-033); provisioning gaps are `ERROR` until
  corrected.
- No free-form completion language, and no claim stronger than its evidence (VG-SHIP-003). While
  `RELEASE_GATE.json` does not say `GO`, no document, commit message, UI string, or summary may call
  the project "ready", "complete", or "production-ready" (SPEC-008 §13, DOD-027).
- No new product features and no remediation outside an authorized epoch boundary: remediation
  happens only between epochs, the original epoch remains immutable evidence, and any change
  creates a **new** epoch and reruns every invalidated descendant (DOD-040, VG-SHIP-005).
- No gate weakening at any point: a code or harness defect is fixed to satisfy a gate; a gate is
  never weakened to satisfy code (master §5 L5).

## 4. Context and Orientation

Laws and authorities: `AGENTS.md` is authoritative. `.agent/specs/SPEC-008-production-readiness.md`
is the normative statement of what "shippable" means, the four verdicts, epoch and artifact
identity, the DOD gate, registry accounting, the verification subgraph, artifact-bound acceptance,
the clean room, the mandatory external gates, the no-masking rules, evidence preservation, and the
final report requirements. `.agent/DONE_LAW.md` holds the 42 clauses;
`.agent/verification/MASTER_TEST_REGISTRY.csv` holds the 484 IDs; `.agent/verification/GRAPH.md`
holds the binding stage table; `.agent/verification/HARNESS_LAWS.md` and
`.agent/verification/EXECUTION_DAG.md` hold the harness laws; `.agent/specs/SPEC-006-errors.md` §4
holds the exact status taxonomy.

### 4.1 The honest starting point — do not assume anything better

These are the values actually present in the repository when this plan was authored. The executor
must re-read them and record them verbatim in M1 rather than trusting this paragraph:

| Element | Real value |
|---|---|
| `.agent/verification/state/RUN_STATE.json` | `{ "status": "PLANNED" }` |
| `.agent/verification/state/RELEASE_GATE.json` | `{ "verdict": "INCONCLUSIVE", "reason": "FORGE_ONLY" }` |
| `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv` | header only — **zero data rows** |
| `.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv` | header only — **zero data rows** |
| `.agent/verification/state/TEST_LEDGER.jsonl` | empty |
| `.agent/verification/state/DOD_STATUS.jsonl` | empty |
| `.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl` | empty |
| `.agent/verification/state/EVIDENCE_INDEX.json` | `{ "entries": [] }` |
| `.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json` | `{ "edges": [] }` |
| `.agent/verification/state/RUN_MANIFEST.json` | `{"registry_count":484,"dod_count":42,"candidate_epoch":"GENERATION"}` |
| `.agent/verification/APPLICABILITY_MATRIX.csv` | five **range** rows (one per prefix), not 484 per-ID rows |
| `.agent/verification/reports/FINAL_PRODUCTION_READINESS_REPORT.md` | generation-only placeholder text |
| `.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md` | generation-only placeholder text |
| `.agent/verification/stage-plans/V-000…V-021` | 588-byte blueprint stubs, no executed content |
| `scripts/live-fire.sh`, `harness-*.sh`, `dod-gate.sh`, `production-readiness-check.sh` | loud-fail placeholders that exit 1 by design |
| Git tags | none |
| `PRODUCTION_READINESS.md` | 99-byte summary, not the instantiated DOD |

So: **the verification subgraph has never run, the registry accounting has never begun, there is no
artifact epoch, and the verdict is `INCONCLUSIVE` for the reason `FORGE_ONLY`.** Nothing in this
plan may be read as a result. Every sentinel in this file is an expectation to be produced by
execution, and every status is to be written from executed evidence.

### 4.2 Structural facts the executor will need

- `MASTER_TEST_REGISTRY.csv` has exactly **484** rows with prefix counts GEN 122, HIPAA 125,
  BC 202, E2E 20, SUP 15; **434** rows are `embedded-original-source`, **15** are
  `embedded-reconstructed-source` (BC-008…BC-022), 20 are `embedded-suite`, 15 are
  `embedded-supplemental`. The registry is never edited: no row is added, deleted, renumbered, or
  merged (master §16.1).
- The registry carries `default_stage` values that already encode ownership: `02-CLAIMS-
  TRACEABILITY` (2), `03-STATIC-DESIGN-SUPPLY-CHAIN` (70), `04-BUILD-ARTIFACT-DEPLOYMENT` (27),
  `05-SMOKE` (1), `06-SANITY` (1), `07-FUNCTIONAL-REALITY` (1), `08-API-INTEGRATION` (1),
  `09-DATA-SEMANTICS` (5), `10-COMPATIBILITY` (5), `11-FORMAL-PROPERTY-REGRESSION` (13),
  `11-REGRESSION` (1), `12-AI-AGENT-SAFETY` (1), `12-DYNAMIC-SECURITY` (297), `13-EXPLORATORY` (1),
  `14-USABILITY-A11Y-DX` (3), `15-17-PERFORMANCE-STRESS-RECOVERY` (18), `15-PERFORMANCE` (2),
  `16-SOAK` (1), `17-RECOVERY-OBSERVABILITY` (17), `17-STRESS-CHAOS` (1), `18-RECOVERY-DR` (2),
  `19-EXTERNAL-HUMAN` (10), `19-FINAL-ARTIFACT` (2), `20-UAT-HUMAN` (2). The current
  `APPLICABILITY_MATRIX.csv` collapses these to one stage per prefix and therefore contradicts the
  registry; M2 replaces it with per-ID rows derived from `default_stage` and validates
  non-overlapping ownership (VG-SHIP-019).
- The registry's `applicability` column (`evaluate`, `broadly-applicable`, and 22
  `conditional-*` values) is a **predicate class**, not a decision. A per-ID applicability decision
  must be derived from repository evidence (DOD-041).
- `schemas/` in the repository root does not contain a release-gate schema. M8 authors
  `schemas/release-gate.schema.json` from SPEC-008 §1–§2 and validates `RELEASE_GATE.json` against
  it; the canonical verdict file is `.agent/verification/state/RELEASE_GATE.json`.
- `.agent/verification/casebooks/` holds casebook objects for the 484 IDs in five files
  (`general-security.jsonl`, `hipaa-security.jsonl`, `blockchain-security.jsonl`,
  `e2e-suites.jsonl`, `supplemental-gates.jsonl`). Casebooks are validated, not edited.
- `schemas/` under `GRAPHLOCK_v3_1_FAILURE_PROOF` holds pack-level schemas; they are read-only
  inputs.

## 5. Files to Read First

Control plane and laws:

- `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`
- `.agent/EXECUTION_RULES.md`, `.agent/PLANS.md`, `.agent/DONE_LAW.md` (all 42 clauses),
  `.agent/MANIFEST.md`
- `.agent/prompts/run-graph.md`, `.agent/prompts/final-review.md`,
  `.agent/prompts/continue-execplan.md`
- `.agent/checklists/production-readiness.md`, `.agent/checklists/final-review.md`,
  `.agent/checklists/release.md`, `.agent/checklists/rollback.md`,
  `.agent/checklists/incident-response.md`
- `.agent/state/LEDGER.md`

Specifications:

- `.agent/specs/SPEC-008-production-readiness.md` — read in full; this node is its instantiation
- `.agent/specs/SPEC-000-product-scope.md` §3 (non-goals), §4 (vocabulary), §5 (truth model), §6
  (requirement catalogue), §7 (coverage honesty), §9 (acceptance oracle), §10 (traceability), §11
  (human-authority items)
- `.agent/specs/SPEC-006-errors.md` §4 (taxonomy, required fields, invariants), §7 (fail-closed),
  §8 (no masking), §10 (bounded ladder)
- `.agent/specs/SPEC-007-observability.md` §9–§11 (SLOs, truthfulness, retention and access)
- `.agent/specs/SPEC-001-core-domain.md`, `.agent/specs/SPEC-002-data-model.md`,
  `.agent/specs/SPEC-003-api-contracts.md`, `.agent/specs/SPEC-004-ui-ux.md`,
  `.agent/specs/SPEC-005-auth-permissions.md` (as referenced by the stages being executed)

Harness, registry, and accounting:

- `.agent/verification/GRAPH.md`, `.agent/verification/EXECUTION_DAG.md`,
  `.agent/verification/HARNESS_LAWS.md`
- `.agent/verification/MASTER_TEST_REGISTRY.csv` (484 rows), `.agent/verification/DOD_REGISTRY.csv`
  (42 rows), `.agent/verification/APPLICABILITY_MATRIX.csv`,
  `.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`,
  `.agent/verification/REQUIREMENT_TRACEABILITY.csv`
- `.agent/verification/E2E_SUITE_LIBRARY.md`, `.agent/verification/ATOMIC_TEST_FACTORY.md`,
  `.agent/verification/SUPPLEMENTAL_PRODUCTION_GATES.md`,
  `.agent/verification/BLOCKCHAIN_008_022_RECONSTRUCTED.md`,
  `.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`,
  `.agent/verification/CAPABILITY_MATRIX.md`
- `.agent/verification/casebooks/*.jsonl`
- `.agent/verification/stage-plans/V-000-stage.md` … `V-021-stage.md`
- `.agent/verification/state/*` (all files), `.agent/verification/reports/*` (all files)
- `schemas/*.json` and `GRAPHLOCK_v3_1_FAILURE_PROOF/schemas/*.json`

Documents and product surface:

- `PRODUCTION_READINESS.md`, `RELEASE.md`, `ROLLBACK.md`, `OPERATIONS.md`, `DEPLOYMENT.md`,
  `OBSERVABILITY.md`, `REMOVAL_EFFECTIVENESS_METRICS.md`, `TESTING.md`, `SECURITY.md`,
  `ARCHITECTURE.md`, `ASSUMPTIONS.md`, `DECISIONS.md`, `PREFLIGHT.md`, `ENVIRONMENT.md`,
  `LEGAL_REVIEW_REQUIRED.md`, `LICENSE_POLICY.md`, `DATA_EGRESS_MATRIX.md`,
  `TOS_AUTOMATION_MATRIX.md`, `MARKET_BASELINE.md`, `CONTRIBUTING.md`
- the full `src/**` and `tests/**` trees, `package.json`, `package-lock.json`, `tsconfig.json`
- every file under `scripts/**`

## 6. Expected Changed Files

Created:

- `scripts/epoch-pin.sh`
- `scripts/applicability-decide.sh`
- `scripts/clean-room.sh`
- `schemas/release-gate.schema.json`
- `.agent/verification/state/HARNESS_VALIDATION_REPORT.json`
- `.agent/verification/reports/FINAL_PRODUCTION_READINESS_REPORT.md` (content)
- `.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md` (content)
- `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv` (rows)
- `.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv` (rows)
- `.agent/verification/state/TEST_LEDGER.jsonl` (rows)
- `.agent/verification/state/DOD_STATUS.jsonl` (rows)
- `.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl` (rows)
- `.agent/verification/state/EVIDENCE_INDEX.json` (entries)
- `.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json` (edges)
- `.agent/verification/state/EPOCH_HISTORY.md`
- `.agent/evidence/EP-010/**`

Modified:

- `scripts/harness-init.sh`, `scripts/harness-next.sh`, `scripts/harness-run-stage.sh`,
  `scripts/harness-accounting.sh`, `scripts/harness-validate.sh`, `scripts/dod-gate.sh`,
  `scripts/production-readiness-check.sh`, `scripts/live-fire.sh`
- `scripts/verify.sh` — only if a genuine harness defect is found in the stage wiring EP-009
  created; the fifteen-stage order is never changed
- `.agent/verification/stage-plans/V-000-stage.md` … `V-021-stage.md` (and the duplicate
  `V-0NN-<slug>.md` files for the same stages)
- `.agent/verification/APPLICABILITY_MATRIX.csv`
- `.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv`
- `.agent/verification/REQUIREMENT_TRACEABILITY.csv`
- `.agent/verification/GRAPH.md` — **only** if a genuine table defect is found; the linear order is
  retained (see §7.9 ruling 2)
- `.agent/verification/state/RUN_MANIFEST.json`, `RUN_STATE.json`, `RELEASE_GATE.json`,
  `CHANGE_INVALIDATION_GRAPH.md`
- `.agent/state/LEDGER.md`
- `PRODUCTION_READINESS.md`, `RELEASE.md`, `COMMANDS.md`
- `.github/workflows/ci.yml` — only if the harness stage wiring requires it

Nothing else may change. Any other diff is a scope violation and must be reverted.

## 7. Interfaces and Contracts

### 7.1 Gate-script contract

Every script this node implements is POSIX `sh`, `set -eu`, runs from the repository root, exports
`CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive`, passes
`sh -n`, prints its exact sentinel only on genuine success, and exits non-zero on failure.

| Command | Sentinel |
|---|---|
| `sh scripts/epoch-pin.sh` | `epoch: pinned` |
| `sh scripts/applicability-decide.sh` | `applicability: decided` |
| `sh scripts/harness-init.sh` | `harness init: ok` |
| `sh scripts/harness-next.sh` | `NEXT V-0NN` (or `ALL_STAGES_ACCOUNTED`) |
| `sh scripts/harness-run-stage.sh <V-0NN>` | `stage <V-0NN>: accounted` |
| `sh scripts/harness-accounting.sh` | `accounting: 484/484 accounted` |
| `sh scripts/harness-validate.sh` | `harness validation: ok` |
| `sh scripts/dod-gate.sh` | `definition of done: ok` |
| `sh scripts/live-fire.sh` | `live-fire: ok` |
| `sh scripts/clean-room.sh` | `clean room: ok` |
| `sh scripts/verify.sh` | `verify: ok` |
| `sh scripts/production-readiness-check.sh` | `production-readiness: accounted` |

**Exit-code semantics, deliberately different and never conflated** (SPEC-008 VG-SHIP-002):
`harness-run-stage.sh` exits `0` when accounting for that stage completed, even if candidate tests
recorded `FAIL`. The final release gate `production-readiness-check.sh` prints the accounting
sentinel and then **exits non-zero** for `NO_GO` and `INCONCLUSIVE`. A stage accounting sentinel is
not a ship pass.

### 7.2 Candidate epoch identity

The epoch pins: `candidate_epoch`, `candidate_sha`, `base_sha`, `test_overlay_sha`,
`build_inputs_digest`, toolchain versions (node, package manager, container runtime, database
client), image digests where applicable, and `artifact_digest`. The candidate is immutable from
`V-000` through `V-021`. A harness or environment defect is fixed **in the overlay** and recorded
`ERROR` until corrected; a correctly executed product defect is `FAIL`. After complete accounting,
remediation is permitted only when policy authorizes it, the original epoch remains immutable
evidence, a new commit or artifact creates a **new** epoch, and every invalidated descendant is
rerun (VG-SHIP-005, DOD-040).

### 7.3 The 484-ID accounting contract

Every one of the 484 registry IDs receives:

1. an **applicability decision** — one of `APPLICABLE_AUTOMATABLE`, `APPLICABLE_PARTIAL`,
   `APPLICABLE_EXTERNAL_REQUIRED`, `CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE`,
   `SKIPPED_NOT_APPLICABLE` — decided from repository evidence with at least one concrete
   path/row reference (`applicabilityEvidence[]`), and never from assumption (DOD-041); and
2. exactly one **final status** from SPEC-006 §4.1 with that status's required fields.

The accounting invariant that must hold with zero unaccounted and zero duplicated IDs
(master §16.8):

```
registered IDs = passed + failed + errored + inconclusive + not applicable
               + prerequisite blocked + environment blocked
               + capability/credential/safety blocked
               + external required + deferred long-running
```

`PASS` without evidence, `NOT_APPLICABLE` without repository evidence, a prerequisite block without
a dependency edge, an environment block without a provisioning action, an unsupported status token,
and a stale-epoch evidence row are all rejected by the validator. The validator deliberately
self-tests against a fabricated 484-row blanket `BLOCKED_CAPABILITY` ledger and must reject it
(master §22.4).

### 7.4 DOD gate contract

All 42 clauses are evaluated. A clause is `PASS` only with the evidence its `required_evidence`
column names. Where a clause's `or_else` applies, that exact consequence is recorded, not a
softened alternative (VG-SHIP-009). `must_account = true` clauses are reported individually; no
clause is satisfied by a blanket statement about a group (VG-SHIP-010). Clause status uses the
SPEC-006 §4.1 taxonomy, and `PASS` is never inferred from the absence of failure (VG-SHIP-011).

### 7.5 No-masking rules

No test or scanner failure may be hidden by `continue-on-error`, an ignored exit code,
unconditional success, a swallowed exception, a blanket catch, an all-retry policy, filtered
output, or baseline auto-acceptance (DOD-024, VG-SHIP-032). Detecting any such pattern invalidates
the run and revokes dependent `PASS` claims. A gate "passes" only when it was actually executed in
the current session and its sentinel appeared in real output; recalling a prior result, or reading
the script, is not a pass (VG-SHIP-034).

### 7.6 External gates are `EXTERNAL_REQUIRED` and cannot be satisfied by an agent

Human UAT of the golden path, manual assistive-technology validation (WCAG 2.2 AA), legal and
compliance review, hardware/HSM or accredited assessment, and production deployment authorization
require the real participants listed in SPEC-008 §9. An agent may prepare the artifact, the
scenarios, and the request; an agent may **never** clear the status, sign, or impersonate a
participant (DOD-039). Until they sign, the verdict cannot exceed `CONDITIONAL_EXTERNAL_GATES`
(VG-SHIP-030), and `GO` is prohibited while a mandatory external gate is open. Each open gate
carries `externalPartyRole`, `requestedArtifactDigest`, `requestEvidencePath`, `requestedAt`, and
`ownerContactRef`.

### 7.7 The four verdicts

Exactly four verdicts exist (SPEC-008 §2): `GO` — every internal and mandatory external release
gate is satisfied for the exact artifact; `NO_GO` — at least one release-blocking candidate defect,
DOD failure, fake or incomplete feature, invalid artifact identity, unsafe data or recovery
condition, or mandatory omitted test exists; `CONDITIONAL_EXTERNAL_GATES` — every executable
internal gate passes and only genuinely human/hardware/accredited/authorised-external work remains,
which is **not** production approval; `INCONCLUSIVE` — evidence is insufficient or the harness
itself is materially invalid. Free-form completion language is prohibited (VG-REL-001, DOD-042).

### 7.8 Evidence preservation

Raw commands, tool versions, exit codes, logs, reports, traces, seeds, environment fingerprints,
candidate SHA, artifact hashes, and evidence digests are preserved and indexed (DOD-025). Every
result links to a content hash; an unhashed claim is `INCONCLUSIVE` (VG-SHIP-036).

### 7.9 Rulings this plan makes, to be re-recorded in §13 by the executor

1. **Node verify command.** The stub header declared `VERIFY: sh scripts/verify.sh` /
   `VERIFY_SENTINEL: verify: ok`. That header is right for this node's **internal** ship gate but
   wrong as the node-level verify: this node's deliverable is the complete gate plus exactly one
   verdict, and `verify.sh` is only step 2 of that gate. The node verify is therefore
   `sh scripts/production-readiness-check.sh` with sentinel `production-readiness: accounted`, and
   `verify: ok` is required as an internal step in M8's ship gate. Both sentinels must appear in the
   same run for the node to close, and neither is weakened by this ruling: `verify.sh` keeps every
   one of its fifteen stages in the mandated order and is executed in full.
2. **Linearity versus the branching DAG.** `.agent/verification/GRAPH.md` declares a linear chain
   `V-000 → … → V-021`; the master prompt §16.2 declares a branching DAG. The linear order is a
   valid topological order of that DAG (every declared dependency has a lower index), so the pack's
   in-repo table is followed and **not modified**. The non-cascading rule is honoured in the
   execution semantics: a candidate `FAIL` in a stage never halts the campaign, and only a declared
   dependency edge may block a dependent ID (DOD-031, VG-SHIP-014/018).
3. **Applicability vocabulary.** SPEC-008 VG-SHIP-012 names two applicability values
   (`APPLICABLE` / `NOT_APPLICABLE`); master §16.5 names five. The five are adopted as the fine
   values in the `applicability` column, with `SKIPPED_NOT_APPLICABLE` as the fine value for
   SPEC-008's `NOT_APPLICABLE`; the coarse reading remains valid as a projection. No ID is left
   without a fine value.
4. **Canonical output paths.** The master prompt names `.agent/verification/07-final/*`; the pack
   ships `.agent/verification/reports/*` and `.agent/verification/state/*`. The **pack's existing
   paths are canonical** and are written; the divergence is recorded in the Decision Log so nobody
   looks for evidence in a directory that does not exist.
5. **Release-gate schema.** The pack ships no release-gate schema. M8 authors
   `schemas/release-gate.schema.json` from SPEC-008 §1–§2 and validates `RELEASE_GATE.json` against
   it. Authoring a schema to fit a verdict is prohibited; the schema is written first and the
   verdict validated against it (DOD-027).
6. **`stage-plans` duplicates.** Each stage has two files (`V-0NN-stage.md` and
   `V-0NN-<slug>.md`) with identical 588-byte stub content. Both are implemented from the same
   content in M3/M4 so they cannot drift; a divergence between them fails the stage validator.
7. **Production deployment.** Manual only, unauthorized in this run (VG-SCOPE-009, ADR-005). On
   `GO` the node creates the release tag and emits the deploy step as `MANUAL`; it never deploys.

## 8. Milestones

### M1: Freeze the candidate epoch and pin identity from the real starting state

GOAL: One immutable candidate epoch is pinned with every identity field, and the real starting state
of the harness is recorded verbatim rather than assumed.

READ: `.agent/specs/SPEC-008-production-readiness.md` §3, §13;
`.agent/verification/state/RUN_STATE.json`, `RELEASE_GATE.json`, `RUN_MANIFEST.json`,
`TEST_LEDGER.jsonl`, `DOD_STATUS.jsonl`, `STATUS_TRANSITION_AUDIT.jsonl`, `EVIDENCE_INDEX.json`,
`DEPENDENCY_BLOCKER_GRAPH.json`; `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv`,
`CLAIM_TO_RELEASE_TRACEABILITY.csv`, `FINAL_PRODUCTION_READINESS_REPORT.md`,
`RESIDUAL_RISK_AND_EXTERNAL_GATES.md`; `.agent/verification/APPLICABILITY_MATRIX.csv`;
`.agent/verification/stage-plans/`; `PRODUCTION_READINESS.md`;
`.agent/DONE_LAW.md` (DOD-025, DOD-029); `.agent/verification/CAPABILITY_MATRIX.md`.

CHANGE: `scripts/epoch-pin.sh`, `.agent/verification/state/RUN_MANIFEST.json`,
`.agent/verification/state/RUN_STATE.json`, `.agent/verification/state/EPOCH_HISTORY.md`,
`COMMANDS.md`, `.agent/evidence/EP-010/M1-starting-state.txt`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/epoch-pin.sh` — records the §7.2 identity fields into `RUN_MANIFEST.json`, writes the
epoch row into `EPOCH_HISTORY.md`, and prints `epoch: pinned` only when every field is populated:
the candidate commit SHA (`git rev-parse HEAD`), the base revision, the test-overlay revision, the
build-inputs digest, the toolchain versions, the artifact digest from
`.agent/verification/state/ARTIFACT_IDENTITY.json` (written by EP-009), and the image digests where
applicable. A missing artifact digest is a failure: without it, every artifact-bound result would be
`INCONCLUSIVE` (DOD-029).

(b) The starting-state record. Run the exact discovery commands below, paste the full output into
`.agent/evidence/EP-010/M1-starting-state.txt`, and confirm in writing that the values match §4.1 —
in particular that `RELEASE_GATE.json` is `INCONCLUSIVE` / `FORGE_ONLY`, `RUN_STATE.json` is
`PLANNED`, and both accounting CSVs have **zero data rows**. If any of them differs, the difference
is recorded and this plan's assumptions are corrected before proceeding — never silently.

(c) `RUN_STATE.json` — set to `IN_PROGRESS` with the epoch id. It remains `IN_PROGRESS` until a
verdict is emitted in M8; it is not set to a terminal value here.

(d) `RELEASE_GATE.json` — do not write a verdict. M8 is the only milestone allowed to change it.

(e) `COMMANDS.md` — append `sh scripts/epoch-pin.sh` / `epoch: pinned`.

RUN:

```
git rev-parse HEAD
git status --porcelain
git log --oneline -1
cat .agent/verification/state/RUN_STATE.json
cat .agent/verification/state/RELEASE_GATE.json
cat .agent/verification/state/RUN_MANIFEST.json
wc -l .agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv
wc -l .agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv
wc -l .agent/verification/state/TEST_LEDGER.jsonl
wc -l .agent/verification/state/DOD_STATUS.jsonl
cat .agent/verification/state/EVIDENCE_INDEX.json
cat .agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json
git tag
sh scripts/epoch-pin.sh
```

EXPECT: `epoch: pinned`. The `wc -l` values for the two accounting CSVs are `1` and `1` (header
only) at this point, and the JSONL files are empty; those numbers are evidence of the honest
starting point, not a defect to fix by writing rows. `git tag` prints nothing.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M1 epoch: pinned; starting state recorded (INCONCLUSIVE/FORGE_ONLY, accounting empty)"`

FALLBACK: if the working tree is dirty, commit or stash only the executor's own in-scope files,
record the exact `git status --porcelain` output, and pin the epoch to the resulting commit. Never
pin an epoch over an unrecorded dirty tree, and never amend an epoch after results exist.

COMMIT: `git add -A && git commit -m "[EP-010][M1] freeze candidate epoch and pin identity"`

### M2: Initialize the verification subgraph, ingest the registry, and decide applicability for all 484 IDs

GOAL: The harness is initialized, all 484 IDs have an individual applicability decision derived from
repository evidence, stage ownership is complete and non-overlapping, and the validators reject
blanket blocking and unevidenced statuses.

READ: `.agent/verification/GRAPH.md`, `EXECUTION_DAG.md`, `HARNESS_LAWS.md`;
`.agent/verification/MASTER_TEST_REGISTRY.csv`; `.agent/verification/DOD_REGISTRY.csv`;
`.agent/verification/APPLICABILITY_MATRIX.csv`; `.agent/verification/casebooks/*.jsonl`;
`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`, `CAPABILITY_MATRIX.md`;
`.agent/specs/SPEC-008-production-readiness.md` §5, §6;
`.agent/specs/SPEC-006-errors.md` §4; `.agent/DONE_LAW.md` (DOD-030, DOD-031, DOD-033, DOD-041);
`.agent/verification/stage-plans/`.

CHANGE: `scripts/harness-init.sh`, `scripts/harness-validate.sh`, `scripts/harness-accounting.sh`,
`scripts/applicability-decide.sh`, `.agent/verification/APPLICABILITY_MATRIX.csv`,
`.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json`,
`.agent/verification/state/HARNESS_VALIDATION_REPORT.json`, `COMMANDS.md`,
`.agent/evidence/EP-010/M2-applicability/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/harness-init.sh` — ingests the registry snapshot, verifies **484** unique IDs and the
prefix counts 122/125/202/20/15, verifies 434 original-source rows plus 15 reconstructed Blockchain
rows plus the E2E and SUP families, verifies a casebook object exists for each of the 484 IDs,
verifies the casebooks contain no placeholder or invention, verifies stage ownership from the
registry's `default_stage` column, and writes the dependency-graph seed into
`DEPENDENCY_BLOCKER_GRAPH.json`. It prints `harness init: ok` only when every count and every
ownership entry validates. It must be safe to re-run (resume, not duplicate).

(b) Ownership derivation — the exact mapping from `default_stage` to the owning stage:

```
02-CLAIMS-TRACEABILITY                -> V-002
03-STATIC-DESIGN-SUPPLY-CHAIN         -> V-004
04-BUILD-ARTIFACT-DEPLOYMENT          -> V-005
05-SMOKE                              -> V-006
06-SANITY                             -> V-007
07-FUNCTIONAL-REALITY                 -> V-008
08-API-INTEGRATION                    -> V-009
09-DATA-SEMANTICS                     -> V-010
10-COMPATIBILITY                      -> V-011
11-FORMAL-PROPERTY-REGRESSION         -> V-012
11-REGRESSION                         -> V-012
12-AI-AGENT-SAFETY                    -> V-013
12-DYNAMIC-SECURITY                   -> V-013
13-EXPLORATORY                        -> V-014
14-USABILITY-A11Y-DX                  -> V-015
15-PERFORMANCE                        -> V-016
15-17-PERFORMANCE-STRESS-RECOVERY     -> V-016 (performance rows) / V-017 (soak rows) / V-019 (recovery rows), split per ID title
16-SOAK                               -> V-017
17-RECOVERY-OBSERVABILITY             -> V-019
17-STRESS-CHAOS                       -> V-018
18-RECOVERY-DR                        -> V-019
19-EXTERNAL-HUMAN                     -> V-021
19-FINAL-ARTIFACT                     -> V-020
20-UAT-HUMAN                          -> V-021
```

Where a `default_stage` maps to more than one stage, the split is decided per ID from its `title`
and recorded per ID; the ownership count per stage is asserted to sum to 484 and to be
non-overlapping (VG-SHIP-019).

(c) `scripts/applicability-decide.sh` — for every one of the 484 IDs, derives the applicability
decision from repository evidence under the registry's `applicability` predicate class, and writes
one row per ID into `APPLICABILITY_MATRIX.csv` with columns `test_id`, `applicability`,
`applicability_predicate`, `applicability_evidence`, `decision_rule_ref`, `decided_by`, `decided_at`,
`default_status`, `owner_stage`. Predicate handling: `evaluate` (GEN) is decided from the security
and architecture surface actually present; `broadly-applicable` is `APPLICABLE_AUTOMATABLE` unless
repository evidence shows the construct is absent; each `conditional-*` value is decided from the
concrete evidence its name demands (`conditional-multitenant` from tenant-scoped schema and RLS,
`conditional-ai` from the presence of a model or agent transport, `conditional-long-running` from a
declared duration objective, `conditional-distributable` from a produced artifact format,
`conditional-gui` from a rendered interface, and so on). Every decision cites at least one concrete
path or row. `SKIPPED_NOT_APPLICABLE` requires repository evidence that the targeted construct does
not exist or is unreachable from any production path; assumption alone never produces it. Prints
`applicability: decided`.

(d) The Blockchain pack. `BC-001`…`BC-202` must be decided individually, not as one block: the
repository has no blockchain component today, so most will be `SKIPPED_NOT_APPLICABLE` **with the
specific evidence** that no chain, wallet, contract, node, or on-chain data path exists — and any BC
row whose subject is not chain-specific (key management, signing, audit immutability, cryptographic
verification) is decided on its own merits rather than inheriting the pack's fate. The 15
reconstructed rows (BC-008…BC-022) are labelled as reconstructed in the accounting.

(e) `scripts/harness-validate.sh` — the validator. It verifies the registry snapshot hash, the
casebook presence and content, ID uniqueness and count, stage ownership, applicability decisions
with evidence, every status against the SPEC-006 §4.1 schema with per-status required fields,
evidence links and digests for every `PASS`, dependency edges for every `BLOCKED_PREREQUISITE`,
provisioning actions for every `BLOCKED_ENVIRONMENT`, the absence of blanket blockers, the current
candidate epoch and artifact digest on every row, the DOD count of 42, and accounting equality. It
also runs the mandated self-tests and must **reject** each of: a fabricated 484-row blanket
`BLOCKED_CAPABILITY` ledger; `PASS` without evidence; `NOT_APPLICABLE` without repository evidence;
zero-test collection; a missing ID; a duplicated ID; stale-epoch evidence; a prerequisite block
without a dependency edge. Prints `harness validation: ok` and writes
`HARNESS_VALIDATION_REPORT.json`.

(f) `scripts/harness-accounting.sh` — recomputes the §7.3 invariant from the ledger and prints
`accounting: 484/484 accounted` only when the equality holds with zero missing and zero duplicated
IDs; otherwise it prints the exact missing or duplicated IDs and exits non-zero.

(g) `COMMANDS.md` — append the four commands and their sentinels.

RUN:

```
sh scripts/harness-init.sh
sh scripts/applicability-decide.sh
wc -l .agent/verification/APPLICABILITY_MATRIX.csv
sh scripts/harness-validate.sh
sh scripts/harness-accounting.sh
```

EXPECT: `harness init: ok`; `applicability: decided`; the applicability matrix line count is `485`
(header plus 484 ID rows); `harness validation: ok`; and `accounting: 484/484 accounted` **only
once every ID has a status**. Until statuses exist, `harness-accounting.sh` legitimately reports the
unaccounted count and exits non-zero — that is the correct behaviour at this milestone and must not
be "fixed" by writing statuses that have not been executed.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M2 harness init: ok; applicability: decided; harness validation: ok"`

FALLBACK: if a `conditional-*` predicate cannot be decided from repository evidence alone, the ID is
recorded `CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE` with the specific evidence request named as its
next action — never `SKIPPED_NOT_APPLICABLE` and never `APPLICABLE` on assumption. A pending ID keeps
the accounting open and is reported as such in M7.

COMMIT: `git add -A && git commit -m "[EP-010][M2] initialize verification subgraph and decide applicability"`

### M3: Execute verification stages V-000 through V-009 with durable accounting

GOAL: The first ten stages execute in order with per-ID statuses, evidence, and durable checkpoints,
and a candidate failure in one stage never halts an independent stage.

READ: `.agent/verification/stage-plans/V-000-stage.md` … `V-009-stage.md` and their slug duplicates;
`.agent/verification/GRAPH.md`; `.agent/verification/EXECUTION_DAG.md`;
`.agent/verification/HARNESS_LAWS.md`; `.agent/verification/MASTER_TEST_REGISTRY.csv`;
`.agent/verification/casebooks/*.jsonl`; `.agent/specs/SPEC-006-errors.md` §4, §10;
`.agent/DONE_LAW.md` (DOD-002, DOD-003, DOD-004, DOD-005, DOD-007, DOD-009, DOD-010, DOD-011,
DOD-012, DOD-013, DOD-014, DOD-021, DOD-024, DOD-025, DOD-031, DOD-032, DOD-033).

CHANGE: `.agent/verification/stage-plans/V-000-stage.md` … `V-009-stage.md` and their slug
duplicates, `scripts/harness-run-stage.sh`, `scripts/harness-next.sh`,
`.agent/verification/state/TEST_LEDGER.jsonl`, `.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json`,
`.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl`,
`.agent/verification/state/EVIDENCE_INDEX.json`, `COMMANDS.md`,
`.agent/evidence/EP-010/V-000..V-009/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/harness-run-stage.sh <V-0NN>` — loads the stage's owned IDs and their casebooks,
verifies the epoch, artifact identity, authorization, safety, prerequisites, environment, and tool
versions, defines the oracle and invariants before execution, captures pre-state and any seed,
executes each ID's exact commands, preserves raw output and exit codes, verifies the collection
count and that the intended target was actually exercised, executes the relevant positive,
negative, boundary, malformed, authorization, state, concurrency, retry, restart, mutation and
recovery cases, independently verifies important side effects, preserves the first flaky failure,
cleans up and proves containment, and writes each ID's final status with evidence links. It then
updates the invalidation and blocker graphs, checkpoints, and prints `stage <V-0NN>: accounted`
when every owned ID has a final status. It exits **0 on accounting completion even when candidate
tests recorded `FAIL`** (VG-SHIP-002) and non-zero only on a harness `ERROR`.

(b) Per-stage deliverables for `V-000`…`V-009`, transcribed into the stage plan files from
`.agent/verification/stage-plans/` and the master prompt's stage meanings:

- `V-000` authorization, candidate/base pin, artifact identity, test overlay, capability adapter.
- `V-001` repository reality discovery: architecture, data, interfaces, deployments, support claims.
- `V-002` requirement/claim traceability and anti-simulation before accepting any feature claim.
- `V-003` registry ingestion, the 484-row applicability matrix, casebook validation, dependency graph.
- `V-004` existing baseline, static/design/formal-safe analysis, supply chain, secrets, IaC, workflows.
- `V-005` canonical clean bootstrap and build, packaging, SBOM/provenance/signing, reproducibility,
  artifact pin.
- `V-006` smoke and infrastructure breadth-first fail-fast checks.
- `V-007` recent-delta sanity and golden-path rationality.
- `V-008` unit/component/integration/full functional reality and real side-effect proofs.
- `V-009` API/protocol contracts, auth matrices, serialization, rate limits, integration,
  concurrency.

(c) `scripts/harness-next.sh` — prints the next stage whose owned IDs are not all accounted, as
`NEXT V-0NN`, or `ALL_STAGES_ACCOUNTED`. It never skips a stage, and it never re-runs a stage whose
accounting is complete unless its evidence was invalidated.

(d) Durable execution: checkpoint before and after each ID and at least every 15 minutes, recording
the current stage, ID, candidate epoch, SHA, artifact digest, environment, commands, exit codes,
evidence hashes, and the exact next action. There is no self-selected global campaign timeout; each
command has a safe timeout and cleanup, and long-duration work uses a persistent runner with
heartbeats.

(e) `COMMANDS.md` — append `sh scripts/harness-next.sh` and `sh scripts/harness-run-stage.sh <V-0NN>`
with their sentinels.

RUN:

```
sh scripts/harness-next.sh
sh scripts/harness-run-stage.sh V-000
sh scripts/harness-run-stage.sh V-001
sh scripts/harness-run-stage.sh V-002
sh scripts/harness-run-stage.sh V-003
sh scripts/harness-run-stage.sh V-004
sh scripts/harness-run-stage.sh V-005
sh scripts/harness-run-stage.sh V-006
sh scripts/harness-run-stage.sh V-007
sh scripts/harness-run-stage.sh V-008
sh scripts/harness-run-stage.sh V-009
sh scripts/harness-accounting.sh
```

EXPECT: one `stage V-0NN: accounted` line per stage, in that order, and a final `accounting:` line
whose numerator is the number of IDs that genuinely have final statuses. A `FAIL` inside a stage
does not stop the sequence; it is recorded and the next independent stage runs. A stage that cannot
execute at all records `ERROR` (harness) or the appropriate `BLOCKED_*` token with its required
fields — never a silent skip and never a blanket block across the 484 IDs.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M3 V-000..V-009 accounted"`

FALLBACK: if an environment needed by a stage cannot be provisioned, the adapter attempts
non-invasive provisioning first and records the attempt; the affected IDs are `ERROR` until the
setup is corrected (DOD-033). If the environment genuinely cannot host the stage (for example no
container runtime and no permitted egress to a declared target), the affected IDs are
`BLOCKED_ENVIRONMENT` with `environmentManifestRef`, `missingProperty`, and the provisioning
attempt log — and every independent ID in the same stage still runs.

COMMIT: `git add -A && git commit -m "[EP-010][M3] execute verification stages V-000 through V-009"`

### M4: Execute verification stages V-010 through V-019 with durable accounting

GOAL: The remaining executable stages run with per-ID statuses and evidence, long-running work is
labelled honestly, and independent tests continue past every candidate failure.

READ: `.agent/verification/stage-plans/V-010-stage.md` … `V-019-stage.md` and their slug duplicates;
`.agent/verification/GRAPH.md`, `EXECUTION_DAG.md`, `HARNESS_LAWS.md`;
`.agent/verification/MASTER_TEST_REGISTRY.csv`, casebooks;
`.agent/specs/SPEC-007-observability.md` §9–§11; `.agent/specs/SPEC-002-data-model.md`;
`.agent/DONE_LAW.md` (DOD-015, DOD-016, DOD-017, DOD-018, DOD-019, DOD-020, DOD-022, DOD-035,
DOD-036, DOD-037, DOD-038, DOD-040, DOD-041).

CHANGE: `.agent/verification/stage-plans/V-010-stage.md` … `V-019-stage.md` and their slug
duplicates, `.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json`,
`.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl`,
`.agent/verification/state/EVIDENCE_INDEX.json`,
`.agent/verification/state/CHANGE_INVALIDATION_GRAPH.md`, `COMMANDS.md`,
`.agent/evidence/EP-010/V-010..V-019/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) Per-stage deliverables for `V-010`…`V-019`:

- `V-010` data semantics, idempotency, migration, import/export, temporal behaviour, Unicode and i18n,
  state integrity.
- `V-011` upgrade, downgrade, version skew, configuration and feature-flag combinations, the
  cross-platform and supported-environment matrix.
- `V-012` regression, differential, property, formal and mutation confidence.
- `V-013` dynamic security plus the applicable General, HIPAA, Blockchain, AI/agentic, multi-tenant
  and domain packs — the applicability decisions of M2 decide which execute.
- `V-014` deterministic hypothesis-driven exploratory and ad-hoc testing.
- `V-015` usability, automated accessibility, developer experience, visual regression, and
  executable documentation.
- `V-016` performance, workload, scalability, cost, SLO, SLA and error-budget verification against
  the pinned epoch, including the induced-breach matrix of `VG-SLO-005`.
- `V-017` complete-duration soak, endurance, and resource-leak verification.
- `V-018` isolated stress, exhaustion, denial-of-service resilience, fault injection, and chaos.
- `V-019` recovery, disaster recovery, backup/restore, state reconciliation, observability truth,
  and RPO/RTO/MTTR.

(b) Long-running honesty: a soak, endurance, stress, fuzz, or recovery-duration requirement that
cannot complete inside the campaign window is recorded `DEFERRED_LONG_RUNNING` with `workload`,
`plannedDuration`, `elapsedDuration`, `startedAt`, `heartbeatRef`, `partialResultPath`, and
`completionEta`; the abbreviated portion is reported separately and **never** as `PASS` (DOD-038,
VG-SHIP-020). A five-minute run never passes a 72-hour requirement.

(c) Non-cascading continuation: a `FAIL` in `V-010` does not stop `V-011`…`V-019`. Only an ID with an
explicit dependency edge to a `FAIL`/`ERROR`/`INCOMPLETE` prerequisite is `BLOCKED_PREREQUISITE`,
with `blockingDependency` and `dependencyEdgeRef` populated and the prerequisite's own status
recorded. The validator rejects blanket blocking (DOD-031, VG-SHIP-014).

(d) Change invalidation: any change to code, dependency, schema, configuration, build inputs, test
oracle, or artifact during this milestone creates a **new** epoch, records the reason in
`EPOCH_HISTORY.md`, revokes the affected `PASS` statuses, and reruns every invalidated descendant
(DOD-040, VG-SHIP-005). "Cached green is not green."

(e) `COMMANDS.md` — no new command; the stages run through `harness-run-stage.sh`.

RUN:

```
sh scripts/harness-next.sh
sh scripts/harness-run-stage.sh V-010
sh scripts/harness-run-stage.sh V-011
sh scripts/harness-run-stage.sh V-012
sh scripts/harness-run-stage.sh V-013
sh scripts/harness-run-stage.sh V-014
sh scripts/harness-run-stage.sh V-015
sh scripts/harness-run-stage.sh V-016
sh scripts/harness-run-stage.sh V-017
sh scripts/harness-run-stage.sh V-018
sh scripts/harness-run-stage.sh V-019
sh scripts/harness-accounting.sh
```

EXPECT: one `stage V-0NN: accounted` line per stage; `V-017` is expected to produce
`DEFERRED_LONG_RUNNING` rows for any duration requirement that exceeds the campaign window, and
those rows are correct results, not failures of this milestone. The final `accounting:` line reports
the genuine numerator.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M4 V-010..V-019 accounted"`

FALLBACK: if a stage's required environment or entitlement is unavailable (for example no provider
entitlement for the transport stages), the affected IDs record `BLOCKED_CREDENTIALS` with the
`PREFLIGHT.md` row, the probe command, and the probe exit code, or `BLOCKED_SAFETY` with the
`VG-SCOPE-*` clause where the action is prohibited — and every independent ID in the stage still
runs to completion.

COMMIT: `git add -A && git commit -m "[EP-010][M4] execute verification stages V-010 through V-019"`

### M5: Execute V-020 and V-021 — exact-artifact clean-room, deployment, rollback, and external gates

GOAL: A virgin clean room installs and boots the exact final artifact from public documentation
alone, the deployment and rollback paths execute against the pinned digest, and every external gate
is recorded `EXTERNAL_REQUIRED` with its prepared request rather than impersonated.

READ: `.agent/verification/stage-plans/V-020-stage.md`, `V-021-stage.md` and their slug duplicates;
`.agent/specs/SPEC-008-production-readiness.md` §7, §8, §9;
`.agent/verification/TEST_ENVIRONMENT_MANIFEST.md`; `.agent/specs/SPEC-000-product-scope.md` §11;
`PREFLIGHT.md`, `LEGAL_REVIEW_REQUIRED.md`, `DEPLOYMENT.md`, `ROLLBACK.md`,
`.agent/verification/state/ARTIFACT_IDENTITY.json`; `.agent/DONE_LAW.md` (DOD-023, DOD-034, DOD-035,
DOD-036, DOD-039).

CHANGE: `.agent/verification/stage-plans/V-020-stage.md`, `V-021-stage.md` and their slug
duplicates, `scripts/clean-room.sh`, `scripts/live-fire.sh`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json`,
`.agent/verification/state/EVIDENCE_INDEX.json`, `COMMANDS.md`,
`.agent/evidence/EP-010/V-020..V-021/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `scripts/clean-room.sh` — a virgin clean-room procedure: a zero-state environment with only the
declared prerequisites, the artifact transferred by digest, installation using **only** public
documentation, boot, the golden path, and a post-run inventory of everything that had to be supplied
beyond the documentation. Any undocumented prerequisite or hand-supplied step is a defect, not a
note (DOD-034, VG-SHIP-028). Prints `clean room: ok` only when the golden path completes with no
undocumented step.

(b) `scripts/live-fire.sh` — artifact-bound live-fire for the twelve core outcomes
`LIVE-FIRE-PROOF-01`…`LIVE-FIRE-PROOF-12`, each executed end to end through its real entry point
against real dependencies, with runtime-generated canaries (DOD-013), independent read-back through
a second connection or client (DOD-012), and a per-outcome sentinel. It prints `live-fire: ok` only
when every outcome that is not externally constrained proves its rule; outcomes blocked by an
external entitlement (`LIVE-FIRE-PROOF-08`, `LIVE-FIRE-PROOF-12`) record `EXTERNAL_REQUIRED` with
the prepared request and the named participant role, and a genuine failure prints `FAIL` — never a
success sentinel (DOD-024, SPEC-008 §7).

(c) Deployment and rollback for the exact digest: deploy the pinned digest to the staging
environment where credentials permit, run post-deploy smoke against the deployed digest, execute the
rollback path with realistic state and reconcile, and record every step with its digest binding
(DOD-004, DOD-035). A production deployment is **not** executed: it is recorded as manual-only and
unauthorized (VG-SCOPE-009).

(d) External gates — recorded, requested, never impersonated. For each gate of SPEC-008 §9
(human UAT of the golden path; manual assistive-technology validation at WCAG 2.2 AA;
legal/compliance review of jurisdictions, agent evidence, templates, and claims; hardware/HSM or
accredited assessment where applicable; production deployment authorization), write an
`EXTERNAL_REQUIRED` row with `externalPartyRole`, `requestedArtifactDigest`, `requestEvidencePath`,
`requestedAt`, and `ownerContactRef`, and prepare the exact scenario list and artifact the
participant needs. An agent may prepare and request; only the named real participant may sign
(DOD-039). **An agent can never satisfy these gates, and until they are signed the verdict cannot
exceed `CONDITIONAL_EXTERNAL_GATES`** (VG-SHIP-030).

(e) `COMMANDS.md` — append `sh scripts/clean-room.sh` / `clean room: ok` and `sh scripts/live-fire.sh`
/ `live-fire: ok`. Both commands already exist in `scripts/` as loud-fail placeholders; this
milestone replaces the placeholder bodies with the real implementations.

RUN:

```
sh scripts/artifact-identity.sh
sh scripts/live-fire.sh
sh scripts/clean-room.sh
sh scripts/harness-run-stage.sh V-020
sh scripts/harness-run-stage.sh V-021
sh scripts/harness-accounting.sh
```

EXPECT: `artifact identity: ok`; then either `live-fire: ok` and `clean room: ok`, or the precise
taxonomy statuses for the outcomes and gates that cannot execute here, each with its required fields
and a named next action. `stage V-020: accounted` and `stage V-021: accounted` follow; the final
`accounting:` line reports the genuine numerator.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M5 V-020..V-021 accounted; external gates recorded EXTERNAL_REQUIRED"`

FALLBACK: if no staging credentials exist, the clean room and the deployment/rollback checks run
against the locally provisioned environment with the artifact transferred by digest and the
environment fingerprint labelled; the staging rows remain `BLOCKED_CREDENTIALS`, and the external
gates remain `EXTERNAL_REQUIRED`. A local run is never labelled staging, and no external gate is ever
marked signed.

COMMIT: `git add -A && git commit -m "[EP-010][M5] clean-room, deployment, rollback and external gates"`

### M6: Execute the complete 42-clause DOD gate

GOAL: All 42 clauses are individually evaluated with the evidence each names, the exact `or_else`
consequence is recorded where a clause does not pass, and no clause is satisfied by a group
statement.

READ: `.agent/DONE_LAW.md` (all 42 clauses), `.agent/verification/DOD_REGISTRY.csv` (42 rows),
`.agent/specs/SPEC-008-production-readiness.md` §4;
`.agent/verification/state/TEST_LEDGER.jsonl`, `EVIDENCE_INDEX.json`;
`PRODUCTION_READINESS.md`; `scripts/dod-gate.sh`.

CHANGE: `scripts/dod-gate.sh`, `PRODUCTION_READINESS.md`,
`.agent/verification/state/DOD_STATUS.jsonl`, `.agent/verification/state/EVIDENCE_INDEX.json`,
`.agent/verification/reports/FINAL_PRODUCTION_READINESS_REPORT.md` (partial sections only; the final
report is emitted in M8), `COMMANDS.md`, `.agent/evidence/EP-010/DOD/**`, `.agent/state/LEDGER.md`.

CONTENT:

(a) `PRODUCTION_READINESS.md` — replace the 99-byte summary with the complete Section 17 Definition
of Done and the Section 16 harness instantiated for this project: **one line per DOD clause**
containing DOD ID, applicability, RULE, BECAUSE, REQUIRED EVIDENCE, OR ELSE, current status, the
verifying command or artifact, and the owner. It also carries the candidate SHA and artifact digest,
the 484-test accounting summary, the remaining external gates, and the final release predicate. A
line whose status is not one of the SPEC-006 §4.1 tokens is invalid.

(b) `scripts/dod-gate.sh` — evaluates all **42** clauses at release scope. For each clause it
locates the evidence named by `required_evidence`, checks that the evidence belongs to the pinned
epoch and artifact digest, writes the clause's status with its required fields into
`DOD_STATUS.jsonl`, and, where the clause does not pass, records the clause's **exact** `or_else`
consequence — not a softened alternative (VG-SHIP-009). It asserts the registry has 42 unique IDs
with scope, rule, because, required evidence, and or-else present in every row, and that every
`must_account = true` clause is reported individually. It prints `definition of done: ok` only when
every applicable clause reports `PASS` with linked evidence. `PASS` is never inferred from the
absence of failure (VG-SHIP-011).

(c) Clause-specific notes the executor must not smooth over: DOD-010 (a mock may never be the sole
proof of an integration or production claim), DOD-013 (runtime-generated canaries, not fixtures),
DOD-023 (published commands executed exactly as written), DOD-024 (no masking), DOD-026 (the exact
taxonomy), DOD-027 (no fabricated success and no weakened oracle), DOD-030 (484 IDs, zero missing or
duplicated), DOD-031 (only declared dependents blocked), DOD-032 (per-status required fields),
DOD-034 (virgin clean room), DOD-035 (executed compatibility paths), DOD-036 (recovery against
reconciled state), DOD-038 (long-running labelled, never `PASS`), DOD-039 (external gates signed only
by real participants), DOD-040 (invalidated descendants rerun), DOD-041 (applicability from
repository evidence), DOD-042 (one machine-validated verdict).

(d) `COMMANDS.md` — append `sh scripts/dod-gate.sh` / `definition of done: ok`.

RUN:

```
sh scripts/dod-gate.sh
wc -l .agent/verification/state/DOD_STATUS.jsonl
grep -c '^| DOD-' PRODUCTION_READINESS.md
```

EXPECT: either `definition of done: ok` with 42 `DOD_STATUS.jsonl` rows and 42 table lines in
`PRODUCTION_READINESS.md`, or a non-zero exit with the exact per-clause statuses and `or_else`
consequences recorded. Both outcomes are legitimate; a `definition of done: ok` printed while any
clause lacks linked evidence is a fabrication defect.

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M6 dod-gate executed; 42 clauses recorded"`

FALLBACK: if a clause cannot be evaluated because its evidence depends on an unprovisioned external
environment, the clause is recorded with the taxonomy status of that dependency and its `or_else`
consequence, and the clause is listed among the release blockers with a named next action. A clause
is never marked `PASS` because its evidence is missing, and never marked `NOT_APPLICABLE` without
repository evidence.

COMMIT: `git add -A && git commit -m "[EP-010][M6] execute the complete 42-clause DOD gate"`

### M7: Reconcile the 484-ID accounting and the evidence-graph invariants

GOAL: The accounting invariant holds with zero unaccounted and zero duplicated IDs, every status
carries its required fields, claims resolve to evidence, and invalidated descendants are rerun.

READ: `.agent/specs/SPEC-008-production-readiness.md` §5, §11;
`.agent/specs/SPEC-006-errors.md` §4.1, §4.2;
`.agent/verification/state/TEST_LEDGER.jsonl`, `DOD_STATUS.jsonl`, `STATUS_TRANSITION_AUDIT.jsonl`,
`EVIDENCE_INDEX.json`, `DEPENDENCY_BLOCKER_GRAPH.json`;
`.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv`,
`CLAIM_TO_RELEASE_TRACEABILITY.csv`; `.agent/verification/HARNESS_LAWS.md`;
`.agent/DONE_LAW.md` (DOD-025, DOD-030, DOD-031, DOD-032, DOD-040, DOD-041).

CHANGE: `scripts/harness-accounting.sh`, `scripts/harness-validate.sh`,
`.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv`,
`.agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv`,
`.agent/verification/state/TEST_LEDGER.jsonl`,
`.agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl`,
`.agent/verification/state/EVIDENCE_INDEX.json`,
`.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json`, `COMMANDS.md`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) `COMPLETE_TEST_ACCOUNTING.csv` — exactly **484** data rows, one per registry ID, with `test_id`,
`source_group`, `owner_stage`, `applicability`, `status`, `reason`, `evidence_path`, `epoch_id`,
`artifact_digest`, `blocking_dependency`, `next_action`. The header stays as it is; the rows are the
accounting. The file has zero rows today; filling it is the point of this milestone, and every row
must be backed by a ledger entry.

(b) The invariant check, executed and printed by `harness-accounting.sh`:

```
registered IDs (484) = passed + failed + errored + inconclusive + not applicable
                     + prerequisite blocked + environment blocked
                     + capability/credential/safety blocked
                     + external required + deferred long-running
```

with zero unaccounted and zero duplicated IDs (DOD-030, VG-SHIP-015).

(c) Per-status field validation for every `FAIL` (`expected`, `actual`, `firstFailureLogPath`),
`ERROR` (`harnessStackRef`), each `BLOCKED_*` (its limitation field and a non-null
`blockingDependency` where the token requires one), `EXTERNAL_REQUIRED` (`externalPartyRole`,
`requestedArtifactDigest`, `requestEvidencePath`, `requestedAt`, `ownerContactRef`),
`DEFERRED_LONG_RUNNING` (`workload`, `plannedDuration`, `elapsedDuration`, `startedAt`,
`heartbeatRef`, `partialResultPath`), `PARTIAL` (`coveredSurface[]`, `uncoveredSurface[]`,
`coverageDenominator`), `SIMULATED` (`substitutedDependency`, `doubleKind`, `realPathPlanRef`),
`NOT_APPLICABLE` (`applicabilityEvidence[]`, `decisionRuleRef`, `decidedBy`, `decidedAt`), and
`UNVERIFIED` (`reasonUnverified`, `plannedCommand`, `owner`). Rows failing validation are rejected
and corrected before the verdict (DOD-032, VG-SHIP-016).

(d) Status-transition audit: every transition out of `PASS` or `FAIL` has a recorded reason and an
epoch-identity change, written to `STATUS_TRANSITION_AUDIT.jsonl` (SPEC-006 ST-2). No status is
changed by narrative, summary, or model output (ST-4).

(e) `CLAIM_TO_RELEASE_TRACEABILITY.csv` — one resolvable row per claimed capability: `claim`,
`requirement`, `test`, `evidence`, `status`. An empty or narrative-only file fails the gate
(VG-SHIP-037). Every `evidence` value resolves to a stored artifact with a digest; a dangling path
rejects the claim (VG-EVIDENCE-002 as carried into the release surface).

(f) Blocker and invalidation graphs: every `BLOCKED_PREREQUISITE` row has an edge in
`DEPENDENCY_BLOCKER_GRAPH.json`; every change since the epoch pin has its invalidated descendants
listed and rerun, with the rerun results in the ledger (DOD-031, DOD-040). A blanket blocker
assignment across many IDs is rejected.

(g) `COMMANDS.md` — no new command; the reconciliation runs through `harness-accounting.sh` and
`harness-validate.sh`.

RUN:

```
sh scripts/harness-accounting.sh
sh scripts/harness-validate.sh
wc -l .agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv
wc -l .agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv
python3 scripts/validate-generated-pack.py .
python3 scripts/anti-gaming-scan.py .
```

EXPECT: `accounting: 484/484 accounted` and `harness validation: ok`; the accounting CSV line count
is `485` (header plus 484 rows) and the claim traceability CSV has one resolvable row per claimed
capability. `python3 scripts/validate-generated-pack.py .` must still pass; a hit from
`python3 scripts/anti-gaming-scan.py .` requires classification, and an unclassified hit in a
production path is a release blocker (DOD-019, DOD-024).

EVIDENCE: `sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M7 accounting: 484/484 accounted; harness validation: ok"`

FALLBACK: if an ID genuinely cannot be decided (for example an applicability predicate whose
evidence request is outstanding), it stays `CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE` or
`UNVERIFIED` with its required fields, the accounting invariant still holds because the ID is
accounted **as unverified**, and the verdict reflects it. The one thing that is never permitted is
omitting the ID.

COMMIT: `git add -A && git commit -m "[EP-010][M7] reconcile 484-ID accounting and evidence graphs"`

### M8: Run the ship gate and emit exactly one machine-validated verdict

GOAL: The complete ship gate runs for the pinned epoch and digest, and exactly one verdict is
emitted and validated against its schema.

READ: master §13 (the ship gate), `.agent/specs/SPEC-008-production-readiness.md` §1, §2, §7, §10,
§12; `.agent/DONE_LAW.md` (DOD-004, DOD-024, DOD-029, DOD-030, DOD-034, DOD-037, DOD-039, DOD-042);
`.agent/verification/HARNESS_LAWS.md`;
`.agent/verification/state/RUN_MANIFEST.json`, `RELEASE_GATE.json`,
`HARNESS_VALIDATION_REPORT.json`; `.agent/verification/reports/*`.

CHANGE: `scripts/production-readiness-check.sh`, `.agent/verification/state/RELEASE_GATE.json`,
`.agent/verification/state/RUN_STATE.json`,
`.agent/verification/reports/FINAL_PRODUCTION_READINESS_REPORT.md`,
`.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md`,
`schemas/release-gate.schema.json`, `RELEASE.md`, `PRODUCTION_READINESS.md`, `COMMANDS.md`,
`.agent/state/LEDGER.md`.

CONTENT:

(a) `schemas/release-gate.schema.json` — written first, from SPEC-008 §1–§2, with required
properties: `verdict` (enum of the four tokens), `reason`, `candidate_epoch`, `candidate_sha`,
`artifact_digest`, `dod: { total: 42, pass, fail, other, unaccounted }`,
`registry: { total: 484, passed, failed, errored, inconclusive, not_applicable,
blocked_prerequisite, blocked_environment, blocked_capability, blocked_credentials,
blocked_safety, external_required, deferred_long_running, unaccounted }`,
`external_gates: [ { gate, status, externalPartyRole, requestedArtifactDigest } ]`,
`release_blockers: []`, `next_action`, `emitted_at`. `additionalProperties: false`.

(b) `scripts/production-readiness-check.sh` — implements the ship gate in the order the master prompt
fixes, and is resumable rather than pretending one session completes multi-day work:

1. Pin the candidate SHA and artifact digest (re-assert `epoch: pinned` and
   `artifact identity: ok`).
2. Run a fresh-clone-equivalent `sh scripts/verify.sh` and require `verify: ok`.
3. Run or resume the verification subgraph until `V-021` completes, via `harness-next.sh` and
   `harness-run-stage.sh`.
4. Run `sh scripts/harness-validate.sh` and require `harness validation: ok`.
5. Run `sh scripts/dod-gate.sh` and require `definition of done: ok`.
6. Run `sh scripts/harness-accounting.sh` and require `accounting: 484/484 accounted` with zero
   unaccounted IDs.
7. Verify that every `PASS` points to real evidence for the current epoch and digest; a stale-epoch
   or unhashed `PASS` revokes the claim.
8. Emit `RELEASE_GATE.json` and `FINAL_PRODUCTION_READINESS_REPORT.md`, then validate
   `RELEASE_GATE.json` against `schemas/release-gate.schema.json`.
9. Only on `GO`: create the release tag, emit the production deploy step as `MANUAL` (never
   executed, VG-SCOPE-009), run post-deploy smoke against the deployed digest **if and only if** an
   authorised operator deployed, and append `RUN_COMPLETE`.
10. On any other verdict: create no production-ready tag, perform no deployment, and append the
    truthful verdict, its exact blockers, and the exact next action.

It prints `production-readiness: accounted` when accounting completed, and exits non-zero for
`NO_GO` and `INCONCLUSIVE` (VG-SHIP-002). The sentinel means *accounting completed*, never *passed*.

(c) `FINAL_PRODUCTION_READINESS_REPORT.md` — the fifteen required sections: executive verdict and
exact candidate/artifact identity; scope and authorization; repository architecture and product
claims; execution adapters and environments; test-accounting totals by source pack, stage,
applicability and result; material claims and anti-simulation results; the functional, API, data,
compatibility, regression, security, UX, performance, soak, stress, recovery, deployment and UAT
summaries; validated findings ordered by release risk; blocked, deferred, external and
not-applicable tests with evidence; coverage and limitations; exact release blockers; residual risk
and required external work; the evidence index; reproduction and resume instructions; and the final
release predicate. It distinguishes verified behaviour, partially verified behaviour, unverified
assumptions, blocked work, external gates, accepted risks, and every remaining limitation (DOD-028,
VG-SHIP-038), and it states the exact verdict and the exact blockers (VG-SHIP-039). Promotional
language is prohibited.

(d) `RESIDUAL_RISK_AND_EXTERNAL_GATES.md` — every open external gate with its named participant
role, the artifact digest it must sign, the request evidence path, and the effect on the verdict.

(e) `RUN_STATE.json` — set to the terminal state for this run: `ALL_DONE` when the epoch is fully
accounted, or `RUN_BLOCKED` with the blocking condition. `RELEASE_GATE.json` holds the verdict;
`RUN_STATE.json` never carries a verdict.

(f) One verdict, exactly once. `RELEASE_GATE.json` contains exactly one `verdict` value from the four
tokens. Any contradictory claim in a commit message, document, or UI string is a fabrication defect
(DOD-027, VG-SHIP-003). While the verdict is not `GO`, no production-ready tag exists and no
deployment occurs.

RUN:

```
sh scripts/epoch-pin.sh
sh scripts/verify.sh
sh scripts/production-readiness-check.sh
sh scripts/harness-validate.sh
sh scripts/dod-gate.sh
sh scripts/harness-accounting.sh
cat .agent/verification/state/RELEASE_GATE.json
python3 scripts/validate-generated-pack.py .
python3 scripts/anti-gaming-scan.py .
git tag
```

EXPECT: `epoch: pinned`; `verify: ok`; from `production-readiness-check.sh` the line
`production-readiness: accounted` followed by the emitted verdict and the gate's exit code;
`harness validation: ok`; `definition of done: ok`; `accounting: 484/484 accounted`;
`RELEASE_GATE.json` containing exactly one verdict token; `generated pack validation: ok`; and
`git tag` showing **no** production-ready tag unless the verdict is `GO`, in which case the release
tag is created. A non-zero exit from `production-readiness-check.sh` together with the accounting
sentinel means the accounting completed and the verdict is not `GO` — that is a valid, complete
execution of this node, and the node closes with it.

EVIDENCE:
`sh scripts/ledger.sh append <AGENT_ID> EP-010 MILESTONE_PASS "M8 production-readiness: accounted; verdict=<VERDICT>"`
followed, when the epoch is fully accounted and the run is terminal, by
`sh scripts/ledger.sh append <AGENT_ID> EP-010 NODE_DONE "EP-010 complete; verdict=<VERDICT>; artifact=<DIGEST>"`
and, for a terminal run, `sh scripts/ledger.sh append <AGENT_ID> EP-010 RUN_COMPLETE "run complete; verdict=<VERDICT>"`.

FALLBACK: if the harness itself is materially invalid (for example the validator cannot run, or the
registry or casebooks fail integrity), the verdict is `INCONCLUSIVE` with the harness defect named as
the reason, no tag is created, and the defect is reported as the exact next action. `INCONCLUSIVE`
is the honest outcome for an invalid harness; it is never rounded to `NO_GO` or hidden as a
`BLOCKED_*` row (SPEC-008 §2).

COMMIT: `git add -A && git commit -m "[EP-010][M8] run ship gate and emit the machine-validated verdict"`

## 9. Validation and Acceptance

Node-level acceptance, each item an executed observation for the pinned epoch and artifact digest:

1. `sh scripts/epoch-pin.sh` prints `epoch: pinned` with every §7.2 field populated, including the
   artifact digest from EP-009.
2. `.agent/verification/APPLICABILITY_MATRIX.csv` has **485** lines (header plus 484 ID rows), every
   row carries an individual decision with at least one concrete evidence reference, and stage
   ownership is non-overlapping and sums to 484.
3. `sh scripts/harness-validate.sh` prints `harness validation: ok` and its self-tests demonstrably
   reject all-484 blanket blocking, `PASS` without evidence, `NOT_APPLICABLE` without repository
   evidence, zero-test collection, a missing ID, a duplicated ID, stale-epoch evidence, and a
   prerequisite block without a dependency edge.
4. `sh scripts/harness-accounting.sh` prints `accounting: 484/484 accounted` and the invariant of
   §7.3 holds with zero unaccounted and zero duplicated IDs.
5. `.agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv` has 484 data rows, every status is a
   SPEC-006 §4.1 token carrying that token's required fields, and every row resolves to a ledger
   entry in the pinned epoch.
6. `sh scripts/dod-gate.sh` records all **42** clauses individually in
   `.agent/verification/state/DOD_STATUS.jsonl`, each with the evidence its `required_evidence`
   column names or with its exact `or_else` consequence; `PRODUCTION_READINESS.md` contains one line
   per clause with ID, applicability, rule, because, required evidence, or-else, status, verifying
   command or artifact, and owner.
7. Stages `V-000`…`V-021` each reached `stage <V-0NN>: accounted`, in the order declared by
   `.agent/verification/GRAPH.md`, and a candidate `FAIL` did not halt any independent stage
   (`DEPENDENCY_BLOCKER_GRAPH.json` shows edges only for declared dependents).
8. `sh scripts/verify.sh` prints `verify: ok` for the pinned epoch, and `sh scripts/live-fire.sh`
   prints `live-fire: ok` for every outcome not externally constrained.
9. `sh scripts/clean-room.sh` printed `clean room: ok`, or the clean room's findings are recorded as
   release blockers with their exact evidence.
10. Every external gate is `EXTERNAL_REQUIRED` with `externalPartyRole`, `requestedArtifactDigest`,
    `requestEvidencePath`, `requestedAt`, and `ownerContactRef`; no gate is marked signed by an
    agent; while any mandatory gate is open the verdict does not exceed `CONDITIONAL_EXTERNAL_GATES`.
11. `CLAIM_TO_RELEASE_TRACEABILITY.csv` has one resolvable row per claimed capability, each with a
    stored evidence digest; an empty or narrative-only file fails the gate.
12. `RELEASE_GATE.json` validates against `schemas/release-gate.schema.json` and contains exactly one
    verdict from `GO`, `NO_GO`, `CONDITIONAL_EXTERNAL_GATES`, `INCONCLUSIVE`.
13. `FINAL_PRODUCTION_READINESS_REPORT.md` contains the fifteen required sections and distinguishes
    verified behaviour, partially verified behaviour, unverified assumptions, blocked work, external
    gates, accepted risks, and every remaining limitation.
14. No production-ready tag exists and no deployment occurred unless the verdict is `GO`; the
    production deploy step is recorded `MANUAL` and unauthorized (VG-SCOPE-009).
15. Every change since the epoch pin has its invalidated descendants listed and rerun, and no
    pre-change `PASS` survives (DOD-040).
16. No file outside §6's list changed: `git status --short` is the audit list.

**Never claim** a verdict other than the one in `RELEASE_GATE.json`. While that file does not say
`GO`, the project is not ready, not complete, and not production-ready, and no document, commit
message, or summary may say otherwise (SPEC-008 §13, DOD-027, VG-SHIP-003).

## 10. Idempotence and Recovery

To re-enter cold: read `AGENTS.md`, `COMMANDS.md`, `.agent/GRAPH.md`, `.agent/LOOPS.md`, this plan's
§11 Progress, then `.agent/state/LEDGER.md` and `sh scripts/ledger.sh status EP-010`. Read
`.agent/verification/state/RUN_STATE.json` for the campaign state,
`.agent/verification/state/RUN_MANIFEST.json` for the pinned epoch, and
`.agent/verification/state/NEXT_ACTION.md` for the exact resume point. Resume at the first milestone
with no `MILESTONE_PASS` event, and re-run the previous milestone's gate to confirm its sentinel
still holds before proceeding.

The campaign is resumable by construction: checkpoint before and after each ID and at least every 15
minutes, recording stage, ID, epoch, SHA, artifact digest, environment, commands, exit codes,
evidence hashes, and the exact next action (master §16.6). There is no self-selected global
timeout; a platform or session limit causes a durable resume, not a lost campaign and not a
shortened requirement.

Immutability: the candidate is immutable from `V-000` through `V-021`. A harness or environment
defect is fixed in the overlay and recorded `ERROR` until corrected; a correctly executed product
defect is `FAIL`. After complete accounting, remediation creates a **new** epoch, the original epoch
remains immutable evidence, and every invalidated descendant is rerun (VG-SHIP-005, DOD-040). The
final report lists every epoch and why evidence was superseded.

Blocker discipline: only IDs with an explicit dependency edge are blocked, and every blocked ID
carries its token's required fields with a named next action. Blanket blocking invalidates the
accounting. Provisioning gaps are `ERROR` until the adapter has attempted non-invasive provisioning
(DOD-033).

Bounded retry: at most six attempts per milestone following the ladder — targeted fix, diagnosis,
real fallback, rollback, structured block — and never the same fix twice. A blocked node emits the
structured `NODE_BLOCKED` / `RUN_BLOCKED` report rather than a softened status.

## 11. Progress

- [ ] M1: Freeze the candidate epoch and pin identity from the real starting state
- [ ] M2: Initialize the verification subgraph, ingest the registry, and decide applicability for all 484 IDs
- [ ] M3: Execute verification stages V-000 through V-009 with durable accounting
- [ ] M4: Execute verification stages V-010 through V-019 with durable accounting
- [ ] M5: Execute V-020 and V-021 — exact-artifact clean-room, deployment, rollback, and external gates
- [ ] M6: Execute the complete 42-clause DOD gate
- [ ] M7: Reconcile the 484-ID accounting and the evidence-graph invariants
- [ ] M8: Run the ship gate and emit exactly one machine-validated verdict

## 12. Surprises & Discoveries

<!-- Append only observed, dated findings with the exact command that produced them. -->

## 13. Decision Log

| # | Decision | Rationale | Status |
|---|---|---|---|
<!-- The executor records here the rulings of §7.9, every applicability decision rule it adopts, every epoch boundary, and every substitution made under a FALLBACK. -->

## 14. Outcomes & Retrospective

<!-- Filled in only after the node closes, with real observed evidence and the emitted verdict. -->
