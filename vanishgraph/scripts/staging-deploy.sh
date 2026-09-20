#!/usr/bin/env sh
# Staging deployment of the pinned artifact digest (EP-009 M4(a); SPEC-008 section 7).
# Sentinel: `staging deploy: ok`
#
# WHAT IT WOULD DO, AND WHY IT DOES NOT DO IT HERE: it deploys the digest recorded in
# .agent/verification/state/ARTIFACT_IDENTITY.json to the staging environment declared in
# .agent/verification/TEST_ENVIRONMENT_MANIFEST.md, reads the digest back from the running system, and prints its
# sentinel only when the two agree. MEASURED: that manifest declares staging as a managed US cloud in a separate
# account requiring Kubernetes, KMS, object store, managed Postgres and a browser pool, with state
# NOT_PROVISIONED, and no staging host, credential or endpoint is reachable from this environment. The declared
# probe is run and its exit code recorded.
#
# IT NEVER FALLS BACK TO A LOCAL DEPLOYMENT, and it never deploys a source tree. The fallback the plan allows --
# running the artifact-bound suites against clean-local -- is a DIFFERENT, LABELLED run performed by
# sh scripts/smoke-test.sh and sh scripts/test-e2e.sh with their own environment fingerprint; calling that
# "staging" is exactly the substitution SPEC-008 section 7 forbids.
#
# A BLOCKED STAGING DEPLOYMENT IS A RECORDED STATUS, NOT A PASS AND NOT A FAILURE: the milestone records the
# taxonomy status with its required fields, a dependency edge and a named next action, which is what
# scripts/gate-release.sh requires of a stage that could not execute.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "staging deploy: FAIL - $1" >&2; exit 1; }
blocked() { echo "staging deploy: BLOCKED_CREDENTIALS - $1" >&2; exit 1; }

IDENTITY=.agent/verification/state/ARTIFACT_IDENTITY.json
MANIFEST=.agent/verification/TEST_ENVIRONMENT_MANIFEST.md
[ -f "$IDENTITY" ] || fail "$IDENTITY is missing; run sh scripts/build-artifact.sh first"
[ -f "$MANIFEST" ] || fail "$MANIFEST is missing; the staging target is undeclared"

# 1. The pinned digest, and the artifact it describes must be the artifact we would ship.
DIGEST=$(node -e '
const fs = require("node:fs");
const identity = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = identity.artifact_paths.find((p) => p.endsWith(".tgz"));
if (path === undefined) { console.error("the identity declares no tarball"); process.exit(1); }
process.stdout.write(`${path}\n${identity.artifact_digests[path]}\n`);
' "$IDENTITY") || fail "the identity could not be read"
TARBALL=$(printf '%s\n' "$DIGEST" | sed -n '1p')
PINNED=$(printf '%s\n' "$DIGEST" | sed -n '2p')
[ -f "$TARBALL" ] || fail "the pinned artifact $TARBALL is not present; a deployment with nothing to deploy is not a deployment"

# 2. The staging row of the environment manifest, read rather than remembered.
STAGING_ROW=$(grep -E '^\| *staging *\|' "$MANIFEST" || true)
[ -n "$STAGING_ROW" ] || fail "the manifest declares no staging environment"

# 3. The declared probe for the capability staging needs. It is run, and its exit code is recorded.
PROBE=scripts/probes/cloud_identity.sh
PROBE_STATUS=0
if [ -f "$PROBE" ]; then
  sh "$PROBE" >/dev/null 2>&1 || PROBE_STATUS=$?
else
  PROBE_STATUS=127
fi

# 4. Record the status with the fields the milestone requires, and stop. NO LOCAL DEPLOYMENT IS PERFORMED.
mkdir -p .agent/evidence/EP-009
{
  echo "staging deploy: BLOCKED_CREDENTIALS"
  echo "artifact path: $TARBALL"
  echo "pinned digest: $PINNED"
  echo "target (from $MANIFEST): $(printf '%s' "$STAGING_ROW" | tr -s ' ')"
  echo "probe command: sh $PROBE"
  echo "probe exit code: $PROBE_STATUS"
  echo "PREFLIGHT.md rows that would have to be provisioned: CLOUD_WORKLOAD_IDENTITY (OPTIONAL, workload identity), and the staging platform credentials, which PREFLIGHT.md does NOT declare because no staging platform was ever provisioned"
  echo "blocking dependency edge: ARTIFACT_IDENTITY.json -> staging platform credentials -> staging deploy -> staging verify -> gate-release"
  echo "named next action: provision the staging account and its credentials, add the platform rows to PREFLIGHT.md and .env.example, then re-run sh scripts/staging-deploy.sh and sh scripts/staging-verify.sh against the same pinned digest"
  echo "never done here: no local deployment, no source-tree deployment, no sentinel printed"
  echo "recorded at commit: $(git rev-parse HEAD)"
} > .agent/evidence/EP-009/M4-staging-deploy.txt

blocked "staging is NOT_PROVISIONED in $MANIFEST (managed US cloud, separate account; Kubernetes, KMS, object store, managed Postgres, browser pool). Probe: sh $PROBE exit=$PROBE_STATUS. PREFLIGHT.md declares no platform credential because no platform was provisioned; the pinned digest is $PINNED and the artifact is $TARBALL. Evidence: .agent/evidence/EP-009/M4-staging-deploy.txt. NO LOCAL DEPLOYMENT WAS PERFORMED."
