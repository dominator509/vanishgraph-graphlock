## SUP-002 Requirements-to-Release Traceability Verification

- **Method.** Resolve every published claim to a stored artifact with a hash, and report any claim whose evidence
  value is not a path plus digest; a claim with no runnable artifact becomes `EXTERNAL_REQUIRED` naming its
  participant rather than being dressed as verified.
- **Commands.** `sh scripts/reconcile-claims.sh`
- **Oracle.** The reconciliation sentinel with one row per claim whose `evidence` column matches
  `<path> sha256:<digest>`, and zero unresolvable evidence values.
- **Negative case.** NOT DECLARED as a runnable control. The reconciliation refuses a claim whose evidence is prose,
  and that refusal was observed for real in EP-010 M7 when all 45 rows carried narrative sentences, but no
  repeatable planted-fault control is declared for this gate.
- **Completion gate.** DOD-025, DOD-030, VG-EVIDENCE-002.

