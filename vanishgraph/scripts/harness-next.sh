#!/usr/bin/env sh
# Next stage selector (EP-010 M3(c); VG-SHIP-017/018). Sentinel: `NEXT <V-0NN>` or `ALL_STAGES_ACCOUNTED`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# THE RULES IT OBEYS, AND WHY EACH ONE MATTERS:
#   * IT NEVER SKIPS A STAGE. The stages are examined in declaration order and the first one with an unaccounted
#     owned ID is named, even when a later stage could run independently. Independence is what lets a FAILED stage
#     not halt the others -- the executor runs them in order regardless -- but the SELECTOR never quietly drops a
#     stage, because a dropped stage is a stage whose IDs are never accounted for.
#   * IT NEVER RE-RUNS AN ACCOUNTED STAGE. A stage whose owned IDs all carry a final status in the CURRENT epoch is
#     complete. A stage whose statuses exist only in an EARLIER epoch is NOT complete: EXECUTION_DAG.md invalidates
#     evidence across an epoch change, so the rows are ignored and the stage is selected again.
#   * A STAGE WITH NO OWNED IDS IS COMPLETE, and says so, rather than being treated as unfinished forever.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

MATRIX=.agent/verification/APPLICABILITY_MATRIX.csv
TEST_LEDGER=.agent/verification/state/TEST_LEDGER.jsonl
SPEC006=.agent/specs/SPEC-006-errors.md
GRAPH=.agent/verification/GRAPH.md

for path in "$MATRIX" "$TEST_LEDGER" "$SPEC006" "$GRAPH"; do
  [ -f "$path" ] || { echo "harness next: ERROR - $path is missing" >&2; exit 1; }
done
command -v node >/dev/null 2>&1 || { echo "harness next: ERROR - node is required but not found" >&2; exit 1; }

node -e '
const fs = require("node:fs");
const [matrixPath, ledgerPath, specPath, graphPath] = process.argv.slice(1);
const readCsv = (text) => text.trimEnd().split("\n").map((line) => line.split(","));
const matrixRows = readCsv(fs.readFileSync(matrixPath, "utf8"));
const header = matrixRows[0].map((name) => name.trim().replace(/^\ufeff/, ""));
const ownerIndex = header.indexOf("owner_stage");
const idIndex = header.indexOf("test_id");
if (ownerIndex === -1 || idIndex === -1) { console.error("harness next: ERROR - the matrix has no test_id/owner_stage column"); process.exit(1); }
const ownedByStage = new Map();
for (const row of matrixRows.slice(1)) {
  const owner = (row[ownerIndex] ?? "").trim();
  const id = (row[idIndex] ?? "").trim();
  if (!owner || !id) continue;
  if (!ownedByStage.has(owner)) ownedByStage.set(owner, []);
  ownedByStage.get(owner).push(id);
}
const stages = [...fs.readFileSync(graphPath, "utf8").matchAll(/^STAGE (V-\d{3}) DEPS/gm)].map((match) => match[1]);
if (stages.length === 0) { console.error("harness next: ERROR - GRAPH.md declares no stages"); process.exit(1); }
const runState = JSON.parse(fs.readFileSync(".agent/verification/state/RUN_STATE.json", "utf8"));
const taxonomy = fs.readFileSync(specPath, "utf8").split("## 4. Verification status taxonomy")[1] ?? "";
const STATUSES = new Set([...taxonomy.matchAll(/^#### `([A-Z_]+)`$/gm)].map((match) => match[1]));
const accounted = new Set();
for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const row = JSON.parse(line);
  const rowEpoch = row.epochId ?? row.epoch;
  if (rowEpoch !== runState.epoch) continue;
  if (!STATUSES.has(row.status)) continue;
  accounted.add(row.test_id ?? row.id);
}
for (const stage of stages) {
  const owned = ownedByStage.get(stage) ?? [];
  const pending = owned.filter((id) => !accounted.has(id));
  if (pending.length > 0) {
    console.log(`NEXT ${stage}`);
    process.exit(0);
  }
}
console.log("ALL_STAGES_ACCOUNTED");
' "$MATRIX" "$TEST_LEDGER" "$SPEC006" "$GRAPH" || { echo "harness next: ERROR - the selector failed" >&2; exit 1; }
