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

# BIND THE RUN TO A DIGEST BEFORE ANY STAGE RUNS. `smoke` refuses to run without `VG_ARTIFACT_DIGEST`, because a stage
# that tests a digest must say WHICH digest it is testing (DOD-004, SPEC-008 VG-SHIP-021), and the ladder is the layer
# that knows it: the pinned tarball digest is published in `.agent/verification/state/ARTIFACT_IDENTITY.json`. EP-010
# M12: `verify.sh` exported no digest, so `smoke` failed with "VG_ARTIFACT_DIGEST is not declared" on a run whose
# artifact was valid and whose identity had just validated — one stage from the end, for a reason that had nothing to
# do with the candidate. The binding is PRINTED, so the log says which digest the whole run was bound to, and the
# stage's own check is untouched: it still requires the declared digest to equal the recorded one and re-hashes the
# tarball's bytes.
if [ -z "${VG_ARTIFACT_DIGEST:-}" ]; then
  VG_ARTIFACT_DIGEST=$(node -e '
    const fs = require("node:fs");
    const p = ".agent/verification/state/ARTIFACT_IDENTITY.json";
    if (!fs.existsSync(p)) process.exit(0);
    const identity = JSON.parse(fs.readFileSync(p, "utf8"));
    const tarball = (identity.artifact_paths ?? []).find((entry) => entry.endsWith(".tgz"));
    process.stdout.write(tarball === undefined ? "" : ((identity.artifact_digests ?? {})[tarball] ?? ""));
  ')
  if [ -n "$VG_ARTIFACT_DIGEST" ]; then
    printf 'verify: bound to artifact %s (published in .agent/verification/state/ARTIFACT_IDENTITY.json)\n' "$VG_ARTIFACT_DIGEST"
  else
    printf 'verify: no published artifact digest could be resolved, so stages that require one will refuse\n' >&2
  fi
fi
export VG_ARTIFACT_DIGEST

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
