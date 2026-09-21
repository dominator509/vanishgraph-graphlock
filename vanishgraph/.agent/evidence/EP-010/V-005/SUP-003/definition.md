## SUP-003 Packaging & Distribution Artifact Verification

- **Method.** Produce the installable package with its SBOM, provenance and checksum manifest; confirm every
  declared artifact path exists and every recorded digest resolves from the bytes on disk.
- **Commands.** `sh scripts/build-artifact.sh`, then `sh scripts/artifact-identity.sh`
- **Oracle.** `artifact: built` from the first and `artifact identity: ok` from the second, with every declared
  artifact path present and every digest RESOLVED.
- **Negative case.** NOT DECLARED. `artifact-identity.sh` does refuse a missing or tampered artifact - observed for
  real in EP-010 M12, when `build.sh` wiped `dist/` and all four recorded paths were reported missing - but that
  refusal is not driven by a declared, repeatable control.
- **Completion gate.** DOD-003, DOD-029.

