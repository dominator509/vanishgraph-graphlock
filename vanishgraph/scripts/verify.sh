#!/usr/bin/env sh
# verify.sh -- node-level verification gate (EP-000 VERIFY command).
#
# SPEC BASIS: 6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md, Section 10
# "Scripts", line 1357, which fixes the stage order exactly:
#
#   "verify.sh runs, in order: preflight, lint, format-check, typecheck, unit,
#    integration, security-check, dependency-audit, reality-gate,
#    test-collection-guard, build, artifact-identity, artifact-bound smoke,
#    artifact-bound E2E, and artifact-bound live-fire."
#
# ORIGINAL DEFECT (corrected here): this script was `echo "verify: ok"` with no
# check of any kind. It therefore satisfied the EP-000 VERIFY_SENTINEL while
# proving nothing -- the exact "software that appears to work is a failure state"
# condition named in AGENTS.md.
#
# BEHAVIOUR: runs each stage in the mandated order and stops at the first
# failure with a non-zero exit (set -eu). Because every stage is currently a
# loud-fail placeholder, this exits non-zero and prints NO success sentinel.
# It will print "verify: ok" only when all fifteen real stages genuinely pass.
#
# NOTE: This removes a false green. It does not weaken a gate: no stage is
# skipped, reordered, or exempted, and no sentinel is printed on any failure path.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive

cd "$(dirname "$0")/.."

# Stage order is mandated by spec line 1357. Do not reorder or remove entries.
STAGES="
preflight:preflight.sh
lint:lint.sh
format-check:format-check.sh
typecheck:typecheck.sh
unit:test-unit.sh
integration:test-integration.sh
security-check:security-check.sh
dependency-audit:dependency-audit.sh
reality-gate:reality-gate.sh
test-collection-guard:test-collection-guard.sh
build:build.sh
artifact-identity:artifact-identity.sh
smoke:smoke-test.sh
e2e:test-e2e.sh
live-fire:live-fire.sh
"

printf '%s\n' "$STAGES" | while IFS=: read -r stage script; do
  [ -n "$stage" ] || continue
  printf 'verify: running stage %s (scripts/%s)\n' "$stage" "$script" >&2
  # set -e inside this subshell means a non-zero stage aborts the whole pipeline.
  sh "scripts/$script"
done

echo "verify: ok"
