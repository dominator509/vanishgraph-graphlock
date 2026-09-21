## SUP-013 Deployment, Promotion, Canary & Rollback Lifecycle Verification

- **Method.** Deploy to staging, verify the deployed digest, exercise the canary and rollback paths, and confirm the
  operator-visible record.
- **Commands.** `sh scripts/staging-deploy.sh`, `sh scripts/staging-verify.sh`, `sh scripts/rollback-drill.sh`
- **Oracle.** Each script's sentinel with the deployed digest read back and compared against the pinned digest.
- **Negative case.** NOT DECLARED, and staging is `NOT_PROVISIONED` in this environment, so the path is recorded as
  `BLOCKED_CREDENTIALS`/`BLOCKED_ENVIRONMENT` rather than claimed.
- **Completion gate.** DOD-009, DOD-020, VG-SHIP-030.

