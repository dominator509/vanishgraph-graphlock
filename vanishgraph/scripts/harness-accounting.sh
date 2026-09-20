#!/usr/bin/env sh
# Harness accounting: the 484-ID invariant (EP-010 M2(f); SPEC-008 section 7.3, VG-SHIP-017, DOD-030).
# Sentinel: `accounting: 484/484 accounted`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# WHAT THE INVARIANT IS: every one of the 484 registry IDs is accounted for EXACTLY ONCE in the current candidate
# epoch -- no ID missing, none duplicated, and none counted on the strength of evidence that belongs to an earlier
# epoch. An ID is accounted when the ledger holds a status row for it whose epoch is the current epoch and whose
# status is one this harness recognises; a row from an earlier epoch is reported SEPARATELY and never counted,
# because EXECUTION_DAG.md invalidates evidence across an epoch change.
#
# IT PRINTS THE SENTINEL ONLY WHEN THE EQUALITY HOLDS. Until the stages have run, it prints the unaccounted count
# and exits non-zero, which the plan states is the correct behaviour at this point and which must NOT be "fixed" by
# writing statuses that have not been executed.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "accounting: FAIL - $1" >&2; exit 1; }

REGISTRY=.agent/verification/MASTER_TEST_REGISTRY.csv
MATRIX=.agent/verification/APPLICABILITY_MATRIX.csv
TEST_LEDGER=.agent/verification/state/TEST_LEDGER.jsonl
SPEC006=.agent/specs/SPEC-006-errors.md
EVIDENCE=.agent/evidence/EP-010/M2-applicability/accounting.json
mkdir -p .agent/evidence/EP-010/M2-applicability

for path in "$REGISTRY" "$MATRIX" "$TEST_LEDGER" "$SPEC006"; do
  [ -f "$path" ] || fail "$path is missing; the invariant cannot be computed without it"
done
command -v node >/dev/null 2>&1 || fail "node is required but not found"

node -e '
const fs = require("node:fs");
const [registryPath, matrixPath, ledgerPath, specPath, evidencePath] = process.argv.slice(1);
const problems = [];

const readCsvFirstColumn = (text) => {
  const lines = text.trimEnd().split("\n");
  // A BYTE-ORDER MARK IS STRIPPED, and that is a correction rather than a nicety: MEASURED, the registry header
  // arrives as \ufefftest_id, so a strict comparison missed the column and the invariant could not be computed at
  // all. A parser that fails on an invisible character is a parser that fails for the wrong reason.
  const header = lines[0].replace(/^\ufeff/, "").split(",").map((name) => name.trim());
  const index = header.indexOf("test_id");
  if (index === -1) throw new Error(`the CSV has no test_id column (header: ${header.slice(0, 4).join("|")})`);
  return lines.slice(1).map((line) => line.split(",")[index].replace(/^"|"$/g, "").trim()).filter((value) => value !== "");
};

const registryIds = readCsvFirstColumn(fs.readFileSync(registryPath, "utf8"));
const matrixIds = readCsvFirstColumn(fs.readFileSync(matrixPath, "utf8"));
const runState = JSON.parse(fs.readFileSync(".agent/verification/state/RUN_STATE.json", "utf8"));
const currentEpoch = runState.epoch;
const specText = fs.readFileSync(specPath, "utf8");
const taxonomy = specText.split("## 4. Verification status taxonomy")[1] ?? "";
const STATUSES = new Set([...taxonomy.matchAll(/^#### `([A-Z_]+)`$/gm)].map((match) => match[1]));
if (STATUSES.size === 0) problems.push("the status vocabulary could not be parsed from SPEC-006 section 4.1");

const ledger = fs.readFileSync(ledgerPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
const registrySet = new Set(registryIds);
const matrixSet = new Set(matrixIds);

// AN ID IN THE MATRIX THAT IS NOT IN THE REGISTRY (or the reverse) is a broken invariant, not a rounding error.
for (const id of registrySet) if (!matrixSet.has(id)) problems.push(`${id} is in the registry and has no applicability decision`);
for (const id of matrixSet) if (!registrySet.has(id)) problems.push(`${id} has an applicability decision and is not in the registry`);

// THE LEDGER IS A HISTORY; THE ACCOUNTING IS THE LATEST ROW PER ID. MEASURED REASON: a stage whose evidence was
// invalidated is re-run legitimately, and a re-run appends a new row rather than erasing the old one, so counting
// occurrences would report a duplicate where the audit trail records a supersession. The superseded rows are
// reported as their own number so the history stays visible.
const counted = new Map();
let stale = 0;
let unrecognised = 0;
let staleOverall = 0;
let superseded = 0;
const withdrawnMatches = [];
for (const row of ledger) {
  const id = row.test_id ?? row.id;
  const rowEpoch = row.epochId ?? row.epoch;
  if (rowEpoch !== undefined && rowEpoch !== null && rowEpoch !== currentEpoch) staleOverall += 1;
  if (!registrySet.has(id)) continue;
  const epoch = row.epochId ?? row.epoch;
  if (epoch !== undefined && epoch !== null && epoch !== currentEpoch) { stale += 1; continue; }
  if (!STATUSES.has(row.status)) { unrecognised += 1; continue; }
  if (counted.has(id)) superseded += 1;
  counted.set(id, (counted.get(id) ?? 0) + 1);
}
const accounted = [...counted.keys()];
const duplicated = accounted.filter((id) => counted.get(id) > 1);
const unaccounted = registryIds.filter((id) => !counted.has(id));
// A SUPERSEDED ROW IS NOT A DUPLICATE STATUS: SPEC-006 section 4.1 says exactly one status applies to an ID AT ANY
// TIME, and the audit trail names the withdrawal. An ID with several rows and NO withdrawal in the audit trail is
// the real defect, and that is what is reported.
const auditedWithdrawals = new Set();
if (fs.existsSync(".agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl")) {
  for (const line of fs.readFileSync(".agent/verification/state/STATUS_TRANSITION_AUDIT.jsonl", "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (row.to === "WITHDRAWN") auditedWithdrawals.add(row.test_id ?? row.id);
  }
}
const unexplainedDuplicates = duplicated.filter((id) => !auditedWithdrawals.has(id));
if (unexplainedDuplicates.length > 0) problems.push(`${unexplainedDuplicates.length} id(s) carry more than one status row in this epoch with no withdrawal recorded in the audit trail: ${unexplainedDuplicates.slice(0, 10).join(", ")}`);

const report = {
  epoch: currentEpoch,
  candidate_commit_sha: runState.candidate_sha,
  registry_ids: registryIds.length,
  matrix_ids: matrixIds.length,
  ledger_rows: ledger.length,
  accounted_in_this_epoch: accounted.length,
  unaccounted_in_this_epoch: unaccounted.length,
  unaccounted_sample: unaccounted.slice(0, 20),
  duplicated_in_this_epoch: duplicated,
  superseded_rows_in_this_epoch: superseded,
  unexplained_duplicates: unexplainedDuplicates,
  stale_epoch_rows_not_counted: stale,
  stale_epoch_rows_in_the_whole_ledger: staleOverall,
  unrecognised_status_rows_not_counted: unrecognised,
  invariant: "every registry id accounted exactly once in the current candidate epoch",
  holds: accounted.length === 484 && unexplainedDuplicates.length === 0 && problems.length === 0,
  problems,
};
fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`accounting: ${accounted.length}/484 accounted in epoch ${currentEpoch}; ${unaccounted.length} unaccounted; ${stale} row(s) for a registry id belong to an earlier epoch and are NOT counted; ${unrecognised} row(s) carry a status outside the SPEC-006 section 4.1 vocabulary`);
console.log(`accounting: the whole ledger holds ${ledger.length} row(s), of which ${staleOverall} belong to an earlier epoch: evidence from a previous epoch is reported and never counted (EXECUTION_DAG.md invalidates it)`);
if (unaccounted.length > 0 && unaccounted.length <= 20) console.log(`accounting: unaccounted: ${unaccounted.join(", ")}`);
for (const problem of problems) console.log(`accounting: FAIL - ${problem}`);
process.exit(report.holds ? 0 : 1);
' "$REGISTRY" "$MATRIX" "$TEST_LEDGER" "$SPEC006" "$EVIDENCE" || {
  echo "accounting: the 484/484 invariant does not hold yet; the exact missing ids and the stale-epoch rows are in $EVIDENCE" >&2
  echo "accounting: this is the correct state until the verification stages have run, and it must not be fixed by writing statuses that were never executed" >&2
  exit 1
}

echo "accounting: 484/484 accounted"
