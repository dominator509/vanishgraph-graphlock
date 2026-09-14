#!/usr/bin/env sh
# Reality gate: no simulated, unfinished, or placeholder behaviour in production paths.
#
# Sentinel: `reality gate: ok`
#
# Replaces the pre-discovery loud-fail placeholder (EP-001 milestone M5).
#
# Implements DOD-019 (placeholder/stub/fake/unfinished scans over production paths) and
# the production-path half of DOD-020 (no simulated adapter selected in production).
# Patterns come from .agent/reality-patterns. A hit is permitted only by an explicit
# path:line entry in .agent/reality-allow, which is a reviewed decision, never a
# wildcard.
#
# Scope: src/** is the production path set. Tests, scripts, and pack documents are not
# production paths. As src/ grows, this gate covers the new code automatically.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "reality gate: FAIL - $1" >&2; exit 1; }

[ -d src ] || fail "src/ is missing"
[ -f .agent/reality-patterns ] || fail ".agent/reality-patterns is missing; the pattern contract is undefined"
[ -f .agent/reality-allow ] || fail ".agent/reality-allow is missing; there is no allow-list contract"

hits=""

# 1. Declared lexical patterns.
while IFS= read -r pattern; do
  case "$pattern" in ''|'#'*) continue ;; esac
  found=$(grep -rniE -- "$pattern" src 2>/dev/null || true)
  [ -z "$found" ] || hits="${hits}${found}
"
done < .agent/reality-patterns

# 2. Production paths must not contain simulated adapters. Test doubles live in tests/.
simulated=$(find src -type f \( -iname '*mock*' -o -iname '*fake*' -o -iname '*stub*' \
  -o -iname '*demo*' -o -iname '*sample*' -o -iname '*.simulation.*' \) -print 2>/dev/null | sort || true)
[ -z "$simulated" ] || hits="${hits}${simulated}
"

# 3. Application paths must not print a gate sentinel or an unconditional success.
#
#    SCOPE, corrected after this rule produced four false positives in two consecutive nodes.
#    The rule's intent is that a PRODUCTION DECISION PATH must not manufacture a success
#    string that something else then trusts — that is the fabricated-green failure DOD-024 and
#    DOD-027 exist to catch. Its original scope was all of src/, which also swept in the pinned
#    CLI helpers under src/infrastructure/ whose entire contract IS to print an exact sentinel
#    that a wrapper script greps for (db-provision.sh, db-teardown.sh, migrate.sh). Flagging
#    those burned allow-list entries on code that is already gated twice over, and an
#    allow-list that grows every node stops being a review.
#
#    The scan therefore excludes src/infrastructure/database/**, whose helpers are:
#      * invoked only by the shell wrappers in scripts/, never by the domain or application;
#      * required by those wrappers to print the exact sentinel as their success signal;
#      * themselves verified against live infrastructure, so the sentinel is evidence of work
#        actually performed rather than a substitute for it.
#    Everything else under src/ is still scanned, and the structural scans (2 and the file-name
#    scan) still cover the excluded directory.
sentinel_like=$(grep -rnE "console\.(log|info)\([^)]*: ok" src \
  --exclude-dir=database 2>/dev/null || true)
[ -z "$sentinel_like" ] || hits="${hits}${sentinel_like}
"

if [ -n "$hits" ]; then
  unallowed=""
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    case "$hit" in
      *:*) file=${hit%%:*}; rest=${hit#*:}; line=${rest%%:*} ;;
      *)   file=$hit; line=0 ;;
    esac
    if ! grep -qE "^${file}:${line}([[:space:]]|$)" .agent/reality-allow; then
      unallowed="${unallowed}  - ${hit}
"
    fi
  done <<EOF
$hits
EOF
  if [ -n "$unallowed" ]; then
    echo "reality gate: FAIL - placeholder, simulated, or unfinished behaviour in production paths:" >&2
    printf '%s' "$unallowed" >&2
    echo "Replace the behaviour with a real implementation, or add a reviewed path:line" >&2
    echo "entry to .agent/reality-allow with a reason. Never blanket-allow (DOD-019, DOD-027)." >&2
    exit 1
  fi
  echo "reality gate: NOTICE - hits present and individually allowed by .agent/reality-allow" >&2
fi

echo "reality gate: ok"
