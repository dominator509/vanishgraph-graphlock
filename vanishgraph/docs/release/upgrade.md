# Upgrade procedure

**Supported upgrade paths: NONE ARE CLAIMED.** SPEC-008 §8 (`VG-SHIP-029`) and DOD-035 require that only paths
executed against a real prior state are listed as supported, and this repository has never had a released prior
state: `db/UPGRADE_MATRIX.md` names `scripts/test-migrations.sh` as the producer of the from-empty, from-prior and
failed-migration evidence rows, and **that script does not exist** (measured: `ls scripts/test-migrations.sh`
fails). The rows it would exercise are therefore `UNPROVEN`, and `scripts/test-integration.sh` writes exactly that
into its evidence rather than implying the matrix passed.

## What has actually been executed against a real state

| path | state | evidence |
|---|---|---|
| migrations applied to an empty provisioned database | EXECUTED | `sh scripts/test-integration.sh` → `.agent/evidence/db/integration-migrate.txt` |
| row-level security coverage on the live schema | EXECUTED | `.agent/evidence/db/integration-rls.txt` |
| a failed migration rolled back to a known version and re-applied | EXECUTED (EP-003 M7) | `.agent/evidence/db/` |
| upgrade from a released prior schema | **UNPROVEN** | no released prior schema exists |
| upgrade with rollback on failure | **UNPROVEN** | nothing to roll back to |

## The procedure an operator would follow

The pre-upgrade step is always a backup, and it is not optional: an upgrade without a restore point is a change
nobody can reverse. The backup and restore path is exercised by `scripts/backup-restore-drill.sh`, whose measured
result and status are recorded in `.agent/evidence/EP-009/drills/`.

## What this document must not become

A list of plausible commands. Every command published here must have been executed in this environment first,
which is what `sh scripts/published-commands.sh` enforces: it extracts the fenced blocks from this file and runs
them exactly as written. When the upgrade matrix gains a real path, the command that exercises it is published
here **after** it has run, never before.
