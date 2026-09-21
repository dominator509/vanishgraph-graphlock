## SUP-004 Reproducible Build Verification

- **Method.** Build the artifact twice into scratch locations and compare the content manifests, provenance and
  checksums byte for byte; record the container digests with their reconciliation.
- **Commands.** `sh scripts/build-reproducibility.sh`
- **Oracle.** `artifact reproducible: ok` with `CONTENT_IDENTICAL` recorded in the artifact identity under
  `reproducibility`.
- **Negative case.** NOT DECLARED as a planted-fault control. The comparison is itself a two-sided measurement -
  two independent builds must agree byte for byte - which is strong evidence, but it is not a control.
- **Completion gate.** DOD-003, SPEC-008 section 3.

