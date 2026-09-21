## SUP-012 SLO, SLA & Error-Budget Release Verification

- **Method.** Evaluate the objectives declared in `config/slo/objectives.json` against measured signals, and refuse
  a release claim the budget does not support.
- **Commands.** `sh scripts/slo-evaluate.sh`
- **Oracle.** The evaluator's sentinel with the objectives it evaluated and the budget state recorded.
- **Negative case.** NOT DECLARED, and the measurement half is absent: no percentile measurement was taken in this
  environment, which is why the clause records `DEFERRED_LONG_RUNNING` (DOD-022) rather than a claim.
- **Completion gate.** DOD-022, DOD-038.

