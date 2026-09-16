#!/usr/bin/env sh
# EP-006 auth/security node gate.
#
# SCOPE, STATED HONESTLY: this gate verifies what can be verified without a provisioned Keycloak realm, PostgreSQL,
# Valkey, or KMS: that the security modules type-check, that the layer import boundary holds, that the scope vocabulary
# and role bundles are closed and match the specification, that the credential-free security contract suites pass, and
# that no SPEC-006 §8 masking pattern exists in any gate script. It does NOT verify realm configuration, real token
# issuance, MFA enrolment, RLS, KMS resolution, or live webhook replay. It says so in its own output on every run and
# never reports those as passing.
#
# ONE DOCUMENTED DEVIATION FROM THE PLAN'S SKETCH, recorded here rather than applied silently: the sketch requires
# `src/application/security/authority-service.ts`, which EP-006 M4 creates. Requiring it in M1 would make this gate fail
# on the milestone that builds the foundation, so the precondition list is the files M1 creates and M4 extends it — the
# same edit-in-the-milestone-that-owns-the-file rule EP-005 M1/M2 used for `gate-ui.sh`.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -f src/application/security/scope-catalogue.ts ] || { echo "ep006 security gate: FAIL - scope catalogue is missing" >&2; exit 1; }
[ -f src/application/security/role-bundles.ts ] || { echo "ep006 security gate: FAIL - role bundles are missing" >&2; exit 1; }
[ -f src/adapters/config/security-config.ts ] || { echo "ep006 security gate: FAIL - the security configuration boundary is missing" >&2; exit 1; }
[ -f scripts/secret-scan.sh ] || { echo "ep006 security gate: FAIL - secret-scanning gate is missing" >&2; exit 1; }
[ -d tests/security ] || { echo "ep006 security gate: FAIL - tests/security/ is missing" >&2; exit 1; }

npx --no-install tsc --noEmit || { echo "ep006 security gate: FAIL - typecheck failed" >&2; exit 1; }
sh scripts/import-boundary.sh || { echo "ep006 security gate: FAIL - layer import boundary violated" >&2; exit 1; }
sh scripts/secret-scan.sh || { echo "ep006 security gate: FAIL - secret scan found a finding" >&2; exit 1; }

node --test "tests/contract/scope-catalogue.test.ts" || { echo "ep006 security gate: FAIL - scope catalogue suite failed" >&2; exit 1; }
node --test "tests/security/**/*.test.ts" || { echo "ep006 security gate: FAIL - security suites failed" >&2; exit 1; }

# SPEC-006 §8 masking patterns must not exist in any gate script. The scanner itself contains the patterns it searches
# for, so it is excluded by name — the same self-reference rule `secret-scan.sh` uses.
if grep -nE 'continue-on-error' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' | grep -v 'gate-security.sh' >/dev/null 2>&1; then
  echo "ep006 security gate: FAIL - masking pattern found in scripts/" >&2
  grep -nE 'continue-on-error' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' | grep -v 'gate-security.sh' >&2
  exit 1
fi
if grep -nE '(sh scripts/|node --test)[^|]*\|\|[[:space:]]*true' scripts/*.sh 2>/dev/null | grep -v 'security-check.sh' | grep -v 'gate-security.sh' >/dev/null 2>&1; then
  echo "ep006 security gate: FAIL - a gate invocation is silenced with '|| true'" >&2
  exit 1
fi

echo "ep006 security gate: UNVERIFIED-BY-THIS-GATE (recorded as BLOCKED_CREDENTIALS/BLOCKED_PREREQUISITE):"
for pair in "KEYCLOAK_ISSUER:sh scripts/probes/keycloak.sh" \
            "DATABASE_URL:sh scripts/probes/database_url.sh" \
            "VALKEY_URL:sh scripts/probes/valkey_url.sh" \
            "CLOUD_WORKLOAD_IDENTITY:sh scripts/probes/cloud_identity.sh"; do
  name=${pair%%:*}; probe=${pair#*:}
  if sh -c "$probe" >/dev/null 2>&1; then
    echo "  - ${name}: probe ok"
  else
    echo "  - ${name}: BLOCKED_CREDENTIALS (probe: ${probe})"
  fi
done
echo "  - RLS second enforcement layer: BLOCKED_PREREQUISITE (EP-003 schema and RLS policy not created)"
echo "  - realm MFA policy, refresh rotation, global sign-out, administrative revocation: BLOCKED_CREDENTIALS (KEYCLOAK_*)"
echo "  - manual assistive-technology validation of verification flows (SPEC-005 section 11, DOD-039): EXTERNAL_REQUIRED"
echo "  - counsel review of authorized-agent evidence, minors, identity-method sufficiency (SPEC-005 section 11): EXTERNAL_REQUIRED"

echo "gate-security: ok"
