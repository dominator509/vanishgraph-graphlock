#!/usr/bin/env sh
# Test-double boundary guard (DOD-010, DOD-019, DOD-020; EP-007 M6). Sentinel: `double boundary guard: ok`
#
# THE RULE IT ENFORCES is `TESTING.md`'s "Test-double zone": doubles live under `tests/**` and nowhere else, and
# `src/**` must contain no double of any kind, because a double in a production path is DOD-020 — an adapter that looks
# real and is not.
#
# THE ALLOWLIST IS WRITTEN TO A FILE AND ITS PATH IS PASSED, AND THAT IS THIS GUARD'S SECOND IMPLEMENTATION. MEASURED,
# and it is why the first one was withdrawn in round 92: passing the two entries as a multi-line argument inside a
# double-quoted shell variable left the wrapper recording "allowlist entries: 2" while the scan reported "all 0
# explained by an allowlist entry" — two halves of ONE invocation disagreeing about the same value — and the guard then
# printed its sentinel with a fabricated adapter present under `src/**`. The node scan was proven correct on its own (it
# found the probe), so what changed is the boundary: the allowlist now travels as a path, one token, no newlines and
# nothing to split, and the guard refuses when the scan's own count disagrees with the one it wrote.
#
# WHAT IT CHECKS, AND WHAT IT CANNOT: `src/**` must not import `tests/**`, and must not DECLARE an identifier shaped
# like a double (`InMemory…`, `Fake…`, `Stub…`, `Mock…`, `Simulated…`, `Double…`, `Dummy…`) except where the allowlist
# gives a reason. The limit is a NAME scan — a double named something ordinary is invisible to it — and the scan prints
# that limit with its result rather than leaving it implied.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

EVIDENCE=.agent/evidence/doubles
SCAN=scripts/lib/doubles-scan.mjs
ALLOWLIST="$EVIDENCE/allowlist.txt"
mkdir -p "$EVIDENCE"

fail() { echo "double boundary guard: FAIL - $1" >&2; exit 1; }
error() { echo "double boundary guard: ERROR - $1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || error "node is required but not found"
command -v rg >/dev/null 2>&1 || error "ripgrep (rg) is required by this scan and was not found"
[ -f "$SCAN" ] || error "$SCAN is missing; the scan is this guard's implementation"

# file|symbol|reason — one file, one symbol, one reason each. No wildcards by construction.
{
  echo "# Every entry names ONE file and ONE symbol with the reason it is acceptable there."
  echo "src/adapters/coordination/rate-limit.ts|InMemoryRateLimitCounter|the in-process rate-limit counter EP-006 M6 kept deliberately: it is the only counter implementation in this repository, every suite that asserts limiting uses it, and the durable store it would be replaced by (VALKEY_URL) is BLOCKED_CREDENTIALS. It is the real implementation of a per-process limit, not a double, and the bound it carries is recorded in the row naming VALKEY_URL."
  echo "src/domain/ports/authority-repository.ts|InMemoryAuthorityGrantRepository|the port's own contract double, declared BESIDE the port so tests/contract can assert the port's shape without a database. No production path constructs it, which the EP-006 M10 Postgres adapter and the import scan below both establish."
} >"$ALLOWLIST"

entries=$(grep -c '^src/' "$ALLOWLIST" || true)
[ "$entries" -ge 1 ] || error "the allowlist was written with no entries; refusing to scan with an empty waiver list"

echo "double boundary guard - $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$EVIDENCE/run.txt"
echo "allowlist: $ALLOWLIST ($entries entries)" >>"$EVIDENCE/run.txt"
echo "guard-side entry count: $entries"

set -f
if out=$(node "$SCAN" "$ALLOWLIST" 2>&1); then
  status=0
else
  status=$?
fi
set +f

printf '%s\n' "$out" >>"$EVIDENCE/run.txt"
printf '%s\n' "$out"
[ "$status" -eq 0 ] || fail "the scan reported findings (exit $status): a double-shaped symbol exists under src/** without a justified allowlist entry, or an allowlist entry no longer matches"

case "$out" in
  *"all $entries explained"*) ;;
  *) fail "the scan's allowlist count does not agree with this guard's ($entries); two halves of one invocation must not disagree about the waiver list" ;;
esac

echo "double boundary guard: ok"
