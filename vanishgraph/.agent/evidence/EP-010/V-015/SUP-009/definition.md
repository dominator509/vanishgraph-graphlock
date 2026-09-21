## SUP-009 Executable Documentation & Quickstart Verification

- **Method.** Treat the documentation as a contract: install the artifact into a virgin directory using only the
  documented command, then inventory every item the room had to supply beyond the documentation.
- **Commands.** `sh scripts/clean-room.sh`
- **Oracle.** `clean room: ok` with zero UNDOCUMENTED prerequisites in the inventory.
- **Negative case.** NOT DECLARED as a planted control. An undocumented prerequisite is itself the defect that
  fails the room, and that failure was observed for real in EP-010 M5 - three times, each an installer defect that
  was then fixed.
- **Completion gate.** DOD-034, VG-SHIP-028.

