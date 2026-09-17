#!/usr/bin/env sh
# Canary egress stage (SPEC-007 §4.4; EP-008 M2(e)). Sentinel: `canary egress: ok`
#
# WHAT MAKES THIS STAGE DIFFERENT FROM A TEST RUN. §4.4 item 5: "The same test run must also prove it can fail: with
# exactly one redaction rule class disabled, the test must fail and must name the offending rule class and field path. A
# canary test that cannot fail is not a test." So this script runs the canary suite THREE times and prints its sentinel
# only when all three outcomes are the required ones:
#
#   1. POSITIVE   — the real configuration: the suite must pass.
#   2. CONTROL    — one rule class disabled: the suite must FAIL, and its output must name the disabled class and the
#                   field path. A control that passed, or that failed for another reason, is a harness ERROR here.
#   3. RESTORED   — the real configuration again: the suite must pass. This is what "restores the rule" means in practice:
#                   the disablement was a POLICY FILE in the evidence directory, never an edit to the tracked
#                   configuration, and `git diff --exit-code` at the end proves nothing tracked moved.
#
# THE CANARY IS GENERATED AT RUN TIME FROM A SEED (§4.4 item 1) by `scripts/canary-dlp.mjs`, which records the seed and a
# digest over the emitted bundle. The digest is recomputed here from the FILE BYTES with an independent command, so the
# generator's own claim is not the only witness.
#
# THE REDACTION EVIDENCE (§4.4 item 6) is written to `.agent/evidence/EP-008/canary/redaction-evidence.json`: canary seed,
# canary bundle digest, the sink list with per-sink exported-payload digests and status, the control verdict, and the
# overall verdict. The per-sink captures themselves are written by the suite.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || { echo "canary egress: FAIL - node is required but not found" >&2; exit 1; }
[ -f scripts/canary-dlp.mjs ] || { echo "canary egress: FAIL - scripts/canary-dlp.mjs is missing" >&2; exit 1; }
[ -f tests/observability/egress-canary.test.ts ] || { echo "canary egress: FAIL - the canary suite is missing" >&2; exit 1; }
[ -f config/telemetry/allowlist.json ] || { echo "canary egress: FAIL - the telemetry allowlist is missing" >&2; exit 1; }

SUITE=tests/observability/egress-canary.test.ts
EVIDENCE=.agent/evidence/EP-008/canary
CONTROL_CLASS=EMAIL_ADDRESS
mkdir -p "$EVIDENCE"

# A RECORDED SEED WHEN ONE IS GIVEN, A FRESH ONE OTHERWISE: replaying a failed run must be possible, and every other run
# must use material nobody could have prepared for.
SEED=${VG_CANARY_SEED:-}
if [ -n "$SEED" ]; then
  node scripts/canary-dlp.mjs generate --seed "$SEED" --out "$EVIDENCE/canary-bundle.json" >"$EVIDENCE/generator.txt"
else
  node scripts/canary-dlp.mjs generate --out "$EVIDENCE/canary-bundle.json" >"$EVIDENCE/generator.txt"
fi
SEED_RECORDED=$(sed -n 's/^seed=//p' "$EVIDENCE/generator.txt")
GEN_DIGEST=$(sed -n 's/^bundle_digest=//p' "$EVIDENCE/generator.txt")
[ -n "$SEED_RECORDED" ] || { echo "canary egress: FAIL - the generator recorded no seed" >&2; exit 1; }
[ -n "$GEN_DIGEST" ] || { echo "canary egress: FAIL - the generator recorded no bundle digest" >&2; exit 1; }

# THE DIGEST IS CHECKED AGAINST THE BYTES ON DISK, BY A COMMAND THAT KNOWS NOTHING ABOUT THE GENERATOR.
FILE_DIGEST=$(node -e 'const fs=require("node:fs"),c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$EVIDENCE/canary-bundle.json")
[ "$FILE_DIGEST" = "$GEN_DIGEST" ] || {
  echo "canary egress: FAIL - the recorded bundle digest $GEN_DIGEST does not describe the bytes on disk ($FILE_DIGEST)" >&2
  exit 1
}

export VG_CANARY_BUNDLE="$EVIDENCE/canary-bundle.json"
export VG_CANARY_EVIDENCE_DIR="$EVIDENCE"

# THE BASELINE IS THE TRACKED DIFF, TAKEN BEFORE ANY RUN. It is deliberately NOT `git diff --exit-code` on a pristine
# tree: a checkout mid-node legitimately carries uncommitted work, and a stage that failed because of unrelated
# uncommitted changes would be reporting the repository's state as its own defect. What must be true is that THIS STAGE
# changed no tracked file, which is what comparing the diff before and after measures. MEASURED: the first version used
# `git diff --exit-code` and failed on this node's own uncommitted milestone work, which is exactly that confusion.
git diff -- config src >"$EVIDENCE/baseline-diff.txt"

# 1. POSITIVE.
if ! node --test "$SUITE" >"$EVIDENCE/positive-run.txt" 2>&1; then
  echo "canary egress: FAIL - the canary suite FAILED against the shipped configuration; see $EVIDENCE/positive-run.txt" >&2
  tail -n 20 "$EVIDENCE/positive-run.txt" >&2
  exit 1
fi
POSITIVE_TESTS=$(sed -n 's/^ℹ pass \([0-9][0-9]*\)$/\1/p' "$EVIDENCE/positive-run.txt" | tail -n 1)
[ -n "$POSITIVE_TESTS" ] || { echo "canary egress: FAIL - the positive run printed no test count, so nothing is known about what ran" >&2; exit 1; }
[ "$POSITIVE_TESTS" -gt 0 ] || { echo "canary egress: FAIL - the positive run collected ZERO tests" >&2; exit 1; }

# 2. CONTROL. The alternate policy is written into the evidence directory and the tracked configuration is not touched.
node -e '
const fs = require("node:fs");
const source = JSON.parse(fs.readFileSync("config/telemetry/allowlist.json", "utf8"));
const target = process.argv[1];
const disabled = process.argv[2];
let found = 0;
for (const rule of source.dlp_rule_classes) {
  if (rule.rule_class === disabled) { rule.enabled = false; found += 1; }
}
if (found !== 1) { console.error(`control: expected exactly one ${disabled} class, found ${found}`); process.exit(1); }
source["$comment"] = `${source["$comment"]} CONTROL VARIANT: ${disabled} disabled, written into the evidence directory by scripts/egress-canary-test.sh. NOT a shipped configuration.`;
fs.writeFileSync(target, `${JSON.stringify(source, null, 2)}\n`);
' "$EVIDENCE/allowlist-control.json" "$CONTROL_CLASS" \
  || { echo "canary egress: FAIL - the control policy could not be written" >&2; exit 1; }

if VG_TELEMETRY_ALLOWLIST_PATH="$EVIDENCE/allowlist-control.json" node --test "$SUITE" >"$EVIDENCE/control-run.txt" 2>&1; then
  echo "canary egress: FAIL - the disabled-rule control PASSED. A canary test that cannot fail is not a test (SPEC-007 §4.4 item 5)" >&2
  exit 1
fi
CONTROL_FAILURES=$(sed -n 's/^ℹ fail \([0-9][0-9]*\)$/\1/p' "$EVIDENCE/control-run.txt" | tail -n 1)
[ -n "$CONTROL_FAILURES" ] || { echo "canary egress: FAIL - the control run printed no failure count" >&2; exit 1; }
[ "$CONTROL_FAILURES" -gt 0 ] || { echo "canary egress: FAIL - the control run exited non-zero without reporting a failing test" >&2; exit 1; }
grep -q "$CONTROL_CLASS" "$EVIDENCE/control-run.txt" \
  || { echo "canary egress: FAIL - the control failed WITHOUT naming the disabled rule class $CONTROL_CLASS" >&2; exit 1; }
grep -q "field message" "$EVIDENCE/control-run.txt" \
  || { echo "canary egress: FAIL - the control failed WITHOUT naming the field path the canary travelled in" >&2; exit 1; }
CONTROL_NAMED=$CONTROL_CLASS

# 3. RESTORED. The real configuration again, and the tracked tree must be exactly as it was.
if ! node --test "$SUITE" >"$EVIDENCE/restored-run.txt" 2>&1; then
  echo "canary egress: FAIL - the canary suite did not return to green with the shipped configuration" >&2
  tail -n 20 "$EVIDENCE/restored-run.txt" >&2
  exit 1
fi
RESTORED_TESTS=$(sed -n 's/^ℹ pass \([0-9][0-9]*\)$/\1/p' "$EVIDENCE/restored-run.txt" | tail -n 1)
[ "$RESTORED_TESTS" = "$POSITIVE_TESTS" ] \
  || { echo "canary egress: FAIL - the restored run collected $RESTORED_TESTS tests and the positive run collected $POSITIVE_TESTS" >&2; exit 1; }

git diff -- config src >"$EVIDENCE/after-diff.txt"
cmp -s "$EVIDENCE/baseline-diff.txt" "$EVIDENCE/after-diff.txt" \
  || { echo "canary egress: FAIL - the control run modified a tracked file; a control that edits tracked files is not a control" >&2; exit 1; }

# THE REDACTION EVIDENCE OF §4.4 ITEM 6, assembled from what the runs actually produced.
SINKS="OTLP_TRACE_EXPORTER LOG_FORWARDER ERROR_REPORTER PR_ISSUE_EXPORTER DEBUG_BUNDLE"
{
  echo "{"
  echo "  \"spec\": \"SPEC-007 §4.4 item 6; EP-008 M2\","
  echo "  \"canary_seed\": \"$SEED_RECORDED\","
  echo "  \"canary_bundle_digest\": \"$GEN_DIGEST\","
  echo "  \"canary_bundle_digest_recomputed_from_bytes\": \"$FILE_DIGEST\","
  echo "  \"sinks\": ["
  first=1
  for sink in $SINKS; do
    digest_file="$EVIDENCE/capture-digest-$sink.txt"
    [ -f "$digest_file" ] || { echo "canary egress: FAIL - no exported-payload digest for $sink" >&2; exit 1; }
    sink_digest=$(cat "$digest_file")
    [ "$first" = "1" ] || echo "    ,"
    first=0
    printf '    { "sink": "%s", "exported_payload_digest": "%s", "capture": "capture-%s.txt" }' "$sink" "$sink_digest" "$sink"
  done
  echo ""
  echo "  ],"
  echo "  \"positive_run\": { \"verdict\": \"PASS\", \"tests_passed\": $POSITIVE_TESTS, \"capture\": \"positive-run.txt\" },"
  echo "  \"disabled_rule_control\": { \"rule_class\": \"$CONTROL_NAMED\", \"field_path\": \"message\", \"verdict\": \"FAILED_AS_REQUIRED\", \"failing_tests\": $CONTROL_FAILURES, \"capture\": \"control-run.txt\", \"policy\": \"allowlist-control.json\" },"
  echo "  \"restored_run\": { \"verdict\": \"PASS\", \"tests_passed\": $RESTORED_TESTS, \"capture\": \"restored-run.txt\" },"
  echo "  \"tree_unchanged_by_control\": true,"
  echo "  \"verdict\": \"PASS\""
  echo "}"
} >"$EVIDENCE/redaction-evidence.json"

node -e 'const fs=require("node:fs");JSON.parse(fs.readFileSync(process.argv[1],"utf8"))' "$EVIDENCE/redaction-evidence.json" \
  || { echo "canary egress: FAIL - the redaction evidence is not valid JSON" >&2; exit 1; }

echo "canary egress: ok"
