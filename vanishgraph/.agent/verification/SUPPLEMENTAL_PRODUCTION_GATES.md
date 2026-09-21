# Supplemental gates

Fifteen gates cover artifact identity, evidence, no-gaming, live-fire, isolation, egress, recipe freshness, accessibility, performance, recovery, clean-room, external accounting, verdict and manual deploy.

**THIS FILE WAS THE 231-BYTE SUMMARY ABOVE AND NOTHING ELSE UNTIL EP-010 M13.** It named fifteen gate subjects in one
sentence and contained no per-ID method, so the executor classified every `SUP-*` entry as `summary-source`, reported
"there is nothing to execute for this ID" and recorded `BLOCKED_PREREQUISITE` with `capability:per-id-definition`. The
fifteen sections below are the real per-ID definitions: method, commands, oracle, negative case where the repository
genuinely has one, and the completion gate. **WHERE NO NEGATIVE CASE EXISTS, THE SECTION SAYS SO** — an entry whose
covering gate has no executed negative control cannot reach `PASS` under SPEC-006 section 4.1's repository-mapped
execution, and claiming otherwise would be the fabricated success this repository forbids.

---

## SUP-001 Repository Reality / Anti-Simulation Verification

- **Method.** Scan every production path for placeholder, stub, fake, demo, simulation, no-op, dead-route,
  hard-coded-success and unfinished-code vocabulary, and separately refuse a simulated adapter that a production
  path would select. `src/**` is the production path set; tests, scripts and pack documents are not.
- **Commands.** `sh scripts/reality-gate.sh`
- **Oracle.** Exit 0 with the sentinel `reality gate: ok`. A hit is permitted only by a per-line, reviewed entry in
  `.agent/reality-allow`, which is empty by design.
- **Negative case.** NOT DECLARED. The gate has no executed control that plants a placeholder and requires a
  refusal, so a repository-mapped `PASS` is not available for this subject and the entry stays `PARTIAL` naming that
  absence. The gate's failure mode was observed for real in FORGE-SPEC-1..9, when three prose hits made it exit 1
  without its sentinel; those hits were reworded at source in EP-010 M12 rather than allow-listed.
- **Completion gate.** DOD-019.

## SUP-002 Requirements-to-Release Traceability Verification

- **Method.** Resolve every published claim to a stored artifact with a hash, and report any claim whose evidence
  value is not a path plus digest; a claim with no runnable artifact becomes `EXTERNAL_REQUIRED` naming its
  participant rather than being dressed as verified.
- **Commands.** `sh scripts/reconcile-claims.sh`
- **Oracle.** The reconciliation sentinel with one row per claim whose `evidence` column matches
  `<path> sha256:<digest>`, and zero unresolvable evidence values.
- **Negative case.** NOT DECLARED as a runnable control. The reconciliation refuses a claim whose evidence is prose,
  and that refusal was observed for real in EP-010 M7 when all 45 rows carried narrative sentences, but no
  repeatable planted-fault control is declared for this gate.
- **Completion gate.** DOD-025, DOD-030, VG-EVIDENCE-002.

## SUP-003 Packaging & Distribution Artifact Verification

- **Method.** Produce the installable package with its SBOM, provenance and checksum manifest; confirm every
  declared artifact path exists and every recorded digest resolves from the bytes on disk.
- **Commands.** `sh scripts/build-artifact.sh`, then `sh scripts/artifact-identity.sh`
- **Oracle.** `artifact: built` from the first and `artifact identity: ok` from the second, with every declared
  artifact path present and every digest RESOLVED.
- **Negative case.** NOT DECLARED. `artifact-identity.sh` does refuse a missing or tampered artifact - observed for
  real in EP-010 M12, when `build.sh` wiped `dist/` and all four recorded paths were reported missing - but that
  refusal is not driven by a declared, repeatable control.
- **Completion gate.** DOD-003, DOD-029.

## SUP-004 Reproducible Build Verification

- **Method.** Build the artifact twice into scratch locations and compare the content manifests, provenance and
  checksums byte for byte; record the container digests with their reconciliation.
- **Commands.** `sh scripts/build-reproducibility.sh`
- **Oracle.** `artifact reproducible: ok` with `CONTENT_IDENTICAL` recorded in the artifact identity under
  `reproducibility`.
- **Negative case.** NOT DECLARED as a planted-fault control. The comparison is itself a two-sided measurement -
  two independent builds must agree byte for byte - which is strong evidence, but it is not a control.
- **Completion gate.** DOD-003, SPEC-008 section 3.

## SUP-005 Upgrade Path Verification

- **Method.** Exercise the upgrade, downgrade and rollback paths against a prior released artifact and compare the
  old and new state hashes.
- **Commands.** `sh scripts/upgrade-drill.sh`
- **Oracle.** The drill's sentinel with both versions' state hashes recorded.
- **Negative case.** NOT DECLARED, and the precondition is absent: only one artifact version exists in this
  repository, so the from-prior path cannot run at all. The clause records `BLOCKED_PREREQUISITE` for exactly that
  reason (DOD-035) rather than a claim.
- **Completion gate.** DOD-035.

## SUP-006 Idempotency, Retry & Delivery-Semantics Verification

- **Method.** Assert that repeated delivery of the same request produces one effect, that retries are bounded, and
  that acknowledgement semantics hold under concurrency, in the suites that own those modules.
- **Commands.** `sh scripts/test-integration.sh`, `sh scripts/test-unit.sh`
- **Oracle.** `test-integration: ok` and `test-unit: ok` with zero failures, including the idempotency and
  concurrency suites.
- **Negative case.** NOT DECLARED as a gate control; the idempotency suites contain executed negative cases for the
  modules they own, but no separate planted-fault control is declared for this subject.
- **Completion gate.** DOD-017.

## SUP-007 Configuration & Feature-Flag Combinatorial Verification

- **Method.** Validate every declared key against the environment schema for each environment class, refusing
  missing required keys, empty values, prohibited substitutes, malformed values and unknown keys, and restore the
  fixture afterwards.
- **Commands.** `sh scripts/config-validate.sh`
- **Oracle.** Exit 0 with the sentinel `config: ok`, AND the five negative-control markers plus the restoration
  marker present in the gate's own output for this epoch. The executor requires all six before it will grant a
  repository-mapped `PASS` for this subject.
- **Negative case.** DECLARED, AND EXECUTED ON EVERY RUN. The gate refuses a missing required key
  (`MISSING_REQUIRED_KEY`), an empty value (`EMPTY_VALUE`), a prohibited substitute (`PROHIBITED_SUBSTITUTE`), a
  malformed value (`MALFORMED_VALUE`) and an unknown key (`UNKNOWN_KEY`), then proves the untouched fixture still
  validates cleanly. This is the repository's strongest declared control, and it is why this entry can reach `PASS`.
- **Completion gate.** DOD-020, DOD-032.

## SUP-008 Cross-Platform & Supported-Environment Matrix Verification

- **Method.** Confirm the declared toolchain versions and the published commands behave as documented on the
  supported environment, by running the published commands exactly as written.
- **Commands.** `sh scripts/gate-toolchain.sh`, `sh scripts/published-commands.sh`
- **Oracle.** `gate-toolchain: ok` and a published-command run recording zero drift, with the tool versions
  recorded.
- **Negative case.** NOT DECLARED.
- **Completion gate.** DOD-002, DOD-023.

## SUP-009 Executable Documentation & Quickstart Verification

- **Method.** Treat the documentation as a contract: install the artifact into a virgin directory using only the
  documented command, then inventory every item the room had to supply beyond the documentation.
- **Commands.** `sh scripts/clean-room.sh`
- **Oracle.** `clean room: ok` with zero UNDOCUMENTED prerequisites in the inventory.
- **Negative case.** NOT DECLARED as a planted control. An undocumented prerequisite is itself the defect that
  fails the room, and that failure was observed for real in EP-010 M5 - three times, each an installer defect that
  was then fixed.
- **Completion gate.** DOD-034, VG-SHIP-028.

## SUP-010 Visual Regression Verification

- **Method.** Render the declared portal and console surfaces and assert their structure, contrast tokens and
  region states against the declared expectations.
- **Commands.** `sh scripts/test-e2e.sh` and the contract render suites under `tests/contract/`
- **Oracle.** `end-to-end tests: ok`, or `BLOCKED_ENVIRONMENT` naming the missing browser runtime - which is what
  this environment reports, honestly, rather than a pass.
- **Negative case.** NOT DECLARED for the gate.
- **Completion gate.** SPEC-004, VG-UI-013/021.

## SUP-011 Operational Observability Correctness Verification

- **Method.** Assert that the telemetry contract holds: required resource attributes resolve or fail closed, metric
  names and meanings come from the catalogue, and no PII reaches a log or an error envelope.
- **Commands.** `sh scripts/test-unit.sh`, `sh scripts/security-check.sh`
- **Oracle.** Both sentinels with zero failures, including the observability identity and masking suites.
- **Negative case.** NOT DECLARED as a gate control.
- **Completion gate.** DOD-013, DOD-024, SPEC-007.

## SUP-012 SLO, SLA & Error-Budget Release Verification

- **Method.** Evaluate the objectives declared in `config/slo/objectives.json` against measured signals, and refuse
  a release claim the budget does not support.
- **Commands.** `sh scripts/slo-evaluate.sh`
- **Oracle.** The evaluator's sentinel with the objectives it evaluated and the budget state recorded.
- **Negative case.** NOT DECLARED, and the measurement half is absent: no percentile measurement was taken in this
  environment, which is why the clause records `DEFERRED_LONG_RUNNING` (DOD-022) rather than a claim.
- **Completion gate.** DOD-022, DOD-038.

## SUP-013 Deployment, Promotion, Canary & Rollback Lifecycle Verification

- **Method.** Deploy to staging, verify the deployed digest, exercise the canary and rollback paths, and confirm the
  operator-visible record.
- **Commands.** `sh scripts/staging-deploy.sh`, `sh scripts/staging-verify.sh`, `sh scripts/rollback-drill.sh`
- **Oracle.** Each script's sentinel with the deployed digest read back and compared against the pinned digest.
- **Negative case.** NOT DECLARED, and staging is `NOT_PROVISIONED` in this environment, so the path is recorded as
  `BLOCKED_CREDENTIALS`/`BLOCKED_ENVIRONMENT` rather than claimed.
- **Completion gate.** DOD-009, DOD-020, VG-SHIP-030.

## SUP-014 Multi-Tenant Isolation & Noisy-Neighbor Verification

- **Method.** Prove cross-tenant denial at BOTH layers: the service-layer matrix, and row-level security against a
  real database, with counts showing no state change and no external effect.
- **Commands.** `sh scripts/test-integration.sh`
- **Oracle.** The integration sentinel with zero failures, including the cross-tenant two-layer suite.
- **Negative case.** NOT DECLARED as a gate control; the suite contains executed cross-tenant refusal cases, but no
  planted-fault control is declared for the gate.
- **Completion gate.** DOD-010, VG-AUTH-022, VG-TENANT-001/002.

## SUP-015 Manual Accessibility & Assistive-Technology Validation

- **Method.** A named assistive-technology practitioner exercises every declared route with a screen reader and by
  keyboard alone, and records scope, findings and unresolved items.
- **Commands.** none: this is a human gate, and no command can satisfy it.
- **Oracle.** A sign-off record naming the practitioner's role, method, date, scope, unresolved findings, the digest
  they validated and a stored artifact whose sha256 matches - the record
  `.agent/evidence/EP-010/V-021/SIGNOFF_INSTRUCTIONS.md` specifies.
- **Negative case.** Not applicable: an agent may never satisfy this gate, and may not refuse it either (DOD-039).
- **Completion gate.** DOD-039; `EXTERNAL_REQUIRED` until the practitioner signs.
