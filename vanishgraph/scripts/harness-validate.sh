#!/usr/bin/env sh
# Harness validator (EP-010 M2(e); SPEC-006 section 4.1, VG-SHIP-019/020, DOD-026/030/031/032).
# Sentinel: `harness validation: ok`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER, which refused to print a sentinel while no validator existed
# (DOD-024, DOD-027). This is the implementation it was waiting for.
#
# WHAT IT VALIDATES: the registry snapshot (count, uniqueness, prefix counts, casebook coverage), stage ownership
# and its totality, the applicability matrix (a decision per ID, the four permitted decision values, non-empty
# evidence and rule reference, an owner stage in range), the dependency seed, the DOD registry count, and every
# status row against the SPEC-006 section 4.1 schema -- whose status vocabulary and required fields are PARSED FROM
# THE SPECIFICATION rather than restated here, so the validator cannot drift from the taxonomy it enforces.
#
# THE EIGHT REJECTIONS THE MILESTONE MANDATES ARE EXECUTED AS SELF-TESTS, using the same functions the real
# validation uses, against synthetic fixtures: a fabricated 484-row blanket BLOCKED_CAPABILITY ledger; PASS without
# evidence; NOT_APPLICABLE without repository evidence; zero-test collection; a missing ID; a duplicated ID; a
# stale-epoch PASS; and a BLOCKED_PREREQUISITE without a dependency edge. A validator that cannot fail is a
# placebo, so each self-test requires its rejection, and a self-test that does NOT reject fails the validator.
#
# WHAT IT DELIBERATELY DOES NOT FAIL ON: the accounting count. At this milestone no per-ID status exists for the
# current epoch, so 484/484 is legitimately unreachable; the plan says so, and it says the number must not be
# "fixed" by writing statuses that have not been executed. The accounting is REPORTED here as a measured fact and
# enforced by scripts/harness-accounting.sh, not invented here.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "harness validation: FAIL - $1" >&2; exit 1; }

REGISTRY=.agent/verification/MASTER_TEST_REGISTRY.csv
CASEBOOKS=.agent/verification/casebooks
GRAPH=.agent/verification/GRAPH.md
SEED=.agent/verification/state/DEPENDENCY_BLOCKER_GRAPH.json
MATRIX=.agent/verification/APPLICABILITY_MATRIX.csv
SPEC006=.agent/specs/SPEC-006-errors.md
DOD_REGISTRY=.agent/verification/DOD_REGISTRY.csv
TEST_LEDGER=.agent/verification/state/TEST_LEDGER.jsonl
REPORT=.agent/verification/state/HARNESS_VALIDATION_REPORT.json

for path in "$REGISTRY" "$SEED" "$MATRIX" "$SPEC006" "$DOD_REGISTRY"; do
  [ -f "$path" ] || fail "$path is missing; the validator cannot validate what does not exist"
done
command -v node >/dev/null 2>&1 || fail "node is required but not found"

VALIDATE=$(mktemp)
trap 'rm -f "$VALIDATE"' EXIT INT TERM
cat >"$VALIDATE" <<'ENDS_HARNESS_VALIDATE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [registryPath, casebookDir, graphPath, seedPath, matrixPath, specPath, dodPath, ledgerPath, reportPath] = process.argv.slice(2);
const ROOT = process.cwd();
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const readCsv = (text) => {
  const rows = []; let row = []; let field = ""; let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') { if (text[index + 1] === '"') { field += '"'; index += 1; } else { quoted = false; } }
      else { field += character; }
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ",") { row.push(field); field = ""; continue; }
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (character === "\r") continue;
    field += character;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? "").trim() !== "");
};
const toRecords = (rows) => {
  const header = rows[0].map((name) => name.trim());
  return rows.slice(1).map((values) => Object.fromEntries(header.map((name, index) => [name, (values[index] ?? "").trim()])));
};

// -------------------------------------------------------------------------------------------------------------
// The taxonomy, PARSED FROM SPEC-006 section 4.1 rather than restated.
// -------------------------------------------------------------------------------------------------------------
const specText = fs.readFileSync(specPath, "utf8");
const taxonomy = specText.split("## 4. Verification status taxonomy")[1] ?? "";
const statusTokens = [...taxonomy.matchAll(/^#### `([A-Z_]+)`$/gm)].map((match) => match[1]);
if (statusTokens.length === 0) throw new Error("no status tokens could be parsed from the SPEC-006 section 4.1 headings");
const COMMON_FIELDS = ["id", "status", "reason", "evidencePath", "updatedAt", "epochId", "nextAction", "blockingDependency"];
const PASS_FIELDS = ["command", "exitCode", "sentinel", "artifactDigest", "evidenceDigest"];

// -------------------------------------------------------------------------------------------------------------
// The validators. Each returns a list of problems; empty means the input survived.
// -------------------------------------------------------------------------------------------------------------
const validateRegistry = (records, casebooks) => {
  const problems = [];
  if (records.length !== 484) problems.push(`the registry holds ${records.length} rows and the pack fixes 484`);
  const ids = records.map((record) => record.test_id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) problems.push("the registry contains duplicated ids");
  if (unique.size !== 484) problems.push(`the registry holds ${unique.size} unique ids`);
  const prefixes = {};
  for (const id of ids) prefixes[id.split("-")[0]] = (prefixes[id.split("-")[0]] ?? 0) + 1;
  for (const [prefix, expected] of Object.entries({ GEN: 122, HIPAA: 125, BC: 202, E2E: 20, SUP: 15 })) {
    if ((prefixes[prefix] ?? 0) !== expected) problems.push(`prefix ${prefix} has ${prefixes[prefix] ?? 0} rows and the pack fixes ${expected}`);
  }
  for (const id of unique) if (!casebooks.has(id)) problems.push(`${id} has no casebook object`);
  return problems;
};

const validateMatrix = (rows, ownerStages) => {
  const problems = [];
  const DECISIONS = new Set(["APPLICABLE_AUTOMATABLE", "APPLICABLE_MANUAL", "SKIPPED_NOT_APPLICABLE", "CONDITIONALLY_APPLICABLE_PENDING_EVIDENCE"]);
  if (rows.length !== 484) problems.push(`the applicability matrix holds ${rows.length} ID row(s) and the pack fixes 484`);
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.test_id)) problems.push(`${row.test_id} appears more than once in the applicability matrix`);
    seen.add(row.test_id);
    if (!DECISIONS.has(row.applicability)) problems.push(`${row.test_id}: ${row.applicability} is not one of the four permitted decisions`);
    if ((row.applicability_evidence ?? "").trim() === "") problems.push(`${row.test_id}: the decision cites no evidence`);
    if ((row.decision_rule_ref ?? "").trim() === "") problems.push(`${row.test_id}: the decision names no rule`);
    if (!/^V-\d{3}$/.test(row.owner_stage ?? "")) problems.push(`${row.test_id}: owner stage ${row.owner_stage} is not a verification stage`);
    if (row.applicability === "SKIPPED_NOT_APPLICABLE" && !/absent|no .* exists|does not exist|measured/i.test(row.applicability_evidence ?? "")) {
      problems.push(`${row.test_id}: SKIPPED_NOT_APPLICABLE without repository evidence of absence`);
    }
    if (ownerStages !== null && !ownerStages.has(row.test_id)) problems.push(`${row.test_id}: the dependency seed assigns no owner`);
  }
  return problems;
};

const validateStatusRow = (row, currentEpoch, currentArtifact, edges) => {
  const problems = [];
  const label = row.id ?? row.test_id ?? "(unnamed)";
  if (!statusTokens.includes(row.status)) problems.push(`${label}: status ${row.status} is not in the SPEC-006 section 4.1 vocabulary`);
  for (const field of COMMON_FIELDS) {
    const value = row[field];
    if (value === undefined) problems.push(`${label}: status row is missing the common field ${field}`);
    else if (field !== "blockingDependency" && String(value).trim() === "") problems.push(`${label}: status row field ${field} is empty`);
  }
  if (row.updatedAt !== undefined && row.updatedAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(String(row.updatedAt))) {
    problems.push(`${label}: updatedAt is not ISO-8601 UTC`);
  }
  if (String(row.status).startsWith("BLOCKED_") && (row.blockingDependency === undefined || row.blockingDependency === null || String(row.blockingDependency).trim() === "")) {
    problems.push(`${label}: ${row.status} without a blocking dependency`);
  }
  if (row.status === "BLOCKED_PREREQUISITE") {
    const dependency = String(row.blockingDependency ?? "");
    // THE ROW NAMES ITS BLOCKING DEPENDENCY; THE GRAPH STORES EDGES. MEASURED: the first version looked the name up
    // in the edge set, so every capability block -- whose edges are written as `capability:x->V-0NN` -- was reported
    // as naming something that is not in the graph, when the graph had an edge FROM exactly that dependency. The
    // check is now that the named dependency is a NODE of the graph, which is what the row is claiming.
    if (!edges.has(dependency)) problems.push(`${label}: BLOCKED_PREREQUISITE names ${dependency}, and the dependency graph has no edge to or from that node`);
  }
  if (row.status === "BLOCKED_ENVIRONMENT" && (row.provisioningAction === undefined || String(row.provisioningAction).trim() === "")) {
    problems.push(`${label}: BLOCKED_ENVIRONMENT without a provisioning action`);
  }
  if (row.status === "PASS") {
    for (const field of PASS_FIELDS) {
      if (row[field] === undefined || row[field] === null || String(row[field]).trim() === "") problems.push(`${label}: PASS without ${field}`);
    }
    if (row.evidenceDigest !== undefined && row.evidenceDigest !== null && !/^[0-9a-f]{64}$/.test(String(row.evidenceDigest))) problems.push(`${label}: evidenceDigest is not a sha256 hex digest`);
    if (row.evidencePath !== undefined && row.evidencePath !== null && String(row.evidencePath).trim() !== "" && !fs.existsSync(path.join(ROOT, String(row.evidencePath)))) {
      problems.push(`${label}: evidence path ${row.evidencePath} does not exist`);
    }
  }
  // STALE-EPOCH EVIDENCE IS NOT EVIDENCE FOR THIS EPOCH: EXECUTION_DAG.md invalidates it.
  if (row.epochId !== undefined && row.epochId !== null && row.epochId !== currentEpoch) problems.push(`${label}: evidence belongs to epoch ${row.epochId} and the current epoch is ${currentEpoch}`);
  if (row.artifactDigest !== undefined && row.artifactDigest !== null && currentArtifact !== null && row.artifactDigest !== currentArtifact) {
    problems.push(`${label}: evidence names artifact ${row.artifactDigest} and the pinned artifact is ${currentArtifact}`);
  }
  return problems;
};

const validateLedger = (rows, currentEpoch, currentArtifact, edges) => {
  const problems = [];
  if (rows.length === 0) return ["the ledger holds no status rows at all, so nothing is accounted"];
  const byStatus = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  // A BLANKET BLOCKER IS NOT AN ACCOUNTING: if one blocking status covers the great majority of rows and those rows
  // carry no per-ID reason, the ledger is a fabricated block rather than a set of measured outcomes.
  for (const [status, count] of Object.entries(byStatus)) {
    if (!status.startsWith("BLOCKED_")) continue;
    if (rows.length >= 100 && count / rows.length > 0.9) {
      const withoutReason = rows.filter((row) => row.status === status && String(row.reason ?? "").trim() === "").length;
      if (withoutReason > 0 || count === rows.length) problems.push(`${count} of ${rows.length} rows are ${status} with no per-ID evidence: a blanket block rather than an accounting`);
    }
  }
  for (const row of rows) problems.push(...validateStatusRow(row, currentEpoch, currentArtifact, edges));
  return problems;
};

// -------------------------------------------------------------------------------------------------------------
// Real inputs.
// -------------------------------------------------------------------------------------------------------------
const registryRecords = toRecords(readCsv(fs.readFileSync(registryPath, "utf8")));
const casebooks = new Set();
for (const file of fs.readdirSync(casebookDir).filter((name) => name.endsWith(".jsonl"))) {
  for (const line of fs.readFileSync(path.join(casebookDir, file), "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try { casebooks.add(JSON.parse(line).test_id); } catch { /* reported by harness-init */ }
  }
}
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
const ownerStages = new Set(seed.ownership_rows.map((row) => row.test_id));
const capabilityEdgeList = (seed.capability_edges ?? []).map((entry) => { const [from, to] = String(entry).split("->"); return { from, to }; });
const edges = new Set([...seed.stage_edges, ...capabilityEdgeList].flatMap((edge) => [edge.from, edge.to]));
const matrixRows = toRecords(readCsv(fs.readFileSync(matrixPath, "utf8")));
const dodRecords = toRecords(readCsv(fs.readFileSync(dodPath, "utf8")));
const ledgerRows = fs.existsSync(ledgerPath)
  ? fs.readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line))
  : [];
const runState = JSON.parse(fs.readFileSync(".agent/verification/state/RUN_STATE.json", "utf8"));
const identity = JSON.parse(fs.readFileSync(".agent/verification/state/ARTIFACT_IDENTITY.json", "utf8"));
const tarball = identity.artifact_paths.find((entry) => entry.endsWith(".tgz"));
const artifactDigest = identity.artifact_digests[tarball];

const problems = [];
problems.push(...validateRegistry(registryRecords, casebooks));
problems.push(...validateMatrix(matrixRows, ownerStages));
if (dodRecords.length !== 42) problems.push(`the DOD registry holds ${dodRecords.length} clauses and the pack fixes 42`);
if (seed.nodes.length !== 22) problems.push(`the dependency seed declares ${seed.nodes.length} stages and the pack fixes 22`);
if (seed.ownership_rows.length !== 484) problems.push(`the dependency seed owns ${seed.ownership_rows.length} ids and the pack fixes 484`);
const matrixLineCount = fs.readFileSync(matrixPath, "utf8").trimEnd().split("\n").length;
if (matrixLineCount !== 485) problems.push(`the applicability matrix has ${matrixLineCount} line(s) and the milestone requires 485`);

const registryIds = new Set(registryRecords.map((record) => record.test_id));
const epochRows = ledgerRows.filter((row) => registryIds.has(row.test_id ?? row.id));
const staleRows = ledgerRows.filter((row) => row.epoch !== undefined && row.epoch !== runState.epoch);
const accounted = new Set(epochRows.map((row) => row.test_id ?? row.id));

// THE REAL ROWS ARE VALIDATED, NOT ONLY THE FIXTURES. Each accounted ID contributes its LATEST row in this epoch
// (the ledger is a history; SPEC-006 section 4.1 requires exactly one status to apply AT ANY TIME), and every such
// row is put through the same schema check the self-tests use.
const latestByid = new Map();
for (const row of ledgerRows) {
  const id = row.test_id ?? row.id;
  if (!registryIds.has(id)) continue;
  const rowEpoch = row.epochId ?? row.epoch;
  if (rowEpoch !== runState.epoch) continue;
  latestByid.set(id, row);
}
for (const [id, row] of latestByid) {
  for (const problem of validateStatusRow(row, runState.epoch, artifactDigest, edges)) problems.push(problem);
}

// -------------------------------------------------------------------------------------------------------------
// THE EIGHT MANDATED REJECTIONS, as self-tests over the same functions.
// -------------------------------------------------------------------------------------------------------------
const selfTests = [];
const expectRejection = (name, problemList) => {
  const rejected = problemList.length > 0;
  selfTests.push({ name, rejected, sample: problemList.slice(0, 2) });
  if (!rejected) problems.push(`self-test ${name} was NOT rejected by the validator, so the validator cannot detect it`);
};
const blank = { id: "GEN-001", evidencePath: "README.md", updatedAt: "2026-09-20T00:00:00Z", epochId: runState.epoch, nextAction: "none", blockingDependency: null };
expectRejection("a fabricated 484-row blanket BLOCKED_CAPABILITY ledger", validateLedger(
  Array.from({ length: 484 }, (_, index) => ({ ...blank, id: `GEN-${String(index + 1).padStart(3, "0")}`, status: "BLOCKED_CAPABILITY", reason: "" })),
  runState.epoch, artifactDigest, edges));
expectRejection("PASS without evidence", validateStatusRow({ ...blank, status: "PASS", reason: "looks fine", command: "sh x.sh", exitCode: "0", sentinel: "x: ok", artifactDigest }, runState.epoch, artifactDigest, edges));
expectRejection("NOT_APPLICABLE without repository evidence", validateMatrix([{ test_id: "GEN-001", applicability: "SKIPPED_NOT_APPLICABLE", applicability_evidence: "assumed absent", applicability_predicate: "conditional", decision_rule_ref: "rule", owner_stage: "V-013" }], null));
expectRejection("zero-test collection", validateLedger([], runState.epoch, artifactDigest, edges));
expectRejection("a missing ID", validateRegistry(registryRecords.slice(0, 483), casebooks));
expectRejection("a duplicated ID", validateRegistry([...registryRecords, registryRecords[0]], casebooks));
expectRejection("stale-epoch evidence", validateStatusRow({ ...blank, status: "PASS", reason: "ran", command: "sh x.sh", exitCode: "0", sentinel: "x: ok", artifactDigest, evidenceDigest: "0".repeat(64), epochId: "FORGE-SPEC-1" }, runState.epoch, artifactDigest, edges));
expectRejection("a prerequisite block without a dependency edge", validateStatusRow({ ...blank, status: "BLOCKED_PREREQUISITE", reason: "waiting", nextAction: "wait", blockingDependency: "NO-SUCH-EDGE" }, runState.epoch, artifactDigest, edges));

const report = {
  epoch: runState.epoch,
  candidate_commit_sha: runState.candidate_sha,
  artifact_digest: artifactDigest,
  registry_sha256: digest(registryPath),
  applicability_matrix_sha256: digest(matrixPath),
  dependency_seed_sha256: digest(seedPath),
  status_vocabulary_size: statusTokens.length,
  status_vocabulary: statusTokens,
  common_status_fields: COMMON_FIELDS,
  counts: {
    registry_rows: registryRecords.length,
    casebook_objects: casebooks.size,
    matrix_rows: matrixRows.length,
    matrix_lines: matrixLineCount,
    stages: seed.nodes.length,
    owned_ids: seed.ownership_rows.length,
    dod_clauses: dodRecords.length,
    ledger_rows: ledgerRows.length,
    ledger_rows_for_registry_ids: epochRows.length,
    stale_epoch_rows: staleRows.length,
    accounted_ids_this_epoch: accounted.size,
    rows_validated_this_epoch: latestByid.size,
  },
  accounting_note:
    "REPORTED, NOT ENFORCED HERE: no per-ID status exists for the current epoch yet, so 484/484 is unreachable and " +
    "sh scripts/harness-accounting.sh is the script that enforces the invariant and reports the unaccounted count. " +
    "The plan states this is the correct behaviour and that it must not be fixed by writing statuses that have not " +
    "been executed.",
  self_tests: selfTests,
  problems,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`harness validation: vocabulary ${statusTokens.length} status token(s) parsed from SPEC-006 section 4.1; registry ${registryRecords.length} rows (sha256 ${report.registry_sha256.slice(0, 16)}); matrix ${matrixRows.length} decisions; DOD ${dodRecords.length} clauses`);
console.log(`harness validation: ledger ${ledgerRows.length} row(s), ${epochRows.length} for a registry id, ${staleRows.length} belonging to an earlier epoch, ${accounted.size}/484 accounted in this epoch`);
for (const test of selfTests) console.log(`harness validation: self-test ${test.rejected ? "rejected as required" : "NOT REJECTED"} - ${test.name}`);
for (const problem of problems) console.log(`harness validation: FAIL - ${problem}`);
if (problems.length > 0) process.exit(1);
ENDS_HARNESS_VALIDATE

node "$VALIDATE" "$REGISTRY" "$CASEBOOKS" "$GRAPH" "$SEED" "$MATRIX" "$SPEC006" "$DOD_REGISTRY" "$TEST_LEDGER" "$REPORT" \
  || fail "the harness validation found problems; see $REPORT"

echo "harness validation: ok"
