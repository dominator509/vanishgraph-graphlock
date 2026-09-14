#!/usr/bin/env sh
# Mutation check (DOD-018). Sentinel: `mutation check: ok`
#
# A permanently green test may not observe the behaviour it claims to protect. This gate
# introduces one controlled defect per critical domain feature, requires a real test to
# fail, restores the file, and requires the suite to go green again.
#
# Restoration is verified by SHA-256, not by assumption: if the digest does not match the
# pre-mutation value, the gate fails loudly and the tree is left for a human to inspect.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/mutation

if ! node scripts/lib/mutations.ts 2>&1 | tee .agent/evidence/mutation/run.txt; then
  echo "mutation check: FAIL - the mutation harness reported a failure; see .agent/evidence/mutation/run.txt" >&2
  exit 1
fi

grep -q 'mutations: all detected' .agent/evidence/mutation/run.txt \
  || { echo "mutation check: FAIL - the harness did not report 'mutations: all detected'" >&2; exit 1; }

grep -q 'restore: verified' .agent/evidence/mutation/run.txt \
  || { echo "mutation check: FAIL - restoration was not verified byte-identically" >&2; exit 1; }

if ! git diff --quiet -- src/domain; then
  echo "mutation check: FAIL - src/domain is dirty after the mutation run; a mutation was not restored" >&2
  git --no-pager diff --stat -- src/domain >&2
  exit 1
fi

echo "mutation check: ok"
