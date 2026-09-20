#!/usr/bin/env sh
# Artifact-bound live-fire for the twelve core outcomes (EP-010 M5(b); SPEC-008 section 7, DOD-012/013/024).
# Sentinel: `live-fire: ok`
#
# REPLACES THE PRE-DISCOVERY LOUD-FAIL PLACEHOLDER, which refused to print a sentinel while no live-fire existed.
#
# WHAT IT RUNS: the twelve outcome suites `tests/regression/live-fire-proof-01..12.test.ts`, each of which asserts
# its outcome's rule AND a required negative case at the layer the outcome lives in, against the PINNED ARTIFACT
# identity of this epoch. It refuses without a declared digest that matches the published identity, because a
# live-fire run that does not name the digest it tested cannot be bound to an artifact (DOD-004).
#
# WHY THE SENTINEL IS NOT PRINTED HERE, AND WHAT THAT MEANS: SPEC-008 section 7 requires live-fire to prove "each
# core outcome end-to-end through its real entry point against real dependencies". Two of the twelve cannot be
# proven in this environment at all -- `LIVE-FIRE-PROOF-08` (provider subscription transport) and
# `LIVE-FIRE-PROOF-12` (enterprise authorization) are externally constrained -- and the other ten are asserted by
# their suites at the DOMAIN AND CONTRACT layer, with the durable write, the independent read-back, the worker
# effect and the restart half of each outcome recorded `NOT_PROVEN` in
# .agent/verification/FUNCTIONAL_PROOF_MATRIX.csv. A green unit-level run is therefore NOT live-fire, and printing
# the sentinel over it would be the fabricated success DOD-024 and DOD-027 forbid. So this script:
#   * EXECUTES every outcome suite and preserves its output, exit code, test count and evidence digest;
#   * records each outcome's status with the fields its status requires -- `PARTIAL` for the ten whose rule is
#     asserted but whose end-to-end half is not proven, `EXTERNAL_REQUIRED` for the two that need a named external
#     participant, with `externalPartyRole` and the prepared request;
#   * prints a per-outcome line for all twelve, and `live-fire: ok` ONLY when all twelve genuinely proved their
#     rule end to end through the real entry point;
#   * exits non-zero with the precise statuses when it cannot claim that, which is the outcome the milestone's
#     EXPECT allows.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "live-fire: FAIL - $1" >&2; exit 1; }

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
PROOF_MATRIX=.agent/verification/FUNCTIONAL_PROOF_MATRIX.csv
OUTDIR=.agent/evidence/EP-010/V-020/live-fire
mkdir -p "$OUTDIR"

[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"
command -v node >/dev/null 2>&1 || fail "node is required but not found"

PINNED=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { process.exit(1); }
process.stdout.write(`${path}\n${identity.artifact_digests[path]}`);
' "$IDENTITY") || fail "the identity declares no tarball digest"
ARTIFACT=$(printf '%s\n' "$PINNED" | sed -n '1p')
DIGEST=$(printf '%s\n' "$PINNED" | sed -n '2p')
[ -f "$ARTIFACT" ] || fail "the pinned artifact $ARTIFACT is not present"

DECLARED=${VG_ARTIFACT_DIGEST:-}
[ -n "$DECLARED" ] || fail "VG_ARTIFACT_DIGEST is not declared: live-fire tests a DIGEST, and a run that does not name it is not artifact-bound (DOD-004)"
[ "$DECLARED" = "$DIGEST" ] || fail "the declared digest $DECLARED is not the published digest $DIGEST"
ACTUAL=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write("sha256:"+c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$ARTIFACT")
[ "$ACTUAL" = "$DIGEST" ] || fail "the bytes at $ARTIFACT hash to $ACTUAL and the identity records $DIGEST"

EXTERNAL_08_ROLE="Provider relationship owner (the account holder for the official provider transport)"
EXTERNAL_12_ROLE="Authorised enterprise administrator plus qualified counsel for the enterprise authorization path"

FAILED=0
EXTERNAL=0
PARTIAL=0
for N in 01 02 03 04 05 06 07 08 09 10 11 12; do
  SUITE="tests/regression/live-fire-proof-$N.test.ts"
  LOG="$OUTDIR/live-fire-proof-$N.log"
  if [ ! -f "$SUITE" ]; then
    printf 'live-fire: LIVE-FIRE-PROOF-%s FAIL - the suite %s does not exist, so the outcome was not executed\n' "$N" "$SUITE" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  STATUSCODE=0
  node --test "$SUITE" >"$LOG" 2>&1 || STATUSCODE=$?
  TESTS=$(sed -n 's/^ℹ tests \([0-9][0-9]*\)$/\1/p' "$LOG" | tail -n 1)
  FAILS=$(sed -n 's/^ℹ fail \([0-9][0-9]*\)$/\1/p' "$LOG" | tail -n 1)
  SKIPS=$(sed -n 's/^ℹ skipped \([0-9][0-9]*\)$/\1/p' "$LOG" | tail -n 1)
  DIGEST_LOG=$(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$LOG")
  if [ "$STATUSCODE" -ne 0 ]; then
    printf 'live-fire: LIVE-FIRE-PROOF-%s FAIL - the suite exited %s with %s failing test(s); evidence %s (sha256 %s)\n' "$N" "$STATUSCODE" "${FAILS:-unknown}" "$LOG" "$DIGEST_LOG" >&2
    FAILED=$((FAILED + 1))
    continue
  fi
  if [ "$N" = "08" ] || [ "$N" = "12" ]; then
    ROLE=$EXTERNAL_08_ROLE
    [ "$N" = "12" ] && ROLE=$EXTERNAL_12_ROLE
    {
      printf 'LIVE-FIRE-PROOF-%s EXTERNAL_REQUIRED\n' "$N"
      printf 'externalPartyRole: %s\n' "$ROLE"
      printf 'requestedArtifactDigest: %s\n' "$DIGEST"
      printf 'requestEvidencePath: %s\n' "$LOG"
      printf 'requestedAt: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'ownerContactRef: PREFLIGHT.md provider rows and LEGAL_REVIEW_REQUIRED.md\n'
      printf 'suite: %s (%s test(s), %s skipped)\n' "$SUITE" "${TESTS:-?}" "${SKIPS:-0}"
      printf 'preparedRequest: execute the outcome end to end against the real provider transport (08) or the enterprise authorization path (12) under the named participant, and sign the result\n'
      printf 'sentinelRecorded: none - an external gate is never signed by an agent (DOD-039)\n'
    } > "$OUTDIR/live-fire-proof-$N.status"
    printf 'live-fire: LIVE-FIRE-PROOF-%s EXTERNAL_REQUIRED - %s (suite %s: %s test(s), exit 0; evidence %s)\n' "$N" "$ROLE" "$SUITE" "${TESTS:-?}" "$LOG"
    EXTERNAL=$((EXTERNAL + 1))
    continue
  fi
  # A GREEN SUITE IS NOT LIVE-FIRE. The rule and its negative case are asserted at the domain/contract layer; the
  # durable write, the independent read-back, the worker effect and the restart half live in the proof matrix.
  {
    printf 'LIVE-FIRE-PROOF-%s PARTIAL\n' "$N"
    printf 'whatRan: node --test %s (%s test(s), %s fail, %s skipped, exit 0)\n' "$SUITE" "${TESTS:-?}" "${FAILS:-0}" "${SKIPS:-0}"
    printf 'whatIsProven: the outcome rule and its required negative case, at the layer the suite asserts them\n'
    printf 'whatIsNotProven: the end-to-end half through the real entry point against real dependencies - see the NOT_PROVEN columns for this outcome in %s\n' "$PROOF_MATRIX"
    printf 'artifactDigest: %s\n' "$DIGEST"
    printf 'evidencePath: %s\n' "$LOG"
    printf 'evidenceDigest: sha256:%s\n' "$DIGEST_LOG"
    printf 'nextAction: run this outcome end to end against the deployed artifact digest with runtime-generated canaries and an independent read-back, then record PASS\n'
  } > "$OUTDIR/live-fire-proof-$N.status"
  printf 'live-fire: LIVE-FIRE-PROOF-%s PARTIAL - suite %s exited 0 with %s test(s); the end-to-end half is NOT proven (evidence %s)\n' "$N" "$SUITE" "${TESTS:-?}" "$LOG"
  PARTIAL=$((PARTIAL + 1))
done

{
  echo "live-fire run"
  echo "artifact: $ARTIFACT"
  echo "artifact digest: $DIGEST (declared and re-hashed before running)"
  echo "outcomes: 12"
  echo "external_required: $EXTERNAL"
  echo "partial: $PARTIAL"
  echo "failed: $FAILED"
  echo "sentinel_printed: no"
  echo "reason: SPEC-008 section 7 requires each outcome end to end through its real entry point against real dependencies; $EXTERNAL outcome(s) need a named external participant and $PARTIAL prove their rule at the domain/contract layer only"
  echo "recorded at commit: $(git rev-parse HEAD)"
} > "$OUTDIR/live-fire-summary.txt"

if [ "$FAILED" -ne 0 ]; then
  echo "live-fire: FAIL - $FAILED outcome suite(s) failed; see $OUTDIR" >&2
  exit 1
fi

echo "live-fire: 0 of 12 outcomes proved their rule end to end; $EXTERNAL EXTERNAL_REQUIRED, $PARTIAL PARTIAL; evidence $OUTDIR"
echo "live-fire: NOT CLAIMED - the sentinel is not printed, because no outcome was proven end to end through the real entry point against real dependencies" >&2
exit 1
