#!/usr/bin/env sh
# Environment validation against PREFLIGHT.md. Sentinel: `env validation: ok`
#
# The PREFLIGHT table is the declared credential contract. This gate makes four things
# machine-checkable:
#   1. every declared variable is documented in .env.example, and nothing stale is;
#   2. no credential VALUE is committed (.env.example holds only the placeholder);
#   3. a variable set to the literal placeholder PROVISION_ME is NOT provisioned;
#   4. unprovisioned REQUIRED credentials are reported as BLOCKED_CREDENTIALS.
#
# Per PREFLIGHT.md, "Missing credentials block only dependent work": absent REQUIRED
# credentials do not fail this gate. A broken contract (undocumented, stale, or a
# committed value) does fail it, because that is a real defect rather than an
# unprovisioned environment.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "env validation: FAIL - $1" >&2; exit 1; }

[ -f PREFLIGHT.md ] || fail "PREFLIGHT.md is missing; there is no declared credential contract"
[ -f .env.example ] || fail ".env.example is missing"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

awk -F'|' '
  /^PREFLIGHT-TABLE-BEGIN$/ { inside = 1; next }
  /^PREFLIGHT-TABLE-END$/   { inside = 0; next }
  inside && NF {
    name = $1; lane = $2
    gsub(/^[ \t]+|[ \t]+$/, "", name)
    gsub(/^[ \t]+|[ \t]+$/, "", lane)
    if (name != "") print name "|" lane
  }
' PREFLIGHT.md > "$tmp/declared"

[ -s "$tmp/declared" ] || fail "no variables could be parsed from the PREFLIGHT.md table"

declared=$(wc -l < "$tmp/declared" | tr -d ' ')
required=$(awk -F'|' '$2 == "REQUIRED" { n++ } END { print n + 0 }' "$tmp/declared")
optional=$(awk -F'|' '$2 == "OPTIONAL" { n++ } END { print n + 0 }' "$tmp/declared")

# Refuse to validate a vacuous contract.
[ "$required" -gt 0 ] || fail "the PREFLIGHT table declares no REQUIRED variables; refusing to validate a vacuous contract"

# 1. Documented: every declared variable appears in .env.example.
missing=""
while IFS='|' read -r name lane; do
  grep -q "^${name}=" .env.example || missing="${missing}  - ${name} (${lane})
"
done < "$tmp/declared"
if [ -n "$missing" ]; then
  echo "env validation: FAIL - declared in PREFLIGHT.md but absent from .env.example:" >&2
  printf '%s' "$missing" >&2
  exit 1
fi

# 2. Not stale: every .env.example key is declared in PREFLIGHT.md.
stale=""
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue ;; esac
  name=${line%%=*}
  grep -q "^${name}|" "$tmp/declared" || stale="${stale}  - ${name}
"
done < .env.example
if [ -n "$stale" ]; then
  echo "env validation: FAIL - present in .env.example but undeclared in PREFLIGHT.md:" >&2
  printf '%s' "$stale" >&2
  exit 1
fi

# 3. No committed credential value: every assignment must be the placeholder.
#    Values are redacted in the error output so a leak is not repeated to the log.
committed=$(grep -vE '^[[:space:]]*(#|$)' .env.example | grep -vE '=PROVISION_ME$' || true)
if [ -n "$committed" ]; then
  echo "env validation: FAIL - .env.example contains a value that is not the PROVISION_ME placeholder (VG-SEC-002):" >&2
  printf '%s\n' "$committed" | sed 's/=.*/=<redacted>/' >&2
  exit 1
fi

# 4. A placeholder in the process environment is not a provisioned credential.
placeholder=""
unprovisioned=""
while IFS='|' read -r name lane; do
  eval "value=\${${name}:-}"
  if [ "$value" = "PROVISION_ME" ]; then
    placeholder="${placeholder}  - ${name}
"
  elif [ -z "$value" ] && [ "$lane" = "REQUIRED" ]; then
    unprovisioned="${unprovisioned}  - ${name}
"
  fi
done < "$tmp/declared"

if [ -n "$placeholder" ]; then
  echo "env validation: FAIL - these variables are set to the literal placeholder PROVISION_ME; that is not a provisioned credential:" >&2
  printf '%s' "$placeholder" >&2
  exit 1
fi

printf 'env validation: PREFLIGHT.md declares %s variables (%s REQUIRED, %s OPTIONAL); .env.example matches\n' \
  "$declared" "$required" "$optional"
if [ -n "$unprovisioned" ]; then
  echo "env validation: NOTICE - unprovisioned REQUIRED credentials; state BLOCKED_CREDENTIALS, blocking only their dependent work (DOD-032):" >&2
  printf '%s' "$unprovisioned" >&2
  echo "env validation: see PREFLIGHT.md and .env.example; provision then re-run." >&2
fi

echo "env validation: ok"
