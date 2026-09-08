NODE-META-BEGIN
ID: EP-007
DEPS: EP-006
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/verify.sh
VERIFY_SENTINEL: verify: ok
GREEN_TAG: green/EP-007
NODE-META-END

# EP-007

Purpose: execute only this graph node. Non-goals: no unrelated refactor, no fake success, no deployment. Read AGENTS.md, COMMANDS.md, graph, loops, linked specs and ledger. Define acceptance tests before production paths. Run exact commands, capture sentinels, append ledger, commit, and resume from first unchecked milestone.
