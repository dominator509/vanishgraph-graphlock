#!/usr/bin/env sh
# Backup and restore evidence (EP-009 M6; DOD-036, DOD-015/016/017, SPEC-002 section 7).
# Sentinel: `backup restore: ok`
#
# WHY THIS IS A WRAPPER AND NOT A SECOND DRILL: `scripts/backup-drill.sh` already implements the destructive
# backup/restore drill with erasure reconciliation (EP-003 M8): it seeds data, crypto-shreds a subject, dumps the
# database, DESTROYS it, restores it from the dump alone, and asserts five post-conditions including that the
# restore did not resurrect erased PII. Reimplementing that here would produce a second, divergent copy of a
# destructive procedure -- the kind of duplication that later disagrees with itself. So this script RUNS that
# drill, requires its sentinel, and records what it proves and what it explicitly does not.
#
# WHAT IT ADDS ON TOP: the evidence is hashed and its file set is recorded, so the milestone's claim points at
# bytes rather than at a sentence, and the PITR row is carried forward as the drill's own BLOCKED_CREDENTIALS
# rather than being smoothed over.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "backup restore: FAIL - $1" >&2; exit 1; }
blocked() { echo "backup restore: BLOCKED_ENVIRONMENT - $1" >&2; exit 1; }

[ -f scripts/backup-drill.sh ] || fail "scripts/backup-drill.sh is missing; there is no drill to run"
[ -f .agent/verification/state/ARTIFACT_IDENTITY.json ] || fail "no published artifact identity; run sh scripts/build-artifact.sh first"

STATE_FILE=${VG_DB_STATE_FILE:-${TMPDIR:-/tmp}/vanishgraph-db.env}
[ -f "$STATE_FILE" ] || blocked "no database state file at $STATE_FILE; run sh scripts/db-provision.sh first (the drill needs a disposable database to destroy)"

DRILL_LOG=.agent/evidence/EP-009/drills/backup-restore-drill.log
mkdir -p .agent/evidence/EP-009/drills

if ! sh scripts/backup-drill.sh >"$DRILL_LOG" 2>&1; then
  tail -n 25 "$DRILL_LOG" >&2
  # THE DRILL DECIDES ITS OWN STATUS. A refusal to run against a non-disposable database, or a missing container,
  # is an environment limitation, not a product failure, and it is reported as such with its own words quoted.
  if grep -qE 'BLOCKED_(ENVIRONMENT|CREDENTIALS)' "$DRILL_LOG"; then
    blocked "the backup drill reported its own blocked status; see $DRILL_LOG"
  fi
  fail "the backup drill failed; see $DRILL_LOG"
fi
grep -qx 'backup drill: ok' "$DRILL_LOG" || { tail -n 15 "$DRILL_LOG" >&2; fail "the backup drill exited zero without printing its sentinel"; }

# The drill's own evidence, hashed, so this milestone's claim resolves to bytes.
EVIDENCE_DIR=.agent/evidence/EP-003/restore-drill
[ -d "$EVIDENCE_DIR" ] || fail "the drill printed its sentinel but wrote no evidence directory at $EVIDENCE_DIR"
EVIDENCE_FILES=$(find "$EVIDENCE_DIR" -type f | wc -l | tr -d ' ')
[ "$EVIDENCE_FILES" -gt 0 ] || fail "the drill's evidence directory is empty"

{
  echo "backup restore: ok"
  echo "drill: sh scripts/backup-drill.sh (the EP-003 M8 destructive drill, reused rather than reimplemented)"
  echo "sentinel required and found: backup drill: ok"
  echo "what the drill proves: after seeding, crypto-shredding one subject, dumping, destroying the database and restoring from the dump alone, the erased subject's PII is unrecoverable, erasure tombstones are intact, RLS is enabled/forced/policied on every tenant-scoped table, the audit chain is intact, and every evidence digest verifies"
  echo "evidence files: $EVIDENCE_FILES under $EVIDENCE_DIR"
  echo "evidence index:"
  for file in $(find "$EVIDENCE_DIR" -type f | sort); do
    echo "  $(node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$file")  $file"
  done
  echo "NOT PROVEN HERE, carried forward from the drill's own report: point-in-time recovery. WAL archiving to object storage is not provisioned, so the PITR row is BLOCKED_CREDENTIALS in the drill's output and is NOT claimed as verified."
  echo "recorded at commit: $(git rev-parse HEAD)"
} > .agent/evidence/EP-009/M6-backup-restore.txt

echo "backup restore: ok ($EVIDENCE_FILES evidence file(s) hashed; PITR carried as BLOCKED_CREDENTIALS, not claimed)"
