NODE-META-BEGIN
ID: EP-000
DEPS: -
MAX_ATTEMPTS_PER_MILESTONE: 6
VERIFY: sh scripts/verify.sh
VERIFY_SENTINEL: verify: ok
GREEN_TAG: green/EP-000
NODE-META-END

# EP-000

Purpose: execute only this graph node. Non-goals: no unrelated refactor, no fake success, no deployment. Read AGENTS.md, COMMANDS.md, graph, loops, linked specs and ledger. Define acceptance tests before production paths. Run exact commands, capture sentinels, append ledger, commit, and resume from first unchecked milestone.
