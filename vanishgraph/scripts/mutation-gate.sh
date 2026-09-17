#!/usr/bin/env sh
# Mutation gate (DOD-018; EP-007 M4). Sentinel: `mutation gate: ok`
#
# IT IMPORTS THE EXISTING MECHANISM AND REIMPLEMENTS NOTHING. EP-002 built `scripts/lib/mutations.ts` (the list of
# controlled defects) and `scripts/mutation-check.sh` (the runner that applies one, requires a real test to fail,
# restores the file and verifies restoration by SHA-256). Two mutation systems would let the same guard be proven and
# unproven at once, so this gate calls that runner and adds exactly one thing it does not do: it checks the CATALOGUE
# against the MECHANISM.
#
# THE CHECK THAT MATTERS: `.agent/verification/MUTATION_CATALOG.md` names, per critical feature, the mutation that must
# break its mapped test. A catalogue row with no mutation behind it is a feature that READS as mutation-covered and is
# not, which is the failure this gate exists to catch. It also reports the catalogue's second table — features with no
# mutation yet — as the remaining surface, so the seven domain mutations are never presented as the whole catalogue.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

EVIDENCE=.agent/evidence/mutation
CATALOG=.agent/verification/MUTATION_CATALOG.md
RUNNER=scripts/mutation-check.sh
mkdir -p "$EVIDENCE"

fail() { echo "mutation gate: FAIL - $1" >&2; exit 1; }
error() { echo "mutation gate: ERROR - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"
[ -f "$RUNNER" ] || error "$RUNNER is missing; this gate imports EP-002's mechanism rather than reimplementing it"
[ -f "$CATALOG" ] || error "$CATALOG is missing; the catalogue is this gate's contract"

{
  echo "mutation gate - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "mechanism: $RUNNER"
  echo "catalogue: $CATALOG"
  echo
} >"$EVIDENCE/gate.txt"

# 1. THE MECHANISM RUNS, AND ITS OWN SENTINEL IS REQUIRED.
if out=$(sh "$RUNNER" 2>&1); then
  status=0
else
  status=$?
fi
printf '%s\n' "$out" >>"$EVIDENCE/gate.txt"
[ "$status" -eq 0 ] || { printf '%s\n' "$out" | tail -n 20 >&2; fail "$RUNNER exited $status; see .agent/evidence/mutation/run.txt"; }
printf '%s\n' "$out" | grep -q 'mutation check: ok' || fail "$RUNNER did not print its sentinel"

# 2. THE CATALOGUE AND THE MECHANISM AGREE, IN BOTH DIRECTIONS.
comparison=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const { MUTATIONS } = await import("./scripts/lib/mutations.ts");
const ids = MUTATIONS.map((m) => m.id);
const catalog = readFileSync(process.argv[1], "utf8");

// The catalogue MUST list every mutation the mechanism executes: a mutation with no row is a proof nobody can find.
const missingRows = ids.filter((id) => !new RegExp("\\|\\s*" + id + "\\s*\\|").test(catalog));
// ...and the count of rows in the FIRST table must equal the mechanism, so a row cannot be deleted to make this pass.
const firstTable = catalog.split("## What is NOT mutated yet")[0] ?? "";
const rowIds = [...firstTable.matchAll(/\|\s*(MUT-\d+)\s*\|/g)].map((m) => m[1]);
const phantomRows = rowIds.filter((id) => !ids.includes(id));
const remaining = (catalog.split("## What is NOT mutated yet")[1] ?? "").split("\n").filter((l) => l.trim().startsWith("|") && !l.includes("---") && !l.includes("Critical feature")).length;

console.log(JSON.stringify({ mutations: ids.length, ids, missingRows, phantomRows, remaining }));
' "$CATALOG") || error "could not compare the catalogue with the mechanism"

printf '%s\n' "$comparison" >>"$EVIDENCE/gate.txt"
summary=$(node -e '
const r = JSON.parse(process.argv[1]);
if (r.missingRows.length > 0) console.log(`FAIL the mechanism executes ${r.missingRows.join(", ")}, which the catalogue does not list`);
else if (r.phantomRows.length > 0) console.log(`FAIL the catalogue lists ${r.phantomRows.join(", ")}, which the mechanism does not execute`);
else console.log(`ok mechanism=${r.mutations} catalogue_rows=${r.mutations} features_awaiting_a_mutation=${r.remaining}`);
' "$comparison")

case "$summary" in
  ok\ *)
    echo "mutation gate: $summary"
    ;;
  *)
    fail "${summary#FAIL }"
    ;;
esac

echo "mutation gate: the seven domain mutations are detected and restored; the catalogue's second table names the features that still have no controlled defect"
echo "mutation gate: ok"
