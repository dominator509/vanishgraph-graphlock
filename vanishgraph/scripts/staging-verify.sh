#!/usr/bin/env sh
# Staging verification of the pinned artifact digest (EP-009 M4(b); SPEC-008 section 7, DOD-012).
# Sentinel: `staging verify: ok`
#
# WHAT IT WOULD DO, AND WHY IT CANNOT DO IT HERE: it runs the artifact-bound smoke suite and the artifact-bound E2E
# suite against the digest that sh scripts/staging-deploy.sh deployed, asserts the health surface SPEC-007 section
# 7.1 declares, and performs one independent read-back through a second connection or client (DOD-012).
#
# IT CANNOT RUN BECAUSE THERE IS NOTHING DEPLOYED TO VERIFY: staging is NOT_PROVISIONED, so no digest was deployed
# and no endpoint exists. This script therefore REFUSES rather than verifying something else -- verifying a
# local process and calling it staging is the substitution SPEC-008 section 7 forbids, and the plan's FALLBACK
# path is a separate, laballed clean-local run.
#
# IT ALSO REFUSES TO PRETEND THE ARTIFACT BOUND SUITES WOULD PASS: the clean-local artifact-bound smoke was run
# (sh scripts/smoke-test.sh) and it does NOT pass, because the running artifact's health surface does not match
# the contract SPEC-003 section 5.17 and SPEC-007 section 7.1 declare. That finding is recorded in
# .agent/evidence/EP-009/M4-artifact-smoke.txt with the exact divergences, and a staging row that claimed
# verification while the same suite fails locally would be a fabricated pass.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "staging verify: FAIL - $1" >&2; exit 1; }
blocked() { echo "staging verify: BLOCKED_CREDENTIALS - $1" >&2; exit 1; }

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
MANIFEST=.agent/verification/TEST_ENVIRONMENT_MANIFEST.md
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"
[ -f "$MANIFEST" ] || fail "$MANIFEST is missing; the staging target is undeclared"

PINNED=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { process.exit(1); }
process.stdout.write(identity.artifact_digests[path]);
' "$IDENTITY") || fail "the identity declares no tarball digest"

# A staging endpoint is required and is NOT defaulted: a default would point verification at something that is not
# staging, which is the substitution this script exists to refuse.
ENDPOINT=${VG_STAGING_ENDPOINT:-}
if [ -z "$ENDPOINT" ]; then
  mkdir -p .agent/evidence/EP-009
  {
    echo "staging verify: BLOCKED_CREDENTIALS"
    echo "pinned digest: $PINNED"
    echo "why: staging is NOT_PROVISIONED in $MANIFEST and VG_STAGING_ENDPOINT is undeclared, so there is no deployed digest to verify"
    echo "probe command: sh scripts/probes/cloud_identity.sh"
    echo "probe exit code: $(sh scripts/probes/cloud_identity.sh >/dev/null 2>&1 || echo $?)"
    echo "what would run against a provisioned staging: sh scripts/smoke-test.sh and sh scripts/test-e2e.sh with VG_ARTIFACT_DIGEST=$PINNED, plus one independent read-back through a second client (DOD-012)"
    echo "OPEN FINDING that also blocks a green staging verify: the clean-local artifact-bound smoke does NOT pass. See .agent/evidence/EP-009/M4-artifact-smoke.txt: the running artifact answers /v1/health with a status field where SPEC-003 section 5.17.1 requires dependencyState, reports three checks named postgres, valkey and keycloak where the contract names postgresql, valkey, job-worker, object-store, keycloak-jwks and provider-transport, and /v1/live and /v1/startup do not carry the declared dependencyState vocabulary at all."
    echo "named next action: fix the health surface to the declared contract, then provision staging and re-run the pair against the same pinned digest"
    echo "recorded at commit: $(git rev-parse HEAD)"
  } > .agent/evidence/EP-009/M4-staging-verify.txt
  blocked "staging is NOT_PROVISIONED in $MANIFEST and VG_STAGING_ENDPOINT is undeclared, so no deployed digest exists to verify. Evidence: .agent/evidence/EP-009/M4-staging-verify.txt. THIS SCRIPT DID NOT VERIFY A LOCAL PROCESS AND DID NOT PRINT ITS SENTINEL."
fi

# A provisioned staging path would verify here. It is written but NOT exercised in this environment, and it says so
# rather than being described as tested: the digest is declared to the suites, and a mismatch is a stop condition.
export VG_ARTIFACT_DIGEST="$PINNED"
echo "staging verify: staging endpoint declared as $ENDPOINT (path present but never exercised in this environment)"
sh scripts/smoke-test.sh || fail "the artifact-bound smoke suite failed against the deployed digest"
sh scripts/test-e2e.sh || fail "the artifact-bound E2E suite failed against the deployed digest"
echo "staging verify: ok"
