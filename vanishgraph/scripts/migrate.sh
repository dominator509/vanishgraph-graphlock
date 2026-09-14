#!/usr/bin/env sh
# Migration wrapper. Sentinel: `migrate: ok`
#
# Loads the disposable-database state file so the gates do not each re-implement DSN
# resolution, then delegates to the pinned Node runner. `--dsn` on the command line wins.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

mkdir -p .agent/evidence/db
if ! node src/infrastructure/database/migrate.ts "$@" 2>&1 | tee .agent/evidence/db/migrate-run.txt; then
  echo "migrate: FAIL - see .agent/evidence/db/migrate-run.txt" >&2
  exit 1
fi

# The runner emits two sentinels depending on the subcommand: `migrate: ok` for
# up/status/verify, and `rls coverage: ok` for verify-rls, because that subcommand reports a
# different thing (isolation coverage, not migration state). The wrapper originally demanded
# only `migrate: ok`, so a CLEAN verify-rls run exited 1 with "the runner did not print its
# sentinel" — a false failure on the most important check in the node. Either sentinel is
# accepted; the underlying exit code (checked above) remains the authority.
grep -qE '^(migrate: ok|rls coverage: ok)$' .agent/evidence/db/migrate-run.txt \
  || { echo "migrate: FAIL - the runner did not print its sentinel" >&2; exit 1; }

echo "migrate: ok"
