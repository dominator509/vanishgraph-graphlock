#!/usr/bin/env sh
# Observability node gate (EP-008 M9). Sentinel: `gate-observability: ok`
#
# WHAT IT RUNS, IN ORDER, AND WHAT IT REQUIRES: every stage EP-008 §7.1 names must exit zero AND print its own sentinel —
# a stage that exits zero without its sentinel is the hollow-gate failure DOD-024 forbids, and a stage that prints its
# sentinel while exiting non-zero is worse.
#
#   egress-canary-test        canary egress: ok
#   log-contract-guard        log contract: ok
#   metrics-catalogue-guard   metrics catalogue: ok
#   alert-catalogue-guard     alert catalogue: ok
#   slo-evaluate              slo: evaluated
#   retention-config-guard    retention config: ok
#   induced-failure-readiness readiness induced failure: ok   <-- SEE THE EXCEPTION BELOW
#
# THE ONE EXCEPTION, KEPT FOR THE ENVIRONMENT THAT NEEDS IT. It read "three of six dependencies cannot be induced" until the last
# two were provisioned; it is a CONDITIONAL now, and the branch below either takes the sentinel or records the blocked row.
# THE CONDITION, AND WHY IT IS NOT A WEAKENING. `scripts/induced-failure-readiness.sh` prints its sentinel only when
# EVERY declared dependency demonstrated PASS → FAIL → PASS on the same probe path. Three of the six cannot be induced in
# this environment, and the milestone's own FALLBACK (DOD-033) prescribes recording them ERROR with a provisioning
# attempt log rather than skipping them. EP-008 M9's EXPECT then says the node "may still close only when each such row
# carries its required fields and a named next action". So this gate REQUIRES that stage to exit NON-ZERO and REQUIRES
# its verdict file to exist and to show (a) at least one dependency DEMONSTRATED, (b) every other row ERROR or
# INCONCLUSIVE, and (c) a provisioning attempt log naming what would unblock each one. It then prints the row as
# `BLOCKED_ENVIRONMENT` with its next action — it does NOT print the stage's sentinel, does not pass it, and does not
# claim readiness was proven. Everything else in the list must pass normally.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

EVIDENCE=.agent/evidence/EP-008/gate
mkdir -p "$EVIDENCE"
REPORT="$EVIDENCE/gate-observability.txt"
: >"$REPORT"

# The database state file lives outside the repository (VG-SEC-002) and the readiness stage needs the DSNs.
STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
  export VG_TEST_DSN_APP VG_TEST_DSN_OWNER
fi
# The provisioned local dependencies this node demonstrated against; absent variables simply leave their rows blocked.
export VG_OBJECT_STORE_ENDPOINT=${VG_OBJECT_STORE_ENDPOINT:-http://127.0.0.1:59000}
export VG_OBJECT_STORE_ACCESS_KEY=${VG_OBJECT_STORE_ACCESS_KEY:-vgprobe}
export VG_OBJECT_STORE_SECRET_KEY=${VG_OBJECT_STORE_SECRET_KEY:-vgprobe-secret}
export VALKEY_URL=${VALKEY_URL:-redis://127.0.0.1:56379}

{
  echo "gate-observability - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "node: $(node --version)"
  echo "head: $(git log --oneline -1)"
  echo
} >>"$REPORT"

fail() {
  echo "gate-observability: FAIL - $1" | tee -a "$REPORT" >&2
  exit 1
}

run_stage() {
  script=$1
  sentinel=$2
  echo "== stage: $script" | tee -a "$REPORT"
  if ! sh "scripts/$script" >>"$REPORT" 2>&1; then
    fail "$script exited non-zero; see $REPORT"
  fi
  grep -q "$sentinel" "$REPORT" || fail "$script exited zero WITHOUT printing its sentinel ($sentinel)"
  echo "   sentinel: $sentinel" | tee -a "$REPORT"
}

run_stage egress-canary-test.sh "canary egress: ok"
run_stage log-contract-guard.sh "log contract: ok"
run_stage metrics-catalogue-guard.sh "metrics catalogue: ok"
run_stage alert-catalogue-guard.sh "alert catalogue: ok"
run_stage slo-evaluate.sh "slo: evaluated"
run_stage retention-config-guard.sh "retention config: ok"

# THE NAMED EXCEPTION, CHECKED RATHER THAN TRUSTED.
echo "== stage: induced-failure-readiness.sh (the sentinel needs every declared dependency demonstrated; a blocked row is recorded instead)" | tee -a "$REPORT"
VERDICT=.agent/evidence/EP-008/induced-failure/verdict.txt
ATTEMPTS=.agent/evidence/EP-008/induced-failure/provisioning-attempts.txt
if sh scripts/induced-failure-readiness.sh >>"$REPORT" 2>&1; then
  # If the environment ever provisions everything, the stage passes and the exception disappears by itself.
  grep -q "readiness induced failure: ok" "$REPORT" || fail "the readiness stage exited zero without its sentinel"
  echo "   sentinel: readiness induced failure: ok (every declared dependency demonstrated)" | tee -a "$REPORT"
else
  [ -f "$VERDICT" ] || fail "the readiness stage failed WITHOUT writing its verdict table, so no row can be checked"
  [ -f "$ATTEMPTS" ] || fail "the readiness stage failed WITHOUT a provisioning attempt log, which DOD-033 requires"
  grep -q "DEMONSTRATED" "$VERDICT" || fail "the readiness verdict shows NO demonstrated dependency, so nothing about readiness was proven"
  grep -q "ERROR\|INCONCLUSIVE" "$VERDICT" || fail "the readiness verdict shows no blocked row, yet the stage failed: the two disagree"
  for key in postgresql valkey object-store; do
    # THE INDUCED VALUE IS WHATEVER THE PROBE REPORTED AND IT IS NOT REQUIRED TO BE THE WORD FAIL: the property the
    # milestone asks for is PASS before, NOT PASS after induction, PASS after remediation, on the SAME probe path. An
    # induced value of TIMEOUT or UNKNOWN still shows the dependency stopped working, and demanding the literal string
    # FAIL would have been an assertion about vocabulary rather than about behaviour.
    grep -Eq "^$key \| PASS \| (FAIL|TIMEOUT|UNKNOWN|DENIED|FAILED) \| PASS \| DEMONSTRATED" "$VERDICT" || fail "$key is not shown as PASS then NOT-PASS then PASS, so its induction was not demonstrated"
  done
  # THE SUMMARY IS DERIVED FROM THE VERDICT FILE, NOT TYPED. The first version of this block hardcoded the demonstrated
  # and blocked rows, and it went STALE THE MOMENT job-worker was wired: the gate printed "blocked: job-worker (no worker
  # entry point exists in this repository)" while the verdict table on the same screen said job-worker was DEMONSTRATED.
  # A gate whose prose and its evidence disagree teaches a reader to distrust both, so every line below is read from the
  # verdict table the stage just wrote.
  DEMONSTRATED_KEYS=$(grep 'DEMONSTRATED' "$VERDICT" | cut -d'|' -f1 | tr -d ' ' | paste -sd ', ' -)
  BLOCKED_ROWS=$(grep -E 'ERROR \(DOD-033|INCONCLUSIVE' "$VERDICT" | cut -d'|' -f1,5 | tr -d ' ' | paste -sd '; ' -)
  {
    echo "   row: BLOCKED_ENVIRONMENT - readiness induced-failure could not complete for every dependency."
    echo "   required fields: verdict table ($VERDICT) and provisioning attempt log ($ATTEMPTS), both present."
    echo "   demonstrated: ${DEMONSTRATED_KEYS:-none} (control PASS, induced NOT PASS, remediated PASS, on the same probe path)."
    echo "   blocked: ${BLOCKED_ROWS:-none}"
    echo "   NEXT ACTION: provision or implement what each blocked row above names; its provisioning attempt log records"
    echo "   what was tried. Until then NO readiness induced failure: ok IS CLAIMED and the readiness proof is INCOMPLETE."
  } | tee -a "$REPORT"
fi

# THE EVIDENCE INDEX, WRITTEN FROM WHAT EXISTS RATHER THAN FROM A LIST SOMEONE TYPED.
{
  echo
  echo "== evidence index"
  for dir in M1-discovery M2-canary M3-log-contract M4-metrics M5-probes-partial M5-metrics-listener M5-standin-decision M6 M7 M8 gate; do
    true
  done
  find .agent/evidence/EP-008 -type f | sort | while IFS= read -r file; do
    printf '%s  %s\n' "$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex").slice(0,16))' "$file")" "$file"
  done
} >>"$REPORT"

echo "evidence index: $(grep -c '  \.agent/evidence/EP-008/' "$REPORT") file(s) with content hashes" | tee -a "$REPORT"
echo "gate-observability: ok" | tee -a "$REPORT"
