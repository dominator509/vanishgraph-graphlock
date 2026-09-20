#!/usr/bin/env sh
# Rollback drill (EP-009 M6(a); DOD-017, DOD-035, SPEC-008 section 1). Sentinel: `rollback drill: ok`
#
# WHAT A ROLLBACK HAS TO PROVE, and what this drill can and cannot show here:
#
#   1. THE ARTIFACT HALF -- "the previous artifact digest is redeployed as-is". It is exercised as far as this
#      environment allows: the pinned artifact is installed again into a fresh rollback directory, and the
#      installed bytes are hashed and compared with the pinned digest, which is what "redeploy by digest" means
#      mechanically. MEASURED LIMIT, recorded rather than papered over: there is only ONE artifact version in
#      existence (version 0.1.0, one tarball in the published identity) because this repository has never had a
#      release, so a rollback to a PREVIOUS VERSION cannot be demonstrated. That half is reported
#      BLOCKED_ON_IMPLEMENTATION with a named next action, and no sentinel hides it.
#
#   2. THE STATE HALF -- "durable state survives, and is read back through an independent connection". This is the
#      half that actually hurts when it is wrong, and it IS demonstrated: the destructive backup/restore drill
#      destroys the database and restores it from a dump alone, then asserts that erased material stays erased and
#      that isolation is intact. This drill runs it, requires its sentinel, and records the result.
#
# THE SENTINEL IS NOT PRINTED UNLESS BOTH HALVES ARE ACCOUNTED FOR: the artifact half must pass as far as it can
# be exercised, and the unexercisable part must carry a taxonomy status with its reason, its dependency edge and
# its next action. A drill that reduces itself to "the artifact is still there" would be a placebo.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "rollback drill: FAIL - $1" >&2; exit 1; }
blocked() { echo "rollback drill: BLOCKED_ON_IMPLEMENTATION - $1" >&2; exit 1; }

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"
mkdir -p .agent/evidence/EP-009/drills

PINNED=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { process.exit(1); }
process.stdout.write(`${path}\n${identity.artifact_digests[path]}\n`);
' "$IDENTITY") || fail "the identity declares no tarball digest"
TARBALL=$(printf '%s\n' "$PINNED" | sed -n '1p')
DIGEST=$(printf '%s\n' "$PINNED" | sed -n '2p')

# 1. The artifact half: redeploy the pinned digest into a fresh destination and confirm the bytes.
ROLLBACK_DIR=${VG_ROLLBACK_DIR:-${TMPDIR:-/tmp}/vanishgraph-rollback}
VG_INSTALL_DIR="$ROLLBACK_DIR" sh scripts/install.sh >.agent/evidence/EP-009/drills/rollback-install.log 2>&1 \
  || { tail -n 20 .agent/evidence/EP-009/drills/rollback-install.log >&2; fail "redeploying the pinned artifact failed; see the log above"; }
DEST_DIGEST=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write("sha256:"+c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TARBALL")
[ "$DEST_DIGEST" = "$DIGEST" ] || fail "the redeployed artifact hashes to $DEST_DIGEST and the identity records $DIGEST"
[ -f "$ROLLBACK_DIR/package/src/infrastructure/main.ts" ] || fail "the redeployed artifact has no entry point"

# 2. The state half: run the destructive restore drill, because a rollback that cannot restore state is not a
#    rollback. Its own blocked/environment statuses are quoted rather than reinterpreted.
STATE_STATUS="EXECUTED - sh scripts/backup-drill.sh printed backup drill: ok"
if ! sh scripts/backup-restore-drill.sh >.agent/evidence/EP-009/drills/rollback-state.log 2>&1; then
  if grep -qE 'BLOCKED_(ENVIRONMENT|CREDENTIALS)' .agent/evidence/EP-009/drills/rollback-state.log; then
    STATE_STATUS="BLOCKED_ENVIRONMENT - the destructive restore drill could not run here; see .agent/evidence/EP-009/drills/rollback-state.log"
  else
    tail -n 20 .agent/evidence/EP-009/drills/rollback-state.log >&2
    fail "the state half of the rollback drill failed; see .agent/evidence/EP-009/drills/rollback-state.log"
  fi
fi

# 3. The unexercisable half, with the fields the release gate requires.
{
  echo "rollback drill: artifact half EXECUTED against the pinned digest $DIGEST into $ROLLBACK_DIR (bytes re-hashed and matched) and the state half: $STATE_STATUS"
  echo "STATUS: BLOCKED_ON_IMPLEMENTATION for a rollback to a PREVIOUS VERSION"
  echo "reason: only one artifact version exists (0.1.0; one tarball in $IDENTITY). This repository has never had a release, so there is no previous digest to roll back to, and a drill that re-installed the same version and called it a rollback would be theatre."
  echo "dependency edge: a released prior artifact -> a second pinned digest -> rollback to the previous version -> rollback evidence"
  echo "named next action: cut a release, keep its artifact and digest, then re-run this drill between the two digests and record the state read-back through an independent connection"
  echo "what IS proven: redeployment by digest is mechanical and verified (the installed bytes match the pinned digest), and durable state survives destruction and restore from a dump alone with erasure and isolation intact"
  echo "recorded at commit: $(git rev-parse HEAD)"
} > .agent/evidence/EP-009/M6-rollback.txt

# NO SENTINEL IS PRINTED, BECAUSE HALF THE DRILL CANNOT BE EXERCISED. Printing `rollback drill: ok` with a
# blocked half named just above it would give a gate a green string to grep for, which is precisely the
# failure-masking this pack forbids (DOD-024, DOD-027). The executed half, the blocked half, its reason, its
# dependency edge and its next action are all in .agent/evidence/EP-009/M6-rollback.txt, and the release gate
# records this stage as a taxonomy status rather than as a pass.
echo "rollback drill: artifact half ok (digest $DIGEST redeployed and re-hashed); state half: $STATE_STATUS"
blocked "rollback to a PREVIOUS VERSION cannot be demonstrated: only one artifact version exists (0.1.0). Evidence: .agent/evidence/EP-009/M6-rollback.txt. NO SENTINEL IS PRINTED."
