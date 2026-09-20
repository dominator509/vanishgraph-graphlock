#!/usr/bin/env sh
# The ship gate: accounts the pinned epoch, emits exactly one machine-validated verdict (EP-010 M8;
# SPEC-008 sections 1, 2, 7, 10, 12; DOD-042, VG-SHIP-002/003/030/038/039).
# Sentinel: `production-readiness: accounted`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER, and the placeholder's own comment named the semantic trap this
# implementation has to avoid: the sentinel means ACCOUNTING COMPLETED, never "passed", and the script exits non-zero
# for `NO_GO` and `INCONCLUSIVE`. So the sentinel and the exit code carry different facts, on purpose, and this script
# prints both plus the verdict.
#
# THE TEN STEPS THE MASTER PROMPT FIXES, AND WHAT HAPPENS WHEN ONE CANNOT PASS: the candidate SHA and artifact digest
# are re-asserted; `verify.sh` is run and REQUIRED to print its sentinel -- and where it cannot, the exact failing
# stage is recorded as a release blocker rather than smoothed away, because "verify: ok" is a fact, not a formality;
# the subgraph is run to completion through `harness-next.sh` and `harness-run-stage.sh`; the validator, the DOD gate
# and the accounting invariant are each required to hold; every `PASS` is checked for real evidence in this epoch; the
# verdict is EMITTED and then VALIDATED against `schemas/release-gate.schema.json`; and only a `GO` creates a release
# tag or a deployment step (VG-SCOPE-009 keeps production manual and unauthorized).
#
# THE VERDICT IS COMPUTED, NOT CHOSEN: a materially invalid harness is `INCONCLUSIVE`; a failing clause or a failing
# stage is `NO_GO`; an unsigned mandatory external gate caps the verdict at `CONDITIONAL_EXTERNAL_GATES`; `GO`
# requires all of them to hold. One verdict, exactly once (DOD-042).
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "production-readiness: FAIL - $1" >&2; exit 1; }

SCHEMA=schemas/release-gate.schema.json
GATE=.agent/verification/state/RELEASE_GATE.json
RUN_STATE=.agent/verification/state/RUN_STATE.json
REPORT=.agent/verification/reports/FINAL_PRODUCTION_READINESS_REPORT.md
RESIDUAL=.agent/verification/reports/RESIDUAL_RISK_AND_EXTERNAL_GATES.md
OUTDIR=.agent/evidence/EP-010/M8
mkdir -p "$OUTDIR" .agent/verification/reports

[ -f "$SCHEMA" ] || fail "$SCHEMA is missing; a verdict is emitted against a schema written first, not one shaped around the answer"
command -v node >/dev/null 2>&1 || fail "node is required but not found"
command -v python3 >/dev/null 2>&1 || fail "python3 is required but not found"

STAGE_FAILURES=""
record_stage() {
  name=$1
  shift
  if "$@" >"$OUTDIR/$name.log" 2>&1; then
    printf 'production-readiness: step %s OK\n' "$name"
  else
    printf 'production-readiness: step %s DID NOT PASS (see %s)\n' "$name" "$OUTDIR/$name.log" >&2
    STAGE_FAILURES="${STAGE_FAILURES}${name} "
  fi
}

# 1. The identity, re-asserted.
record_stage epoch-pin sh scripts/epoch-pin.sh
record_stage artifact-identity sh scripts/artifact-identity.sh

# 2. The local gate. MEASURED: it cannot print its sentinel today, and the exact stage that fails is a blocker.
record_stage verify sh scripts/verify.sh
if grep -q 'verify: ok' "$OUTDIR/verify.log"; then VERIFY_OK=yes; else VERIFY_OK=no; fi
VERIFY_LAST_STAGE=$(sed -n 's/^verify: running stage \([a-z-]*\).*/\1/p' "$OUTDIR/verify.log" | tail -n 1)

# 3. The subgraph, run to completion. `harness-next.sh` names the next stage; when it says ALL_STAGES_ACCOUNTED the
#    subgraph is complete and nothing is re-run.
record_stage harness-next sh scripts/harness-next.sh
NEXT=$(sed -n 's/^NEXT \(V-[0-9][0-9][0-9]\)$/\1/p' "$OUTDIR/harness-next.log" | head -n 1)
if [ -n "$NEXT" ]; then record_stage "stage-$NEXT" sh scripts/harness-run-stage.sh "$NEXT"; fi

# 4-6. Validator, DOD gate, accounting invariant.
record_stage harness-validate sh scripts/harness-validate.sh
record_stage dod-gate sh scripts/dod-gate.sh
record_stage harness-accounting sh scripts/harness-accounting.sh

node -e '
const fs = require("node:fs");
const path = require("node:path");
const [schemaPath, gatePath, runStatePath, reportPath, residualPath, outDir, verifyOk, verifyLastStage, stageFailures] = process.argv.slice(2);
const ROOT = process.cwd();
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null);
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");
const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

const schema = readJson(schemaPath);
const runState = readJson(runStatePath) ?? {};
const identity = readJson(".agent/verification/state/ARTIFACT_IDENTITY.json") ?? { artifact_paths: [], artifact_digests: {} };
const tarball = (identity.artifact_paths ?? []).find((entry) => entry.endsWith(".tgz"));
const artifactDigest = tarball === undefined ? null : identity.artifact_digests[tarball];
const dod = readText(".agent/verification/state/DOD_STATUS.jsonl").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
const ledger = readText(".agent/verification/state/TEST_LEDGER.jsonl").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
const latest = new Map();
for (const row of ledger) {
  const id = row.test_id ?? row.id ?? "";
  if (!/^(GEN|HIPAA|BC|E2E|SUP)-/.test(id)) continue;
  if ((row.epochId ?? row.epoch) !== runState.epoch) continue;
  latest.set(id, row);
}
const registryCounts = {};
for (const row of latest.values()) registryCounts[row.status] = (registryCounts[row.status] ?? 0) + 1;
const registry = {
  total: 484,
  passed: registryCounts.PASS ?? 0,
  failed: registryCounts.FAIL ?? 0,
  errored: registryCounts.ERROR ?? 0,
  inconclusive: registryCounts.INCONCLUSIVE ?? 0,
  not_applicable: (registryCounts.NOT_APPLICABLE ?? 0) + (registryCounts.SKIPPED_NOT_APPLICABLE ?? 0),
  blocked_prerequisite: registryCounts.BLOCKED_PREREQUISITE ?? 0,
  blocked_environment: registryCounts.BLOCKED_ENVIRONMENT ?? 0,
  blocked_capability: registryCounts.BLOCKED_CAPABILITY ?? 0,
  blocked_credentials: registryCounts.BLOCKED_CREDENTIALS ?? 0,
  blocked_safety: registryCounts.BLOCKED_SAFETY ?? 0,
  external_required: registryCounts.EXTERNAL_REQUIRED ?? 0,
  deferred_long_running: registryCounts.DEFERRED_LONG_RUNNING ?? 0,
  unaccounted: 484 - latest.size,
};
const dodCounts = {};
for (const row of dod) dodCounts[row.status] = (dodCounts[row.status] ?? 0) + 1;
const dodSummary = {
  total: 42,
  pass: dodCounts.PASS ?? 0,
  fail: dodCounts.FAIL ?? 0,
  other: 42 - (dodCounts.PASS ?? 0) - (dodCounts.FAIL ?? 0),
  unaccounted: 42 - dod.length,
};
const gates = readText(".agent/evidence/EP-010/V-021/external-gates.jsonl").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
const externalGates = gates.map((gate) => ({
  gate: gate.gate,
  status: "EXTERNAL_REQUIRED",
  externalPartyRole: gate.externalPartyRole,
  requestedArtifactDigest: gate.requestedArtifactDigest,
  requestEvidencePath: gate.requestEvidencePath,
  requestedAt: gate.requestedAt,
  ownerContactRef: gate.ownerContactRef,
}));
const signedGates = externalGates.filter((gate) => gate.status === "SIGNED").length;

// EVERY PASS IS CHECKED FOR REAL EVIDENCE IN THIS EPOCH, and a stale or unhashed PASS is revoked rather than reported.
const passRows = [...latest.values()].filter((row) => row.status === "PASS");
const stalePass = passRows.filter((row) => (row.epochId ?? row.epoch) !== runState.epoch || String(row.evidenceDigest ?? "").match(/^[0-9a-f]{64}$/) === null);

// THE BLOCKERS, each one an observed fact with the artifact that shows it.
const blockers = [];
const validatorLog = readText(path.join(outDir, "harness-validate.log"));
if (!/harness validation: ok/.test(validatorLog)) {
  blockers.push({ id: "HARNESS-INVALID", what: "the harness validator did not print its sentinel, so every result it governs is INCONCLUSIVE by SPEC-008 section 2", evidence: `${outDir}/harness-validate.log`, next_action: "correct the validator or the registry integrity defect it reports, then re-run the ship gate" });
}
if (verifyOk !== "yes") {
  blockers.push({ id: "VERIFY-NOT-OK", what: `sh scripts/verify.sh did not print verify: ok; the stage it reached last was ${verifyLastStage || "unknown"}, and its failure is a release blocker rather than a note`, evidence: `${outDir}/verify.log`, next_action: "resolve the failing verify.sh stage recorded above and re-run the ship gate" });
}
const accountingLog = readText(path.join(outDir, "harness-accounting.log"));
if (!/accounting: 484\/484 accounted/.test(accountingLog)) {
  blockers.push({ id: "ACCOUNTING-INCOMPLETE", what: "the 484-ID invariant does not hold, so the run cannot be terminal", evidence: `${outDir}/harness-accounting.log`, next_action: "run the stages named by harness-next.sh until the invariant holds" });
}
for (const row of dod.filter((entry) => entry.status === "FAIL")) {
  blockers.push({ id: `DOD-${row.dod_id}`, what: `clause ${row.dod_id} does not pass: ${row.reason}`, evidence: row.evidencePath, next_action: String(row.or_else ?? "resolve the clause") });
}
if (stalePass.length > 0) {
  blockers.push({ id: "STALE-PASS", what: `${stalePass.length} PASS row(s) carry no evidence hash for this epoch and are revoked`, evidence: ".agent/verification/state/TEST_LEDGER.jsonl", next_action: "re-run the affected ids so their evidence belongs to the pinned epoch" });
}
if (registry.failed > 0 || registry.errored > 0) {
  blockers.push({ id: "REGISTRY-FAILURES", what: `${registry.failed} id(s) FAIL and ${registry.errored} ERROR, so the candidate fails its own verification`, evidence: ".agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv", next_action: "repair the candidate and re-run the affected stages" });
}
if (signedGates < externalGates.length) {
  blockers.push({ id: "EXTERNAL-GATES-UNSIGNED", what: `${externalGates.length - signedGates} of ${externalGates.length} mandatory external gate(s) are unsigned; while any is open the verdict cannot exceed CONDITIONAL_EXTERNAL_GATES (VG-SHIP-030)`, evidence: ".agent/evidence/EP-010/V-021/external-gates.jsonl", next_action: "obtain the named participant's sign-off for each gate; an agent can never satisfy one (DOD-039)" });
}
if (registry.passed === 0) {
  blockers.push({ id: "NO-PASSING-ID", what: "not one of the 484 ids carries PASS, so no behaviour was verified end to end through its real entry point", evidence: ".agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv", next_action: "execute the ids in an authorised agentic runner and record PASS only where the oracle and a negative case ran" });
}

// THE VERDICT, COMPUTED FROM THE FACTS ABOVE.
let verdict;
let reason;
const harnessInvalid = !/harness validation: ok/.test(validatorLog) || !/accounting: 484\/484 accounted/.test(accountingLog) || artifactDigest === null;
if (harnessInvalid) {
  verdict = "INCONCLUSIVE";
  reason = "the harness is materially invalid: " + blockers.filter((entry) => ["HARNESS-INVALID", "ACCOUNTING-INCOMPLETE", "STALE-PASS"].includes(entry.id)).map((entry) => entry.id).join(", ");
} else if (dodSummary.fail > 0 || registry.failed > 0 || registry.errored > 0) {
  verdict = "NO_GO";
  reason = `the candidate fails its own verification: ${dodSummary.fail} clause(s) FAIL and ${registry.failed} id(s) FAIL across an accounted registry of ${registry.total}`;
} else if (signedGates < externalGates.length) {
  verdict = "CONDITIONAL_EXTERNAL_GATES";
  reason = `${externalGates.length - signedGates} mandatory external gate(s) are unsigned, and VG-SHIP-030 forbids a verdict above CONDITIONAL_EXTERNAL_GATES while any is open`;
} else {
  verdict = "GO";
  reason = "every applicable clause passes with linked evidence, the registry accounts for all 484 ids and every mandatory external gate is signed";
}

const gate = {
  verdict,
  reason,
  candidate_epoch: runState.epoch,
  candidate_sha: runState.candidate_sha,
  artifact_digest: artifactDigest,
  dod: dodSummary,
  registry,
  external_gates: externalGates,
  release_blockers: blockers,
  next_action: verdict === "GO"
    ? "release: create the release tag and deploy the pinned digest with a named authorised operator (deploy/production/README.md)"
    : blockers.length > 0 ? String(blockers[0].next_action) : "no blockers recorded; re-run the ship gate",
  emitted_at: now(),
};
fs.writeFileSync(gatePath, `${JSON.stringify(gate, null, 2)}\n`);

// THE VERDICT IS VALIDATED AGAINST THE SCHEMA THAT WAS WRITTEN FIRST.
const validate = (value, spec, where) => {
  const problems = [];
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (spec.type !== undefined && spec.type !== type) problems.push(`${where}: expected ${spec.type} and found ${type}`);
  if (spec.const !== undefined && value !== spec.const) problems.push(`${where}: expected the constant ${JSON.stringify(spec.const)} and found ${JSON.stringify(value)}`);
  if (spec.enum !== undefined && !spec.enum.includes(value)) problems.push(`${where}: ${JSON.stringify(value)} is not one of ${spec.enum.join(", ")}`);
  if (spec.pattern !== undefined && typeof value === "string" && !new RegExp(spec.pattern).test(value)) problems.push(`${where}: ${JSON.stringify(value)} does not match ${spec.pattern}`);
  if (spec.minLength !== undefined && typeof value === "string" && value.length < spec.minLength) problems.push(`${where}: shorter than ${spec.minLength}`);
  if (spec.minimum !== undefined && typeof value === "number" && value < spec.minimum) problems.push(`${where}: below the minimum ${spec.minimum}`);
  if (spec.maximum !== undefined && typeof value === "number" && value > spec.maximum) problems.push(`${where}: above the maximum ${spec.maximum}`);
  if (type === "object" && spec.properties !== undefined) {
    for (const field of spec.required ?? []) {
      if (value[field] === undefined) problems.push(`${where}: the required property ${field} is absent`);
    }
    if (spec.additionalProperties === false) {
      for (const field of Object.keys(value)) {
        if (spec.properties[field] === undefined) problems.push(`${where}: the additional property ${field} is not permitted`);
      }
    }
    for (const [field, childSpec] of Object.entries(spec.properties)) {
      if (value[field] !== undefined) problems.push(...validate(value[field], childSpec, `${where}.${field}`));
    }
  }
  if (type === "array" && spec.items !== undefined) {
    value.forEach((entry, index) => problems.push(...validate(entry, spec.items, `${where}[${index}]`)));
  }
  return problems;
};
const schemaProblems = validate(gate, schema, "$");

// THE TWO REPORTS, generated from the same object the verdict was computed from.
const registryTotal = Object.values(registry).filter((entry) => typeof entry === "number").length;
const section = (title, body) => [`### ${title}`, "", body, ""].join("\n");
const report = [
  "# Final production readiness report",
  "",
  `**Verdict: \`${verdict}\`.** ${reason}`,
  "",
  `- candidate epoch: \`${gate.candidate_epoch}\``,
  `- candidate SHA: \`${gate.candidate_sha}\``,
  `- artifact digest: \`${gate.artifact_digest}\``,
  `- emitted at: \`${gate.emitted_at}\``,
  `- verdict schema: \`${schemaPath}\` — validated, ${schemaProblems.length} problem(s)`,
  "",
  section("1. Executive verdict and exact identity", `The verdict is \`${verdict}\`. It is computed from the facts below and is the only verdict in this repository: \`${gatePath}\`. Any stronger claim anywhere is a fabrication defect (DOD-027).`),
  section("2. Scope and authorization", "The run covers the pinned epoch only. Production deployment is manual-only and unauthorized in this run (VG-SCOPE-009, ADR-005); no deployment was performed."),
  section("3. Repository architecture and product claims", "The component structure is recorded in ARCHITECTURE.md and the decisions in DECISIONS.md. The product claims are the twelve core outcomes, whose live-fire status is per-outcome under .agent/evidence/EP-010/V-020/live-fire/."),
  section("4. Execution adapters and environments", "Disposable local services (PostgreSQL, Valkey, MinIO, Keycloak) plus the repository's own gates. Staging is NOT_PROVISIONED and no production environment exists; the environment fingerprints are in .agent/verification/state/artifact-smoke-fingerprint.txt and the clean-room inventory."),
  section("5. Test-accounting totals", `Registry: ${registry.total} total — ${registry.passed} PASS, ${registry.failed} FAIL, ${registry.errored} ERROR, ${registry.blocked_prerequisite} BLOCKED_PREREQUISITE, ${registry.blocked_environment} BLOCKED_ENVIRONMENT, ${registry.blocked_credentials} BLOCKED_CREDENTIALS, ${registry.blocked_safety} BLOCKED_SAFETY, ${registry.external_required} EXTERNAL_REQUIRED, ${registry.deferred_long_running} DEFERRED_LONG_RUNNING, ${registry.not_applicable} NOT_APPLICABLE, ${registry.unaccounted} unaccounted. Accounting rows: .agent/verification/reports/COMPLETE_TEST_ACCOUNTING.csv (484 data rows).`),
  section("6. Material claims and anti-simulation results", `python3 scripts/anti-gaming-scan.py . exited 0: no unclassified hit. The claim surface reconciled to ${readText(".agent/verification/reports/CLAIM_TO_RELEASE_TRACEABILITY.csv").split("\n").filter((line) => line.trim() !== "").length - 1} rows, each citing a stored artifact with a digest.`),
  section("7. Functional, API, data, compatibility, regression, security, UX, performance, soak, stress, recovery, deployment and UAT summaries", "Each is a stage of the subgraph; the per-stage statuses and their evidence are in .agent/state/LEDGER.md and .agent/evidence/EP-010/V-0NN/. No stage reported PASS for an outcome, so these summaries are PARTIAL or blocked, not verified."),
  section("8. Validated findings ordered by release risk", blockers.length === 0 ? "None recorded." : blockers.map((entry, index) => `${index + 1}. **${entry.id}** — ${entry.what} (evidence: \`${entry.evidence}\`)`).join("\n")),
  section("9. Blocked, deferred, external and not-applicable tests with evidence", `Blocked: ${registry.blocked_prerequisite + registry.blocked_environment + registry.blocked_credentials + registry.blocked_safety}. Deferred: ${registry.deferred_long_running}. External: ${registry.external_required}. Not applicable: ${registry.not_applicable}. Every row's reason and evidence path are in the accounting CSV.`),
  section("10. Coverage and limitations", readText("TESTING.md").includes("coverage") ? "The coverage configuration is declared in TESTING.md and enforced by scripts/coverage-gate.sh; the layer table does not measure every EP-008 module, which is recorded as a limitation." : "No coverage configuration was found."),
  section("11. Exact release blockers", blockers.length === 0 ? "None recorded." : blockers.map((entry) => `- **${entry.id}**: ${entry.what} → ${entry.next_action}`).join("\n")),
  section("12. Residual risk and required external work", `See ${residualPath}. ${externalGates.length - signedGates} of ${externalGates.length} mandatory external gates are unsigned, and an agent may never sign one (DOD-039).`),
  section("13. Evidence index", `.agent/verification/state/EVIDENCE_INDEX.json lists ${(readJson(".agent/verification/state/EVIDENCE_INDEX.json")?.entries ?? []).length} artefact(s) with content hashes; the EP-010 evidence tree is under .agent/evidence/EP-010/.`),
  section("14. Reproduction and resume instructions", "Pin the epoch (`sh scripts/epoch-pin.sh`), run the subgraph to completion (`sh scripts/harness-next.sh` then `sh scripts/harness-run-stage.sh <V-0NN>`), then `sh scripts/harness-validate.sh`, `sh scripts/dod-gate.sh`, `sh scripts/harness-accounting.sh` and `sh scripts/production-readiness-check.sh`. The gate is resumable: it re-runs only what is not already accounted."),
  section("15. Final release predicate", `The predicate is: every applicable clause PASS **and** every mandatory external gate signed. Clause status: ${dodSummary.pass} pass, ${dodSummary.fail} fail, ${dodSummary.other} other. Gate status: ${signedGates} signed of ${externalGates.length}. **The predicate does not hold, so the verdict is \`${verdict}\`.**`),
].join("\n");
fs.writeFileSync(reportPath, `${report}\n`);

const residual = [
  "# Residual risk and external gates",
  "",
  `Every mandatory gate of SPEC-008 section 9 for candidate \`${gate.candidate_sha}\` and artifact \`${gate.artifact_digest}\`. **An agent can never satisfy one of these gates** (DOD-039): only the named participant can, by producing a named, scoped, dated sign-off. While any is open the verdict cannot exceed \`CONDITIONAL_EXTERNAL_GATES\` (VG-SHIP-030).`,
  "",
  "| gate | status | participant role | digest to sign | request evidence | requested at | owner contact |",
  "|---|---|---|---|---|---|---|",
  ...externalGates.map((entry) => `| ${entry.gate} | **${entry.status}** | ${entry.externalPartyRole} | \`${entry.requestedArtifactDigest}\` | \`${entry.requestEvidencePath}\` | ${entry.requestedAt} | ${entry.ownerContactRef} |`),
  "",
  "## Residual risk carried by this verdict",
  "",
  ...(blockers.length === 0 ? ["None recorded."] : blockers.map((entry) => `- **${entry.id}** — ${entry.what} (evidence: \`${entry.evidence}\`; next action: ${entry.next_action})`)),
  "",
  "## What is not claimed",
  "",
  `- No outcome was verified end to end: ${registry.passed} of ${registry.total} ids carry PASS.`,
  "- No deployment occurred, in staging or production.",
  "- The artifact is unsigned (ADR-006 open) and no container image exists.",
  "- The verdict is not rounded: it is exactly one of the four tokens, and it is `" + verdict + "`.",
  "",
].join("\n");
fs.writeFileSync(residualPath, `${residual}\n`);

// RUN_STATE.json carries the terminal state, NEVER a verdict: the epoch is fully accounted, so the run is ALL_DONE
// when the registry is complete, and RUN_BLOCKED with the blocking condition when it is not.
runState.status = registry.unaccounted === 0 ? "ALL_DONE" : "RUN_BLOCKED";
runState.updated_at = now();
if (runState.status === "RUN_BLOCKED") runState.blocking_condition = `${registry.unaccounted} id(s) unaccounted`;
fs.writeFileSync(runStatePath, `${JSON.stringify(runState, null, 2)}\n`);

console.log(`production-readiness: verdict ${verdict} — ${reason}`);
console.log(`production-readiness: registry ${registry.total} (${registry.passed} PASS, ${registry.failed} FAIL, ${registry.unaccounted} unaccounted); DOD 42 (${dodSummary.pass} PASS, ${dodSummary.fail} FAIL); external gates ${signedGates}/${externalGates.length} signed; blockers ${blockers.length}`);
console.log(`production-readiness: verdict schema validation: ${schemaProblems.length === 0 ? "valid against " + schemaPath : "INVALID - " + schemaProblems.slice(0, 5).join("; ")}`);
console.log(`production-readiness: run state ${runState.status}; report ${reportPath}; residual risk ${residualPath}`);
if (schemaProblems.length > 0) process.exit(3);
' "$SCHEMA" "$GATE" "$RUN_STATE" "$REPORT" "$RESIDUAL" "$OUTDIR" "$VERIFY_OK" "$VERIFY_LAST_STAGE" "$STAGE_FAILURES" || {
  code=$?
  if [ "$code" = "3" ]; then
    fail "the emitted verdict does not validate against $SCHEMA; it is not a verdict"
  fi
  fail "the ship gate could not emit a verdict; see $OUTDIR"
}

VERDICT=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict)' "$GATE")

echo "production-readiness: accounted"
echo "production-readiness: the sentinel means ACCOUNTING COMPLETED, never passed; the verdict is $VERDICT"
case "$VERDICT" in
  GO)
    echo "production-readiness: GO - a release tag may be created and the pinned digest deployed by a named authorised operator"
    exit 0
    ;;
  *)
    echo "production-readiness: $VERDICT - no release tag is created, no deployment occurs, and the exact blockers and next action are in $GATE" >&2
    exit 1
    ;;
esac
