#!/usr/bin/env sh
# Tear down the disposable PostgreSQL and prove the container is gone. Sentinel: `db teardown: ok`
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/provision.ts teardown 2>&1 | tee .agent/evidence/db/teardown-run.txt; then
  echo "db teardown: FAIL - teardown did not complete" >&2
  exit 1
fi

grep -qx 'db teardown: ok' .agent/evidence/db/teardown-run.txt \
  || { echo "db teardown: FAIL - the helper did not print its sentinel" >&2; exit 1; }

echo "db teardown: ok"
