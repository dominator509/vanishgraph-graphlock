# SPEC-008 Production Readiness

Release requires exact candidate SHA and artifact digest, clean-room installation, artifact-bound smoke/E2E/live-fire, 484-test accounting, 42 DOD clauses, independent evidence, security/privacy review, required soak and performance campaigns, rollback/recovery proof, and external human gates.

The only release verdicts are GO, NO_GO, CONDITIONAL_EXTERNAL_GATES, and INCONCLUSIVE. AUTO_DEPLOY_AUTHORIZED is no; production deployment remains manual.

Any missing evidence, fake path, blanket blocker, skipped required test, stale artifact, unresolved critical finding, or unauthorized external write prevents GO.
