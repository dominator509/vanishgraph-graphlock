#!/usr/bin/env sh
# Preflight. Sentinel: `preflight: ok`
#
# Real implementation (EP-000 M4). This script previously asserted only that
# AGENTS.md existed, and before that printed its sentinel unconditionally.
#
# Scope: verify that THIS environment is sound enough to run the graph. Per
# PREFLIGHT.md, "Missing credentials block only dependent work" — so absent
# third-party credentials are reported as recorded blockers, not as preflight
# failure. Preflight fails only when the local environment is actually broken.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "preflight: FAIL - $1" >&2; exit 1; }

# 1. Governance control plane present.
[ -f AGENTS.md ] || fail "AGENTS.md is missing; the repository is not governed"
[ -f COMMANDS.md ] || fail "COMMANDS.md is missing"
[ -f .agent/GRAPH.md ] || fail ".agent/GRAPH.md is missing"
[ -f .agent/DONE_LAW.md ] || fail ".agent/DONE_LAW.md is missing"

# 2. Toolchain present and at the required major version.
command -v node >/dev/null 2>&1 || fail "node is required but not found"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "node >= 24 is required, found $(node --version)"
command -v npm >/dev/null 2>&1 || fail "npm is required but not found"
command -v python3 >/dev/null 2>&1 || fail "python3 is required but not found"

# 3. Dependency state installed and locked (DOD-002 support).
[ -f package.json ] || fail "package.json is missing"
[ -f package-lock.json ] || fail "package-lock.json is missing; the dependency set is not locked"
[ -d node_modules ] || fail "node_modules is missing; run npm ci"
[ -f tsconfig.json ] || fail "tsconfig.json is missing"

# 4. Report (do not fail on) missing credentials declared REQUIRED in PREFLIGHT.md.
#    These gate dependent work only; they do not invalidate the local environment.
missing_blockers=""
for var in DATABASE_URL VALKEY_URL S3_ENDPOINT KEYCLOAK_ISSUER LOCAL_MODEL_ENDPOINT GITHUB_APP_ID; do
  eval "value=\${$var:-}"
  if [ -z "$value" ]; then
    missing_blockers="${missing_blockers}  - ${var}
"
  fi
done
if [ -n "$missing_blockers" ]; then
  echo "preflight: NOTICE - the following PREFLIGHT.md credentials are not provisioned." >&2
  echo "These block only their dependent work (integration, E2E, live-fire, deploy)." >&2
  printf '%s' "$missing_blockers" >&2
  echo "See PREFLIGHT.md and .env.example. Capability state: BLOCKED_CREDENTIALS." >&2
fi

echo "preflight: ok"
