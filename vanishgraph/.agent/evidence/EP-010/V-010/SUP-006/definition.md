## SUP-006 Idempotency, Retry & Delivery-Semantics Verification

- **Method.** Assert that repeated delivery of the same request produces one effect, that retries are bounded, and
  that acknowledgement semantics hold under concurrency, in the suites that own those modules.
- **Commands.** `sh scripts/test-integration.sh`, `sh scripts/test-unit.sh`
- **Oracle.** `test-integration: ok` and `test-unit: ok` with zero failures, including the idempotency and
  concurrency suites.
- **Negative case.** NOT DECLARED as a gate control; the idempotency suites contain executed negative cases for the
  modules they own, but no separate planted-fault control is declared for this subject.
- **Completion gate.** DOD-017.

