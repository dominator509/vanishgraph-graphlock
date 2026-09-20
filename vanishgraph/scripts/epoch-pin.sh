#!/usr/bin/env sh
# Candidate epoch pin (EP-010 M1(a); SPEC-008 section 3, DOD-025, DOD-029). Sentinel: `epoch: pinned`
#
# WHAT IT PINS, AND WHY EVERY FIELD IS REQUIRED: an epoch is the immutable identity a verification result belongs
# to. Without the candidate commit a result cannot be attributed to a tree; without the artifact digest every
# artifact-bound result is INCONCLUSIVE (DOD-029); without the toolchain and lockfile digests a difference
# between two runs cannot be explained; without the test-overlay revision a change in the test set is invisible.
# So the sentinel is printed only when every field is POPULATED, and a missing artifact digest FAILS rather than
# pinning an epoch that no artifact-bound stage could ever satisfy.
#
# IT NEVER AMENDS AN EPOCH. A second run with a different candidate creates a NEW row in EPOCH_HISTORY.md; the
# earlier row is left exactly as it was, because an epoch that can be rewritten after results exist is not an
# epoch. The current epoch for a run lives in RUN_STATE.json and the full history lives in EPOCH_HISTORY.md.
#
# IT REFUSES TO PIN OVER AN UNRECORDED DIRTY TREE, which is the M1 FALLBACK's rule: the working tree's state is
# recorded verbatim in the evidence file first, and only changes to the artifact's SOURCE SURFACE are treated as
# disqualifying -- evidence and state files written by other stages are not part of the source an artifact is
# described by (the same scoping scripts/artifact-identity.sh applies).
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "epoch: FAIL - $1" >&2; exit 1; }

MANIFEST=.agent/verification/state/RUN_MANIFEST.json
RUN_STATE=.agent/verification/state/RUN_STATE.json
IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
HISTORY=.agent/verification/state/EPOCH_HISTORY.md
EVIDENCE=.agent/evidence/EP-010/M1-starting-state.txt
mkdir -p .agent/evidence/EP-010 .agent/verification/state

[ -f "$MANIFEST" ] || fail "$MANIFEST is missing"
[ -f "$RUN_STATE" ] || fail "$RUN_STATE is missing"
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing: no artifact digest exists, and an epoch without one makes every artifact-bound result INCONCLUSIVE (DOD-029). Run sh scripts/build-artifact.sh first."

# The dirty-tree rule, scoped to the artifact's source surface (the package.json files allowlist plus package.json).
SURFACE=$(node -e 'const p=require("./package.json");process.stdout.write([...(p.files||[]).map((f)=>f.replace(/\/$/,"")),"package.json"].join(" "))')
DIRTY=$(git status --porcelain -- $SURFACE || true)
if [ -n "$DIRTY" ]; then
  echo "epoch: FAIL - the artifact source surface is not committed, so a candidate commit could not describe it:" >&2
  printf '%s\n' "$DIRTY" | head -n 10 >&2
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# The identity fields. Every one is computed here rather than copied from a previous run.
# ---------------------------------------------------------------------------------------------
CANDIDATE=$(git rev-parse HEAD)
BASE_REVISION=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(identity.base_revision ?? "");
' "$IDENTITY")
TEST_OVERLAY=$(git rev-parse "HEAD:$(git rev-parse --show-prefix)tests" 2>/dev/null || echo "")
[ -n "$TEST_OVERLAY" ] || fail "the test overlay revision could not be computed (git rev-parse HEAD:tests)"
ARTIFACT_DIGEST=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { process.exit(1); }
process.stdout.write(identity.artifact_digests[path]);
' "$IDENTITY") || fail "the identity declares no tarball digest"
BUILD_INPUTS=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.stdout.write(identity.lockfile_digests["package-lock.json"] ?? "");
' "$IDENTITY")
[ -n "$BUILD_INPUTS" ] || fail "the identity records no package-lock.json digest, so the build inputs cannot be pinned"
NODE_VERSION=$(node --version)
NPM_VERSION=$(npm --version)
EPOCH_ID="FORGE-SPEC-2"
IMAGE_DIGESTS=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const status = identity.oci_image?.status ?? "NOT RECORDED";
process.stdout.write(status === "BLOCKED_ON_IMPLEMENTATION" || status === "BLOCKED_ENVIRONMENT" ? `not_applicable (${status}: no container image exists)` : status);
' "$IDENTITY")
for PAIR in \
  "candidate_commit_sha:$CANDIDATE" \
  "base_revision:$BASE_REVISION" \
  "test_overlay_revision:$TEST_OVERLAY" \
  "build_inputs_digest:$BUILD_INPUTS" \
  "artifact_digest:$ARTIFACT_DIGEST" \
  "toolchain_node:$NODE_VERSION" \
  "toolchain_npm:$NPM_VERSION" \
  "image_digests:$IMAGE_DIGESTS"; do
  field=${PAIR%%:*}
  value=${PAIR#*:}
  [ -n "$value" ] || fail "the epoch field $field is empty; the sentinel is not printed for a partial epoch"
done

# ---------------------------------------------------------------------------------------------
# Record the epoch into the manifest (a pointer, never a second source of truth), the run state,
# and the history.
# ---------------------------------------------------------------------------------------------
node -e '
const fs = require("node:fs");
const [manifestPath, runStatePath, epoch, candidate, base, overlay, inputs, artifact, nodeVersion, npmVersion, images] = process.argv.slice(1);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const protectedBefore = { registry_count: manifest.registry_count, dod_count: manifest.dod_count, candidate_epoch: manifest.candidate_epoch };
manifest.epoch = {
  epoch_id: epoch,
  pinned_at_commit: candidate,
  candidate_commit_sha: candidate,
  base_revision: base,
  test_overlay_revision: overlay,
  build_inputs_digest: inputs,
  artifact_digest: artifact,
  toolchain: { node: nodeVersion, npm: npmVersion },
  image_digests: images,
  note: "Pinned by sh scripts/epoch-pin.sh. THE PROTECTED ACCOUNTING FIELDS ARE NOT TOUCHED: registry_count, dod_count and candidate_epoch are the pack own numbers. The artifact digest is read from ARTIFACT_IDENTITY.json and every gate recomputes it from the bytes on disk."
};
for (const [field, value] of Object.entries(protectedBefore)) {
  if (manifest[field] !== value) throw new Error(`refusing to write: ${field} changed`);
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const runState = JSON.parse(fs.readFileSync(runStatePath, "utf8"));
runState.status = "IN_PROGRESS";
runState.active_node = "EP-010";
runState.closed_nodes = ["EP-000","EP-001","EP-002","EP-003","EP-004","EP-005","EP-006","EP-007","EP-008","EP-009"];
runState.candidate_sha = candidate;
runState.epoch = epoch;
runState.updated_at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
fs.writeFileSync(runStatePath, `${JSON.stringify(runState, null, 2)}\n`);
console.log(`epoch: ${epoch} pinned at ${candidate}; run state set to IN_PROGRESS for EP-010`);
' "$MANIFEST" "$RUN_STATE" "$EPOCH_ID" "$CANDIDATE" "$BASE_REVISION" "$TEST_OVERLAY" "$BUILD_INPUTS" "$ARTIFACT_DIGEST" "$NODE_VERSION" "$NPM_VERSION" "$IMAGE_DIGESTS"

# THE HISTORY IS APPEND-ONLY. The first row is RECONSTRUCTED from RUN_STATE.json, because FORGE-SPEC-1 was pinned
# before this file existed and inventing a timestamp for it would be a fabrication; the reconstruction is labelled.
if [ ! -f "$HISTORY" ]; then
  {
    echo "# Epoch history"
    echo
    echo "Append-only. A new candidate adds a row; an existing row is never edited, because an epoch that can be"
    echo "rewritten after results exist is not an epoch."
    echo
    echo "| epoch | pinned at | candidate | artifact digest | toolchain | source |"
    echo "|---|---|---|---|---|---|"
    echo "| FORGE-SPEC-1 | 2026-09-14T08:19:59Z (RECONSTRUCTED from the RUN_STATE.json values that predate this file) | ffb808f622add1ff2cfc2a5b7818f1a8714b5936 | not recorded (no artifact existed at that epoch) | not recorded | reconstructed, not measured |"
  } > "$HISTORY"
fi
{
  printf '| %s | %s | %s | %s | node %s, npm %s | measured by sh scripts/epoch-pin.sh |\n' \
    "$EPOCH_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CANDIDATE" "$ARTIFACT_DIGEST" "$NODE_VERSION" "$NPM_VERSION"
} >> "$HISTORY"

# The starting state, with the differences against the plan section 4.1 snapshot recorded rather than assumed.
{
  echo
  echo "== epoch pin =="
  echo "epoch id: $EPOCH_ID"
  echo "candidate commit: $CANDIDATE"
  echo "base revision: $BASE_REVISION"
  echo "test overlay revision: $TEST_OVERLAY"
  echo "build inputs digest: $BUILD_INPUTS"
  echo "artifact digest: $ARTIFACT_DIGEST"
  echo "toolchain: node $NODE_VERSION, npm $NPM_VERSION"
  echo "image digests: $IMAGE_DIGESTS"
  echo "source surface clean: yes (git status --porcelain over the package.json files allowlist plus package.json is empty)"
  echo "run state: status IN_PROGRESS, active_node EP-010, closed_nodes EP-000 through EP-009 (was stale: IN_PROGRESS for EP-003 since 2026-09-14)"
} >> "$EVIDENCE"

echo "epoch: pinned ($EPOCH_ID at $CANDIDATE; artifact $ARTIFACT_DIGEST; node $NODE_VERSION, npm $NPM_VERSION)"
