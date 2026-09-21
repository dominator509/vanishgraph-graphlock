## SUP-007 Configuration & Feature-Flag Combinatorial Verification

- **Method.** Validate every declared key against the environment schema for each environment class, refusing
  missing required keys, empty values, prohibited substitutes, malformed values and unknown keys, and restore the
  fixture afterwards.
- **Commands.** `sh scripts/config-validate.sh`
- **Oracle.** Exit 0 with the sentinel `config: ok`, AND the five negative-control markers plus the restoration
  marker present in the gate's own output for this epoch. The executor requires all six before it will grant a
  repository-mapped `PASS` for this subject.
- **Negative case.** DECLARED, AND EXECUTED ON EVERY RUN. The gate refuses a missing required key
  (`MISSING_REQUIRED_KEY`), an empty value (`EMPTY_VALUE`), a prohibited substitute (`PROHIBITED_SUBSTITUTE`), a
  malformed value (`MALFORMED_VALUE`) and an unknown key (`UNKNOWN_KEY`), then proves the untouched fixture still
  validates cleanly. This is the repository's strongest declared control, and it is why this entry can reach `PASS`.
- **Completion gate.** DOD-020, DOD-032.

