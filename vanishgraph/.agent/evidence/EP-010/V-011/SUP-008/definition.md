## SUP-008 Cross-Platform & Supported-Environment Matrix Verification

- **Method.** Confirm the declared toolchain versions and the published commands behave as documented on the
  supported environment, by running the published commands exactly as written.
- **Commands.** `sh scripts/gate-toolchain.sh`, `sh scripts/published-commands.sh`
- **Oracle.** `gate-toolchain: ok` and a published-command run recording zero drift, with the tool versions
  recorded.
- **Negative case.** NOT DECLARED.
- **Completion gate.** DOD-002, DOD-023.

