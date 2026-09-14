#!/usr/bin/env sh
# Provision the disposable PostgreSQL used by the database gates. Sentinel: `db provision: ok`
#
# Wraps the pinned Node helper (master prompt §10: a stack-native helper program is allowed
# when it is pinned and wrapped by a POSIX script). Idempotent: a running container with a
# valid state file is reused.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/provision.ts provision 2>&1 | tee .agent/evidence/db/provision-run.txt; then
  echo "db provision: FAIL - provisioning did not complete; classified BLOCKED_ENVIRONMENT (see .agent/evidence/db/provision-run.txt)" >&2
  exit 1
fi

grep -qx 'db provision: ok' .agent/evidence/db/provision-run.txt \
  || { echo "db provision: FAIL - the helper did not print its sentinel" >&2; exit 1; }

echo "db provision: ok"
