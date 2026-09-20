## BC-018 -- Coverage-Guided Fuzzing

Instrument the applicable contract/compiler/runtime and feed coverage feedback into input generation. Track line, branch, opcode, state-transition, and call-sequence coverage where supported. Maintain and minimize the corpus; investigate coverage plateaus and unreachable code. Do not equate high coverage with correctness. A pass requires documented campaign duration, environment, seeds, coverage progression, unresolved crashes, and rationale for critical unvisited paths.

