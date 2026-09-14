#!/usr/bin/env sh
# Build stage. Sentinel: `build: ok`
#
# Real implementation (EP-000 M3). This script previously printed
# "build.sh: accounted" with no check of any kind.
#
# Scope, stated honestly: this node builds the DOMAIN layer only, because that is
# the only layer that exists. It is a real artifact-producing build (tsc emits ESM
# plus declarations and source maps to dist/), not a placeholder — but it is not yet
# the production distribution artifact that DOD-003 requires. That artifact arrives
# with the service and UI in EP-004/EP-005 and is packaged in EP-009.
#
# The emitted artifact digest is recorded so later stages can bind evidence to an
# exact build output rather than to a source tree.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -f tsconfig.build.json ] || { echo "build: FAIL - tsconfig.build.json is missing" >&2; exit 1; }
[ -d src ] || { echo "build: FAIL - src/ is missing" >&2; exit 1; }
[ -d node_modules ] || { echo "build: FAIL - dependencies not installed; run npm ci" >&2; exit 1; }

rm -rf dist
npx --no-install tsc -p tsconfig.build.json

[ -d dist ] || { echo "build: FAIL - tsc reported success but produced no dist/" >&2; exit 1; }

entry=dist/domain/state-machine.js
[ -f "$entry" ] || { echo "build: FAIL - expected build output $entry is missing" >&2; exit 1; }

# Record the artifact digest so evidence can be bound to this exact output.
mkdir -p .agent/evidence/build
if command -v sha256sum >/dev/null 2>&1; then
  find dist -type f -name '*.js' -print0 | sort -z | xargs -0 sha256sum > .agent/evidence/build/domain-artifact.sha256
elif command -v shasum >/dev/null 2>&1; then
  find dist -type f -name '*.js' -print | sort | xargs shasum -a 256 > .agent/evidence/build/domain-artifact.sha256
else
  echo "build: FAIL - no sha256 tool available (sha256sum or shasum required)" >&2; exit 1
fi
[ -s .agent/evidence/build/domain-artifact.sha256 ] || { echo "build: FAIL - artifact digest file is empty" >&2; exit 1; }

echo "build: ok"
