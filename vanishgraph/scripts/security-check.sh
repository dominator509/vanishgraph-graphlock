#!/usr/bin/env sh
# Security check. Sentinel: `security check: ok`
#
# REPLACES THE LOUD-FAIL PLACEHOLDER, which printed its name and no check of any kind (EP-006 M1). The order below is
# deliberate: the cheapest and most catastrophic failure first — a committed credential — then the credential-free
# security suites, then the scans that exist because a gate is only as good as its inability to be silently disabled.
#
# IT FAILS CLOSED AND NAMES WHAT IT COULD NOT RUN. A suite that needs a credential records BLOCKED_CREDENTIALS with the
# probe command and its exit code (SPEC-006 §4.1) rather than being skipped, and this script prints those rows in its own
# output. It prints `security check: ok` only when every step it CAN run passed, and it says in the same breath which
# steps it could not run — the difference between a green stage and a green-looking one.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "security check: FAIL - $1" >&2; exit 1; }
step() { echo "security check: $1"; }

# 1. THE SECRET SCAN, FIRST AND UNCONDITIONALLY.
step "step 1/4: secret scan"
sh scripts/secret-scan.sh || fail "the secret scan found a finding"

# 2. THE SECURITY CONTRACT SUITES (M2-M10 grow this set; M1 adds the scope vocabulary and the masking-pattern suite).
step "step 2/4: security contract suites"
sh scripts/typecheck.sh >/dev/null || fail "the project does not typecheck, so no suite result would mean anything"
suites=$(find tests/security -name '*.test.ts' 2>/dev/null | sort || true)
[ -n "$suites" ] || fail "tests/security/ contains no *.test.ts: a security stage that ran nothing must not report a pass"
for suite in $suites; do
  node --test "$suite" || fail "security suite failed: $suite"
done
node --test "tests/contract/scope-catalogue.test.ts" || fail "scope catalogue suite failed"

# 3. THE SSRF TARGET-CLASSIFICATION SUITE. It arrives with M9; until then its absence is REPORTED rather than assumed.
step "step 3/4: SSRF target classification"
if [ -f tests/security/ssrf-classification.test.ts ]; then
  node --test "tests/security/ssrf-classification.test.ts" || fail "SSRF classification suite failed"
  ssrf_status="ran"
else
  ssrf_status="BLOCKED_PREREQUISITE (EP-006 M9 has not added tests/security/ssrf-classification.test.ts yet)"
fi

# 4. THE MASKING-PATTERN SCAN (SPEC-006 §8). A gate that can be silenced is not a gate.
step "step 4/4: masking-pattern scan"
if grep -nE 'continue-on-error' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' >/dev/null 2>&1; then
  echo "security check: FAIL - a masking pattern exists in scripts/ (SPEC-006 §8):" >&2
  grep -nE 'continue-on-error' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' >&2
  exit 1
fi
# \\|| true\\ IS MASKING ONLY WHEN IT SILENCES A GATE, AND THE LINE IS DRAWN AT THE COMMAND IT IS APPENDED TO: a
# best-effort cleanup (^M ... || true), a display pipeline, or an assignment that consumes the result has silenced
# nothing, while sh scripts/gate.sh || true has suppressed a failure. MEASURED: a blunt scan for the pattern flagged
# eleven existing scripts, all of them in the first category, so the scan now looks for the shape that suppresses a gate.
if grep -nE '(sh scripts/|node --test)[^|]*\|\|[[:space:]]*true' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' >/dev/null 2>&1; then
  echo "security check: FAIL - a gate invocation is silenced with '|| true' (SPEC-006 §8):" >&2
  grep -nE '(sh scripts/|node --test)[^|]*\|\|[[:space:]]*true' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' >&2
  exit 1
fi
# `set +e` IS NOT AUTOMATICALLY MASKING, AND THE DIFFERENCE IS WHETHER THE STATUS IS ACTED ON. A script that turns
# errexit off, captures `$?` and branches on it has silenced nothing; one that turns it off and ignores the status has.
# So this scan reports the files that disable errexit and FAILS only where the captured status is never read.
set_plus_e=$(grep -lE 'set[[:space:]]+\+e' scripts/*.sh 2>/dev/null || true)
if [ -n "$set_plus_e" ]; then
  for f in $set_plus_e; do
    if ! grep -qE 'status' "$f"; then
      echo "security check: FAIL - $f disables errexit and never reads the status it captured (SPEC-006 §8)" >&2
      exit 1
    fi
  done
  step "  errexit disabled in: $(echo "$set_plus_e" | tr '\n' ' ') (each reads the status it captured)"
fi

echo "security check: UNVERIFIED-BY-THIS-CHECK:"
echo "  - SSRF target classification: ${ssrf_status}"
echo "  - realm configuration, token issuance, MFA enrolment: BLOCKED_CREDENTIALS (KEYCLOAK_*; probe: sh scripts/probes/keycloak.sh)"
echo "  - RLS as the second enforcement layer: BLOCKED_PREREQUISITE (EP-003 schema and policies)"
echo "  - KMS resolution: BLOCKED_PREREQUISITE (ADR-006 open; no durable key provider)"
echo "  - live webhook replay against a real store: BLOCKED_CREDENTIALS (VALKEY_URL; probe: sh scripts/probes/valkey_url.sh)"
echo "security check: ok"



