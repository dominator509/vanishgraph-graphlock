#!/usr/bin/env sh
# Lint stage. Sentinel: `lint: ok`
#
# Real implementation (EP-000 M3). This script previously printed
# "lint.sh: accounted" with no check of any kind.
#
# Lint here is type checking plus the architectural import-boundary check. The pack
# does not mandate a particular linter, and inventing a stylistic ruleset would add
# churn without adding a safety property. What lint MUST do — and now does — is catch
# the class of defect that actually matters for this product: a lower layer reaching
# into a higher one, or the domain layer acquiring an infrastructure dependency.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

sh scripts/typecheck.sh
sh scripts/import-boundary.sh

echo "lint: ok"
