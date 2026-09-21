## SUP-001 Repository Reality / Anti-Simulation Verification

- **Method.** Scan every production path for placeholder, stub, fake, demo, simulation, no-op, dead-route,
  hard-coded-success and unfinished-code vocabulary, and separately refuse a simulated adapter that a production
  path would select. `src/**` is the production path set; tests, scripts and pack documents are not.
- **Commands.** `sh scripts/reality-gate.sh`
- **Oracle.** Exit 0 with the sentinel `reality gate: ok`. A hit is permitted only by a per-line, reviewed entry in
  `.agent/reality-allow`, which is empty by design.
- **Negative case.** NOT DECLARED. The gate has no executed control that plants a placeholder and requires a
  refusal, so a repository-mapped `PASS` is not available for this subject and the entry stays `PARTIAL` naming that
  absence. The gate's failure mode was observed for real in FORGE-SPEC-1..9, when three prose hits made it exit 1
  without its sentinel; those hits were reworded at source in EP-010 M12 rather than allow-listed.
- **Completion gate.** DOD-019.

