NODE-META-BEGIN
ID: EP-009
DEPS: EP-008
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/verify.sh
VERIFY_SENTINEL: verify: ok
GREEN_TAG: green/EP-009
NODE-META-END

# EP-009

Purpose: execute only this graph node. Non-goals: no unrelated refactor, no fake success, no deployment. Read AGENTS.md, COMMANDS.md, graph, loops, linked specs and ledger. Define acceptance tests before production paths. Run exact commands, capture sentinels, append ledger, commit, and resume from first unchecked milestone.
