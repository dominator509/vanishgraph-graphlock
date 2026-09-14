# Supported upgrade matrix (DOD-016, SPEC-002 MIG-2)

This file is the data the gates read and the record a human reads. It lists every schema
state this project claims to upgrade **from**, and where the evidence for each is produced.

| From (schema state) | Applied versions | How it is produced | Evidence |
|---|---|---|---|
| empty database | — | `db/migrations` applied to `vanishgraph_empty` | `.agent/evidence/db/migrations/from-empty.txt`, schema dump hash |
| v1 baseline set | `0001`…`0005` | `migrate up --up-to 5` on `vanishgraph_prior`, then `db/seed/prior_release.sql`, then `migrate up` | `.agent/evidence/db/migrations/from-prior.txt`, before/after row counts and dump hashes |
| failed migration state | partial | `migrate up --dir <fixture>` on `vanishgraph_failure` | `.agent/evidence/db/migrations/failure-and-retry.txt` |

Honest scope note: **no customer release exists yet**, so "prior released schema" currently
means the immediately preceding migration set of this same unreleased line. The matrix grows
by one row per released schema version; a release that adds a migration MUST add its row here
in the same change set, and `scripts/test-migrations.sh` fails when a row's applied-version
prefix does not match the migrations on disk.

Not covered here, and deliberately not claimed: restore-from-backup (VG-DATA-011, DOD-036),
which requires a real backup/restore drill in EP-008/EP-009, and crypto-shredding with a real
KMS (SPEC-002 §4, `BLOCKED_CREDENTIALS`).
