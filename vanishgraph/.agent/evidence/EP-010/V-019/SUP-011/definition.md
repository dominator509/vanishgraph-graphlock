## SUP-011 Operational Observability Correctness Verification

- **Method.** Assert that the telemetry contract holds: required resource attributes resolve or fail closed, metric
  names and meanings come from the catalogue, and no PII reaches a log or an error envelope.
- **Commands.** `sh scripts/test-unit.sh`, `sh scripts/security-check.sh`
- **Oracle.** Both sentinels with zero failures, including the observability identity and masking suites.
- **Negative case.** NOT DECLARED as a gate control.
- **Completion gate.** DOD-013, DOD-024, SPEC-007.

