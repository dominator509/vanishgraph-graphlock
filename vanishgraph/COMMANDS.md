# COMMANDS.md

All commands run from the repository root with CI=true, GIT_TERMINAL_PROMPT=0, GIT_PAGER=cat, PAGER=cat, DEBIAN_FRONTEND=noninteractive.

- install: `sh scripts/install.sh`
- preflight: `sh scripts/preflight.sh`
- lint: `sh scripts/lint.sh`
- format-check: `sh scripts/format-check.sh`
- typecheck: `sh scripts/typecheck.sh`
- unit: `sh scripts/test-unit.sh`
- integration: `sh scripts/test-integration.sh`
- e2e: `sh scripts/test-e2e.sh`
- build: `sh scripts/build.sh`
- security-check: `sh scripts/security-check.sh`
- dependency-audit: `sh scripts/dependency-audit.sh`
- smoke: `sh scripts/smoke-test.sh`
- live-fire: `sh scripts/live-fire.sh`
- verify: `sh scripts/verify.sh`
- production-readiness: `sh scripts/production-readiness-check.sh`
- pack validation: `python3 scripts/validate-generated-pack.py .`
- anti-gaming review: `python3 scripts/anti-gaming-scan.py .`

Coding agents must not invent commands. If a command is missing or stale, update this file first with repository evidence and a Decision Log entry. Production deployment is manual and requires a separate authorization.
