#!/usr/bin/env sh
# Type check stage. Sentinel: `typecheck: ok`
#
# Real implementation (EP-000 M3). This script previously printed
# "typecheck.sh: accounted" with no check of any kind.
#
# tsconfig.json is strictly configured (strict, noUncheckedIndexedAccess,
# exactOptionalPropertyTypes, noFallthroughCasesInSwitch, verbatimModuleSyntax,
# erasableSyntaxOnly), so this gate is substantive rather than a formality: it also
# rejects non-erasable TypeScript that Node's native type stripping cannot execute.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -f tsconfig.json ] || { echo "typecheck: FAIL - tsconfig.json is missing" >&2; exit 1; }
[ -d node_modules ] || { echo "typecheck: FAIL - dependencies not installed; run npm ci" >&2; exit 1; }

npx --no-install tsc --noEmit

echo "typecheck: ok"
