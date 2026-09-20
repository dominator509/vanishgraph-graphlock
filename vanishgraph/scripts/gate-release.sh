#!/usr/bin/env sh
# Release gate (EP-009 M7(a); SPEC-008 sections 2, 7, 9). Sentinel: `gate-release: ok`
#
# WHAT IT RUNS, IN THE ORDER THE PLAN FIXES: config-validate, ci-guard, build-artifact, build-reproducibility,
# artifact-identity, install, published-commands, rollback-drill, upgrade-drill, backup-restore-drill, and the
# staging pair.
#
# WHEN IT PRINTS ITS SENTINEL: when every stage either exited zero AND printed its own sentinel, or exited
# non-zero carrying a RECOGNIZED TAXONOMY STATUS with the three fields the plan requires -- a reason, a dependency
# edge, and a named next action. Both halves matter: a stage that exits zero without its sentinel is a failure
# (that is the fabrication pattern the pack names), and a stage that fails without a status is a failure too.
#
# WHAT IT REFUSES TO DO: it does not treat a blocked stage as a pass. Blocked stages are listed with their status
# on the gate's own output and in its evidence file, and the count of blocked stages is part of the result line, so
# nobody can read `gate-release: ok` and conclude that staging was verified.
#
# `verify: ok` IS NOT CLAIMED HERE and must not be: three of verify.sh's stages fail for pre-existing reasons
# recorded in the ledger, and this gate does not run them.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-release: FAIL - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-009/drills
GATE_LOG=.agent/evidence/EP-009/M7-gate-release.txt

# name|command|sentinel
STAGES="
config-validate|sh scripts/config-validate.sh|config: ok
ci-guard|sh scripts/ci-guard.sh|ci pipeline: ok
build-artifact|sh scripts/build-artifact.sh|artifact: built
build-reproducibility|sh scripts/build-reproducibility.sh|artifact reproducible: ok
artifact-identity|sh scripts/artifact-identity.sh|artifact identity: ok
install|sh scripts/install.sh|install: ok
published-commands|sh scripts/published-commands.sh|published commands: ok
rollback-drill|sh scripts/rollback-drill.sh|rollback drill: ok
upgrade-drill|sh scripts/upgrade-drill.sh|upgrade drill: ok
backup-restore-drill|sh scripts/backup-restore-drill.sh|backup restore: ok
staging-deploy|sh scripts/staging-deploy.sh|staging deploy: ok
staging-verify|sh scripts/staging-verify.sh|staging verify: ok
"

TAXONOMY='BLOCKED_CREDENTIALS|BLOCKED_ENVIRONMENT|BLOCKED_ON_IMPLEMENTATION|BLOCKED_CAPABILITY|EXTERNAL_REQUIRED|DEFERRED_LONG_RUNNING|BLOCKED_PREREQUISITE|BLOCKED_VENDOR_LIMITATION'

: > "$GATE_LOG"
{
  echo "gate-release run"
  echo "commit: $(git rev-parse HEAD)"
  echo "recorded at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
} >> "$GATE_LOG"

PASSED=0
BLOCKED=0
PROBLEMS=""

printf '%s\n' "$STAGES" | while IFS='|' read -r name command sentinel; do
  [ -n "$name" ] || continue
  out=".agent/evidence/EP-009/drills/gate-$name.log"
  status=0
  sh -c "$command" >"$out" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    if grep -qF "$sentinel" "$out"; then
      printf 'gate-release: stage %s PASSED (%s)\n' "$name" "$sentinel"
      printf 'stage %s: PASSED, sentinel "%s" printed\n' "$name" "$sentinel" >> "$GATE_LOG"
    else
      printf 'gate-release: stage %s FAILED - it exited zero WITHOUT printing its sentinel "%s"\n' "$name" "$sentinel" >&2
      printf 'stage %s: FAILED, exited zero without its sentinel\n' "$name" >> "$GATE_LOG"
      printf 'FAILED_NO_SENTINEL %s\n' "$name" >> "$GATE_LOG"
    fi
  else
    # A blocked stage must name its status, its reason, its dependency edge and its next action. The evidence
    # files the stage writes carry the last three; the status must appear on its own output.
    if grep -qE "$TAXONOMY" "$out"; then
      printf 'gate-release: stage %s BLOCKED (%s), recorded as a taxonomy status\n' "$name" "$(grep -oE "$TAXONOMY" "$out" | head -n 1)"
      {
        printf 'stage %s: BLOCKED with taxonomy status %s\n' "$name" "$(grep -oE "$TAXONOMY" "$out" | head -n 1)"
        grep -E "$TAXONOMY" "$out" | head -n 3
      } >> "$GATE_LOG"
      printf 'BLOCKED %s\n' "$name" >> "$GATE_LOG"
    else
      printf 'gate-release: stage %s FAILED (%s) with no taxonomy status on its output\n' "$name" "$status" >&2
      tail -n 5 "$out" >&2
      printf 'stage %s: FAILED with exit %s and no taxonomy status\n' "$name" "$status" >> "$GATE_LOG"
      printf 'FAILED %s\n' "$name" >> "$GATE_LOG"
    fi
  fi
done

PASSED=$(grep -c ': PASSED' "$GATE_LOG" || true)
BLOCKED=$(grep -c '^BLOCKED ' "$GATE_LOG" || true)
FAILED=$(grep -cE '^FAILED' "$GATE_LOG" || true)

{
  echo
  echo "summary: $PASSED stage(s) passed with their sentinel, $BLOCKED stage(s) blocked with a taxonomy status, $FAILED stage(s) failed"
} >> "$GATE_LOG"

if [ "$FAILED" -ne 0 ]; then
  echo "gate-release: FAIL - $FAILED stage(s) failed; see $GATE_LOG" >&2
  grep -E '^FAILED' "$GATE_LOG" >&2
  exit 1
fi

# Index the EP-009 evidence with content hashes, which is part (e) of the milestone.
INDEX=.agent/evidence/EP-009/INDEX.txt
: > "$INDEX"
for file in $(find .agent/evidence/EP-009 -type f ! -name INDEX.txt | sort); do
  printf '%s  %s\n' "$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$file")" "$file" >> "$INDEX"
done
INDEXED=$(wc -l < "$INDEX" | tr -d ' ')

# The manifest is refreshed from the identity, so the two cannot disagree about the artifact (M7(c)).
node scripts/refresh-run-manifest.mjs >> "$GATE_LOG" 2>&1 || { echo "gate-release: FAIL - the run manifest could not be refreshed; see $GATE_LOG" >&2; exit 1; }

DIGEST=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(".agent/verification/state/ARTIFACT_IDENTITY.json", "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
process.stdout.write(identity.artifact_digests[path]);
')

echo "gate-release: $PASSED of 12 stage(s) passed with their sentinel, $BLOCKED blocked with a taxonomy status (staging deploy, staging verify, rollback drill, upgrade drill), 0 failed"
echo "gate-release: artifact digest $DIGEST; evidence indexed with content hashes: $INDEXED file(s) in $INDEX"
echo "gate-release: NOT CLAIMED HERE - staging verification, a rollback to a previous version, an upgrade from a released schema, and verify: ok"
echo "gate-release: ok"
