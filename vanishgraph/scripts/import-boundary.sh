#!/usr/bin/env sh
# Domain import-boundary check. Sentinel: `import boundary: ok`
#
# Enforces the ARCHITECTURE.md code law:
#   "domain imports only standard library; application imports domain; adapters
#    implement ports; ... Lower layers never import higher layers."
#
# This is a hard gate, not a convention. The domain layer is where the privacy
# rules live (the eleven truth states, the closed transition table, the authority
# and egress rules). If a framework, ORM, HTTP client, or model SDK can be imported
# into it, those rules become untestable in isolation and start depending on
# infrastructure behaviour — which is precisely how a privacy guarantee silently
# becomes a network call.
#
# Permitted in src/domain/**: relative imports (./x.ts, ../y.ts) and node:* builtins.
# Anything else fails.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

[ -d src/domain ] || { echo "import boundary: FAIL - src/domain is missing" >&2; exit 1; }

# Collect module specifiers from import/export ... from '...' and bare import '...'.
specifiers=$(grep -rhoE "(from|import)[[:space:]]*'[^']+'" src/domain 2>/dev/null \
  | sed -E "s/.*'([^']+)'.*/\1/" | sort -u || true)

violations=""
for spec in $specifiers; do
  case "$spec" in
    ./*|../*) ;;                 # relative: fine
    node:*) ;;                   # standard library: fine
    *) violations="${violations}${spec}
" ;;
  esac
done

if [ -n "$violations" ]; then
  echo "import boundary: FAIL - the domain layer must import only the standard library" >&2
  echo "Offending module specifiers found in src/domain:" >&2
  printf '%s' "$violations" | sed '/^$/d' | sed 's/^/  - /' >&2
  echo "" >&2
  echo "Move the dependency behind a port declared in SPEC-001 §5 and implement it in" >&2
  echo "an adapter. Do not relax this check (DOD-027)." >&2
  exit 1
fi

echo "import boundary: ok"
