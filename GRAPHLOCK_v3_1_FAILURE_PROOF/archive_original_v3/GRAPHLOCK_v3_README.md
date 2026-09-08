# GraphLock v3 Verified Bundle

## Primary file

`6Layer-MasterPrompt-v3-GRAPHLOCK-VERIFIED.md` is the complete self-contained master prompt.

It preserves the original six-layer GraphLock architecture and adds:

- a nested V-000 through V-021 production-readiness verification DAG;
- a 484-ID test registry with zero-unaccounted accounting;
- all 434 supplied atomic security prompt bodies in a checksum-verified embedded archive;
- 15 transparently reconstructed Blockchain prompt bodies for the source pack's missing BC-008 through BC-022 entries;
- 20 E2E orchestrator suites;
- 15 supplemental production-readiness gates;
- 42 Rule-Because-Evidence-Or-Else Definition-of-Done clauses;
- exact artifact identity and immutable candidate epochs;
- non-cascading prerequisite/environment/capability blockers;
- durable checkpoint/resume for long-running campaigns;
- honest human, hardware, accredited, and external gates.

## Recommended use

For a coding agent with filesystem access, place the primary file in the workspace and use `GRAPHLOCK_v3_BOOTSTRAP_LAUNCHER.md` as the short invocation. For a regular chat environment, attach the primary file and the target repository/connector, then use the launcher text.

The master is intentionally large because it is self-contained. An agent must read it from file rather than rely on a copied excerpt when its prompt/context limit is smaller than the document.

## Integrity check

Run:

```sh
python3 validate_graphlock_v3.py 6Layer-MasterPrompt-v3-GRAPHLOCK-VERIFIED.md
```

A valid result reports 484 registry entries, 42 DOD clauses, 22 verification stages, 434 original embedded prompt bodies, 20 E2E suites, 15 supplemental gates, and 15 reconstructed Blockchain bodies.

No prompt can disable hard limits imposed by a hosted agent, chat session, CI runner, or operating system. GraphLock v3 handles those limits through persistent runners, heartbeats, checkpoints, exact resume state, and truthful deferred/external statuses; it never shortens a required test and calls it complete.
