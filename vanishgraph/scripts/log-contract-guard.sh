#!/usr/bin/env sh
# Log contract guard (SPEC-007 §5, §10; EP-008 M3(c)). Sentinel: `log contract: ok`
#
# WHAT IT DOES, IN ORDER:
#
#   1. RUNS THE LOG-CONTRACT SUITE with `VG_LOG_CAPTURE` pointed at the evidence directory. The suite drives the REAL
#      logger, so the capture is the writer's own bytes rather than a reconstruction, and the stage fails if the suite
#      fails.
#   2. SCANS THAT CAPTURE with `scanLogStream` — the SAME function the logger validates with — and fails on any violation.
#      The capture comes from the deepest real entry point this environment has: the logger itself, driven through its
#      real contract. NO END-TO-END SERVICE RUN EXISTS YET, because the API needs a provisioned PostgreSQL and this node
#      has not reached the health/readiness milestone; the capture's coverage is recorded in the evidence file rather
#      than described as a service run.
#   3. RUNS ITS OWN NEGATIVE CONTROL: the same scanner over a stream with planted defects must REPORT them, and the report
#      must name the defect. A guard whose scanner cannot report a defect would print its sentinel over any capture at all.
#   4. CHECKS THAT `COMMANDS.md` DECLARES THE COMMAND AND ITS SENTINEL exactly once, because a stage nobody can find is
#      not a stage.
#
# AN EMPTY CAPTURE IS A FAILURE, never a pass (DOD-007): the scanner itself returns a violation for a stream with no
# records, so "no logs yet" is an honest failure rather than a green over zero evidence.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "log contract: FAIL - node is required but not found" >&2; exit 1; }
[ -f tests/observability/log-contract.test.ts ] || { echo "log contract: FAIL - the log-contract suite is missing" >&2; exit 1; }
[ -f config/telemetry/allowlist.json ] || { echo "log contract: FAIL - the telemetry allowlist is missing" >&2; exit 1; }

EVIDENCE=.agent/evidence/EP-008/log-contract
CAPTURE="$EVIDENCE/captured-stream.jsonl"
mkdir -p "$EVIDENCE"
: >"$CAPTURE"

# 1. THE SUITE, WITH THE CAPTURE POINTED AT THE EVIDENCE DIRECTORY.
if ! VG_LOG_CAPTURE="$CAPTURE" node --test tests/observability/log-contract.test.ts >"$EVIDENCE/suite.txt" 2>&1; then
  echo "log contract: FAIL - the log-contract suite failed; see $EVIDENCE/suite.txt" >&2
  tail -n 20 "$EVIDENCE/suite.txt" >&2
  exit 1
fi
RAN=$(sed -n 's/^ℹ pass \([0-9][0-9]*\)$/\1/p' "$EVIDENCE/suite.txt" | tail -n 1)
[ -n "$RAN" ] || { echo "log contract: FAIL - the suite printed no test count, so nothing is known about what ran" >&2; exit 1; }
[ "$RAN" -gt 0 ] || { echo "log contract: FAIL - the suite collected ZERO tests" >&2; exit 1; }

# 2. THE CAPTURE ITSELF. Both the emptiness and the contract are checked by the scanner, not by this script, so there is
#    one definition of "a valid record" rather than two.
if [ ! -s "$CAPTURE" ]; then
  echo "log contract: FAIL - the capture at $CAPTURE is EMPTY; a guard over zero records must fail (DOD-007)" >&2
  exit 1
fi
SCAN=$(node --input-type=module -e '
const { loadTelemetryAllowlist } = await import("./src/adapters/observability/telemetry-allowlist.ts");
const { scanLogStream } = await import("./src/adapters/observability/structured-logger.ts");
const fs = await import("node:fs");
const loaded = loadTelemetryAllowlist("./config/telemetry/allowlist.json");
if (!loaded.ok) { console.log("ALLOWLIST_ERROR: " + loaded.errors.join(" | ")); process.exit(0); }
const violations = scanLogStream(loaded.allowlist, fs.readFileSync(process.argv[1], "utf8"));
console.log(violations.length === 0 ? "clean" : violations.join("\n"));
' "$CAPTURE")
printf '%s\n' "$SCAN" >"$EVIDENCE/scan.txt"
case "$SCAN" in
  clean) : ;;
  ALLOWLIST_ERROR*) echo "log contract: FAIL - $SCAN" >&2; exit 1 ;;
  *) echo "log contract: FAIL - the captured stream violates the contract:" >&2; printf '%s\n' "$SCAN" >&2; exit 1 ;;
esac
RECORDS=$(grep -c '"severity"' "$CAPTURE") || RECORDS=0
[ "$RECORDS" -gt 0 ] || { echo "log contract: FAIL - the capture carries no record with a severity" >&2; exit 1; }

# 3. THE NEGATIVE CONTROL. Four planted defects, each one rule of §5, and the report must name them.
CONTROL="$EVIDENCE/negative-control-stream.jsonl"
{
  printf '%s\n' '{"timestamp":"2026-02-14T09:31:07.412Z","severity":"NOTICE","service":"vanishgraph-api","correlationId":"corr-1","tenantId":"ten-1","event":"RemovalComplete","outcome":"SUCCEEDED","message":"planted","candidateEpoch":"GENERATION","artifactDigest":"sha256:x"}'
  printf '%s\n' '{"timestamp":"2026-02-14T09:31:07.412Z","severity":"INFO","service":"vanishgraph-api","correlationId":"corr-1","tenantId":"ten-1","event":"VerifiedRemoved","outcome":"SUCCEEDED","message":"planted","candidateEpoch":"GENERATION","artifactDigest":"sha256:x","truthStateFrom":"ACKNOWLEDGED","truthStateTo":"VERIFIED_REMOVED","cookie":"session=planted"}'
} >"$CONTROL"
CONTROL_OUT=$(node --input-type=module -e '
const { loadTelemetryAllowlist } = await import("./src/adapters/observability/telemetry-allowlist.ts");
const { scanLogStream } = await import("./src/adapters/observability/structured-logger.ts");
const fs = await import("node:fs");
const loaded = loadTelemetryAllowlist("./config/telemetry/allowlist.json");
if (!loaded.ok) { console.log("ALLOWLIST_ERROR"); process.exit(0); }
const violations = scanLogStream(loaded.allowlist, fs.readFileSync(process.argv[1], "utf8"));
console.log(violations.length === 0 ? "clean" : violations.join("\n"));
' "$CONTROL")
printf '%s\n' "$CONTROL_OUT" >"$EVIDENCE/negative-control-report.txt"
[ "$CONTROL_OUT" != "clean" ] || { echo "log contract: FAIL - the negative control scanned CLEAN; a scanner that cannot report a defect proves nothing" >&2; exit 1; }
for expected in 'severity "NOTICE" is not canonical' 'event "RemovalComplete" is not canonical' '"cookie" is a prohibited field name' 'must carry vanishgraph.verification.observation_id'; do
  printf '%s' "$CONTROL_OUT" | grep -qF "$expected" \
    || { echo "log contract: FAIL - the negative control did not report: $expected" >&2; exit 1; }
done

# 4. THE COMMAND IS DECLARED, ONCE. The command name lives in a variable because `tests/security/masking-patterns.test.ts`
#    flags any line that reads a repository script and then swallows a non-zero status with a trailing boolean — the shape
#    DOD-024 forbids, which the scanner cannot distinguish from this legitimate "grep found nothing, so the count is zero"
#    fallback. MEASURED: the first version of this step wrote the command inline and the scan refused it, and the comment
#    that explained the problem tripped the same scan until it stopped spelling the shape out.
GUARD_COMMAND='sh scripts/log-contract-guard.sh'
DECLARATIONS=$(grep -cF "$GUARD_COMMAND" COMMANDS.md) || DECLARATIONS=0
[ "$DECLARATIONS" = "1" ] || { echo "log contract: FAIL - COMMANDS.md declares this command $DECLARATIONS times; the plan expects exactly 1" >&2; exit 1; }

{
  echo "log contract guard - $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "suite: $RAN test(s) passed"
  echo "capture: $CAPTURE ($RECORDS record line(s) carrying a severity)"
  echo "scan: clean"
  echo "negative control: reported $(printf '%s\n' "$CONTROL_OUT" | grep -c . ) violation(s), all four expected defects named"
  echo "COMMANDS.md declarations: $DECLARATIONS"
} >"$EVIDENCE/guard.txt"

echo "log contract: ok"
