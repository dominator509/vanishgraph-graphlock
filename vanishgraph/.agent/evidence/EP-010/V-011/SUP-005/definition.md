## SUP-005 Upgrade Path Verification

- **Method.** Exercise the upgrade, downgrade and rollback paths against a prior released artifact and compare the
  old and new state hashes.
- **Commands.** `sh scripts/upgrade-drill.sh`
- **Oracle.** The drill's sentinel with both versions' state hashes recorded.
- **Negative case.** NOT DECLARED, and the precondition is absent: only one artifact version exists in this
  repository, so the from-prior path cannot run at all. The clause records `BLOCKED_PREREQUISITE` for exactly that
  reason (DOD-035) rather than a claim.
- **Completion gate.** DOD-035.

