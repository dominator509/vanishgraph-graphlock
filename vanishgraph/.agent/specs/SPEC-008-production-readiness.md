# SPEC-008 — Production Readiness, Verification Accounting, and the Ship Gate

Status: SPECIFICATION (normative).
Depends on: SPEC-000 (§6 requirements, §9 acceptance oracle), SPEC-001, SPEC-002,
SPEC-005, and `.agent/DONE_LAW.md` (the 42 DOD clauses).
Conflict resolution: `DONE_LAW.md` and SPEC-000 win.

Requirement prefixes: `VG-SHIP-<NNN>`. `VG-REL-001`…`VG-REL-004` are reserved by
SPEC-000 and are not redefined here.

---

## 1. What "shippable" means

"Shippable" is not a narrative opinion and is not a status a human or a model may
declare. It is the **conjunction** of the following, each of which is machine-
checkable and evidence-bound:

1. Every applicable DOD clause (§4) reports `PASS` with linked evidence.
2. All **484** registry IDs carry an individual applicability decision and a final
   status; zero unaccounted, zero duplicated.
3. Every applicable release-blocking test passes for the **current immutable
   candidate epoch** (VG-REL-004).
4. The **exact artifact digest** passes packaging, artifact-bound smoke,
   artifact-bound E2E, clean-room install, deployment, and rollback gates.
5. No unresolved critical/high defect, fake feature, hidden skipped test, false
   health signal, unsafe migration, or unproven critical claim remains.
6. Applicable human, legal, hardware, and accredited gates are genuinely complete
   — or the verdict is limited to `CONDITIONAL_EXTERNAL_GATES`.

## 2. The four verdicts

Exactly four verdicts exist. Free-form completion language is prohibited
(VG-REL-001, DOD-042).

| Verdict | Precise meaning |
|---|---|
| `GO` | Every internal and mandatory external release gate is satisfied for the exact artifact. |
| `NO_GO` | At least one release-blocking candidate defect, DOD failure, fake/incomplete feature, invalid artifact identity, unsafe data/recovery condition, or mandatory omitted test exists. |
| `CONDITIONAL_EXTERNAL_GATES` | Every executable internal gate passes and only genuinely human/hardware/accredited/authorised-external work remains. **This is not production approval.** |
| `INCONCLUSIVE` | Evidence is insufficient, or the harness itself is materially invalid. |

- **VG-SHIP-001** The verdict is produced only by the machine-validated ship gate
  and is recorded in `RELEASE_GATE.json` conforming to
  `schemas/` validation.
- **VG-SHIP-002** A verification-stage command may exit `0` when accounting
  completed even if candidate tests recorded `FAIL`; the **final release gate
  exits non-zero** for `NO_GO` and `INCONCLUSIVE`. These two behaviours are
  deliberately different and must not be conflated.
- **VG-SHIP-003** Optimism is not a status. Any claim stronger than its evidence
  is a fabrication defect (DOD-027).

## 3. Candidate epochs and artifact identity

- **VG-SHIP-004** A candidate epoch pins: candidate commit SHA, base revision,
  test-overlay revision, build inputs, toolchain versions, image digests, and the
  release artifact digest (DOD-029).
- **VG-SHIP-005** Evidence is immutable **within** an epoch. Any change to code,
  dependency, schema, configuration, build inputs, test oracle, or artifact
  creates a **new** epoch and invalidates affected descendants (DOD-040).
- **VG-SHIP-006** Reused pre-change evidence is invalid. "Cached green is not
  green" — the final review re-runs verification from a fresh clone.
- **VG-SHIP-007** Epoch identity propagates into telemetry (SPEC-007) so that
  every log, metric, and trace is bound to the artifact that produced it.

## 4. DOD gate

- **VG-SHIP-008** All 42 clauses in `.agent/DONE_LAW.md` are evaluated. A clause
  is `PASS` only with the evidence its `required_evidence` column names.
- **VG-SHIP-009** Where a clause's `or_else` applies, that exact consequence is
  recorded — not a softened alternative.
- **VG-SHIP-010** `must_account = true` clauses are individually reported; a
  clause may not be satisfied by a blanket statement about a group.
- **VG-SHIP-011** Clause status uses the exact SPEC-006 taxonomy. `PASS` is never
  inferred from absence of failure.

## 5. Registry accounting

- **VG-SHIP-012** All 484 IDs receive one of: an applicability decision
  (`APPLICABLE` / `NOT_APPLICABLE` with repository evidence) and a final status
  from the SPEC-006 taxonomy.
- **VG-SHIP-013** Applicability is decided from repository evidence, never
  assumption (DOD-041). Conditional domain packs (HIPAA, blockchain, AI/agentic,
  multi-tenant, mobile, cloud, hardware) are activated or skipped on recorded
  evidence.
- **VG-SHIP-014** A failed prerequisite blocks only tests with an explicit
  dependency edge; independent tests continue to completion (DOD-031). Blanket
  blocking invalidates the accounting.
- **VG-SHIP-015** Zero IDs missing or duplicated is an invariant that fails the
  build, not a review note (DOD-030).
- **VG-SHIP-016** Every `FAIL`, `ERROR`, `BLOCKED_*`, `EXTERNAL_REQUIRED`, and
  `DEFERRED_LONG_RUNNING` row carries the required fields of its definition
  (DOD-032).

## 6. Verification subgraph

- **VG-SHIP-017** Stages `V-000`…`V-021` execute in order with durable accounting
  per `.agent/verification/GRAPH.md`.
- **VG-SHIP-018** The DAG is non-cascading: candidate failures do not halt
  independent stages (`EXECUTION_DAG.md`).
- **VG-SHIP-019** Registry IDs are owned by exactly one stage; ownership is
  recorded and non-overlapping.
- **VG-SHIP-020** Long-running stages (soak, endurance, fuzz, stress) that are
  abbreviated are labelled `DEFERRED_LONG_RUNNING` and never `PASS` (DOD-038).

## 7. Artifact-bound acceptance

- **VG-SHIP-021** Smoke, E2E, and live-fire run against the **exact production
  artifact digest**, not a source tree or development server (DOD-004).
- **VG-SHIP-022** Source-level E2E runs earlier under integration testing and
  **cannot** satisfy final release acceptance.
- **VG-SHIP-023** Critical proofs use runtime-generated unpredictable canaries
  (DOD-013) and independent read-back through a second client or connection
  (DOD-012).
- **VG-SHIP-024** Mocks may isolate units but never constitute the sole proof of
  an integration or production claim (DOD-010).
- **VG-SHIP-025** Live-fire proves each core outcome end-to-end through its real
  entry point against real dependencies, and prints its sentinel only on genuine
  success.

## 8. Environment and clean room

- **VG-SHIP-026** Required tests run in an ephemeral clean environment or a
  documented persistent environment created from a known baseline (DOD-005).
- **VG-SHIP-027** The repository builds from a clean checkout using committed
  frozen/locked dependency files and the declared toolchain (DOD-002). A failure
  here records `FAIL` for the clean-build gate while independent tests continue.
- **VG-SHIP-028** A virgin clean room installs and boots the exact final artifact
  using only public documentation and declared prerequisites, then completes the
  golden path (DOD-034).
- **VG-SHIP-029** Published README/install/upgrade/rollback commands are executed
  exactly as written (DOD-023). Documentation drift is a defect, not a footnote.

## 9. Mandatory external gates (human authority)

These can never be satisfied by an agent, a model, or automation. Impersonating
any of them is a fabrication defect (DOD-039).

| Gate | Required participant |
|---|---|
| Human UAT of the golden path | Named authorised business participant |
| Manual assistive-technology validation (WCAG 2.2 AA) | Named AT practitioner |
| Legal/compliance review of jurisdictions, agent evidence, templates, claims | Qualified counsel |
| Hardware/HSM or accredited assessment (where applicable) | Accredited assessor |
| Production deployment authorisation | Authorised operator (manual only, VG-SCOPE-009) |

- **VG-SHIP-030** Until these are signed, the verdict cannot exceed
  `CONDITIONAL_EXTERNAL_GATES`.
- **VG-SHIP-031** Named sign-off records participant, scope, date, scenarios, and
  unresolved findings.

## 10. No-masking rules

- **VG-SHIP-032** No test or scanner failure may be hidden by continue-on-error,
  ignored exit codes, unconditional success, swallowed exceptions, blanket catch,
  all-retry policies, filtered output, or baseline auto-acceptance (DOD-024).
  Detection invalidates the run and revokes dependent `PASS` claims.
- **VG-SHIP-033** A placeholder gate must fail loudly rather than print a success
  sentinel. Where a real command is genuinely unknowable pre-discovery, the
  script emits the mandated `ERROR:` line and exits non-zero.
- **VG-SHIP-034** A gate "passes" only when it was actually executed in the
  current session and the sentinel appeared in real output. Recalling a prior
  result, or reading the script, is not a pass.

## 11. Evidence preservation

- **VG-SHIP-035** Raw commands, tool versions, exit codes, logs, reports, traces,
  seeds, environment fingerprints, candidate SHA, artifact hashes, and evidence
  digests are preserved and indexed (DOD-025).
- **VG-SHIP-036** Every result links to a content hash; an unhashed claim is
  `INCONCLUSIVE`.
- **VG-SHIP-037** `CLAIM_TO_RELEASE_TRACEABILITY.csv` contains one resolvable row
  per claimed capability. An empty or narrative-only file fails the gate.

## 12. Final report requirements

- **VG-SHIP-038** The final report distinguishes, explicitly and separately:
  verified behavior, partially verified behavior, unverified assumptions, blocked
  work, external gates, accepted risks, and every remaining limitation
  (DOD-028).
- **VG-SHIP-039** It states the exact ship-gate verdict and the exact blockers.
- **VG-SHIP-040** It reports accounted/expected test totals and names anything
  unaccounted. A report that omits a known limitation is invalid.

## 13. Current project status (honest record)

Recorded here because the pack's own law forbids narrative promotion. Status as
of the FORGE completion of this specification set:

| Element | Status |
|---|---|
| Specification documents (SPEC-000…SPEC-008) | Authored (this change set) |
| ExecPlans EP-000…EP-010 | Authored to the Section 11 grammar |
| Product source code | Present only for the domain layer (EP-002 partial); no API, UI, persistence adapter, or infrastructure |
| Database migrations | Not created — EP-003 not executed |
| Keycloak, Temporal, Valkey, object store, KMS | Not provisioned (`PROVISIONABLE_ENVIRONMENT` / `BLOCKED_CREDENTIALS`) |
| Registry accounting (484 IDs) | Not begun — `COMPLETE_TEST_ACCOUNTING.csv` empty |
| Verification subgraph V-000…V-021 | Not executed |
| Artifact, clean-room, deployment, rollback | Not performed |
| Human/legal/AT gates | `EXTERNAL_REQUIRED` — no participants named |
| Ship verdict | `INCONCLUSIVE` |

Per VG-SHIP-001, the verdict is `INCONCLUSIVE` and **must not** be reported as
`GO`, "ready", "complete", or "production-ready" in any UI, document, commit
message, or summary. Any such claim is a fabrication defect under DOD-027.
