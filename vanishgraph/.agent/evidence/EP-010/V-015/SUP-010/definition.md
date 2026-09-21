## SUP-010 Visual Regression Verification

- **Method.** Render the declared portal and console surfaces and assert their structure, contrast tokens and
  region states against the declared expectations.
- **Commands.** `sh scripts/test-e2e.sh` and the contract render suites under `tests/contract/`
- **Oracle.** `end-to-end tests: ok`, or `BLOCKED_ENVIRONMENT` naming the missing browser runtime - which is what
  this environment reports, honestly, rather than a pass.
- **Negative case.** NOT DECLARED for the gate.
- **Completion gate.** SPEC-004, VG-UI-013/021.

