#!/usr/bin/env sh
# EP-001 node gate. Sentinel: `gate-foundation: ok`
#
# This is the node-level verify for EP-001. It proves the foundation by running every
# real gate and requiring its exact sentinel, and by proving two negative properties
# that a green suite cannot prove on its own:
#
#   * the collection guard FAILS on an empty collection (DOD-007);
#   * sh scripts/verify.sh advances through the implemented stages and stops at the
#     first unimplemented one with the mandated loud-fail ERROR line, and provably
#     does NOT print `verify: ok`.
#
# `verify.sh` itself keeps the full fifteen-stage order mandated by the master prompt
# (section 10 Scripts, line 1357). Nothing here removes, reorders, or exempts a stage;
# the last five stages require a built artifact (EP-009/EP-010), which is exactly why
# this node's verify is a node-scoped gate and not `verify: ok`.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-foundation: FAIL - $1" >&2; exit 1; }

mkdir -p .agent/evidence/EP-001
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0

# require_sentinel <sentinel> <command...>
require_sentinel() {
  sentinel=$1
  shift
  if ! out=$("$@" 2>&1); then
    echo "gate-foundation: FAIL - command failed: $*" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
  printf '%s\n' "$out" | grep -qxF "$sentinel" \
    || fail "expected sentinel '$sentinel' as the last line of: $*"
}

# 1. Toolchain and locked dependency state.
command -v node >/dev/null 2>&1 || fail "node is required but not found"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "node >= 24 is required, found $(node --version)"
[ -f package-lock.json ] || fail "package-lock.json is missing; the dependency set is not locked"
[ -d node_modules ] || fail "node_modules is missing; run npm ci"

# 2. Every shell script is POSIX-parseable.
for f in $(find scripts -type f -name '*.sh' | sort); do
  sh -n "$f" || fail "sh -n failed for $f"
done
echo "gate-foundation: sh -n ok for $(find scripts -type f -name '*.sh' | wc -l | tr -d ' ') scripts"

# 3. No script prints a success sentinel from a path that performs no check.
hollow=""
for f in $(find scripts -type f -name '*.sh' | sort); do
  case "$f" in */lib/*) continue ;; esac
  grep -qE '^[[:space:]]*echo[[:space:]]+"[^"]*: ok"' "$f" || continue
  statements=$(grep -vE '^[[:space:]]*(#|$)' "$f" \
    | grep -vE '^#!' \
    | grep -vE '^[[:space:]]*set[[:space:]]' \
    | grep -vE '^[[:space:]]*export[[:space:]]' \
    | grep -vE '^[[:space:]]*cd[[:space:]]' \
    | grep -vE '^[[:space:]]*(echo|printf)[[:space:]]' \
    | grep -vE '^[[:space:]]*(fi|done|esac|else|\}|then|do)[[:space:]]*$' || true)
  [ -n "$statements" ] || hollow="${hollow}  - ${f}
"
done
[ -z "$hollow" ] || {
  echo "gate-foundation: FAIL - scripts that print a success sentinel but do no work:" >&2
  printf '%s' "$hollow" >&2
  exit 1
}

# 4. Working tree hygiene: dist/ and node_modules/ are not tracked.
node -e '
  const { spawnSync } = require("node:child_process");
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).stdout ?? "";
  const bad = tracked.split("\n").filter((p) => p.startsWith("node_modules/") || p.startsWith("dist/"));
  if (bad.length > 0) {
    console.error("gate-foundation: FAIL - build or dependency output is tracked: " + bad.slice(0, 5).join(", "));
    process.exit(1);
  }
' || exit 1

# 5. Every real gate, with its exact sentinel.
require_sentinel 'preflight: ok'               sh scripts/preflight.sh
require_sentinel 'typecheck: ok'               sh scripts/typecheck.sh
require_sentinel 'import boundary: ok'         sh scripts/import-boundary.sh
require_sentinel 'lint: ok'                    sh scripts/lint.sh
require_sentinel 'format-check: ok'            sh scripts/format-check.sh
require_sentinel 'env validation: ok'          sh scripts/validate-env.sh
require_sentinel 'test-unit: ok'               sh scripts/test-unit.sh
require_sentinel 'reality gate: ok'            sh scripts/reality-gate.sh
require_sentinel 'build: ok'                   sh scripts/build.sh
[ -s .agent/evidence/build/domain-artifact.sha256 ] \
  || fail "build.sh printed its sentinel but produced no artifact digest"

# 6. Collection guard: positive result, then the negative proof (DOD-007).
require_sentinel 'test collection guard: ok' sh scripts/test-collection-guard.sh

empty_dir=$(mktemp -d)
if VG_TEST_GLOB="${empty_dir}/**/*.test.ts" sh scripts/test-collection-guard.sh \
     >"$tmp/empty-guard.txt" 2>&1; then
  fail "the collection guard exited 0 on an empty collection (DOD-007 violated)"
fi
grep -q 'zero tests were collected' "$tmp/empty-guard.txt" \
  || fail "the empty-collection failure used an unexpected message; see $tmp/empty-guard.txt"
if grep -q 'test collection guard: ok' "$tmp/empty-guard.txt"; then
  fail "the collection guard printed its sentinel on a failed run"
fi
echo "gate-foundation: zero-collection negative proof ok"

# 7. verify.sh progression proof. Non-zero exit is REQUIRED here.
progression=.agent/evidence/EP-001/verify-progression.txt
if sh scripts/verify.sh >"$progression" 2>&1; then
  fail "verify.sh exited 0 although stages remain uncompletable in this environment; a pass here is a fabrication (DOD-027)"
fi
grep -q 'verify: running stage preflight' "$progression"   || fail "verify.sh did not reach preflight"
grep -q 'verify: running stage unit' "$progression"        || fail "verify.sh did not reach the unit stage"
grep -q 'preflight: ok' "$progression"                     || fail "preflight sentinel missing from the verify transcript"
grep -q 'lint: ok' "$progression"                          || fail "lint sentinel missing from the verify transcript"
grep -q 'format-check: ok' "$progression"                  || fail "format-check sentinel missing from the verify transcript"
grep -q 'typecheck: ok' "$progression"                     || fail "typecheck sentinel missing from the verify transcript"
grep -q 'test-unit: ok' "$progression"                     || fail "test-unit sentinel missing from the verify transcript"
grep -q 'verify: running stage integration' "$progression" || fail "verify.sh did not reach the integration stage"
grep -q 'verify: running stage security-check' "$progression" \
  || fail "verify.sh did not advance past integration (security-check is implemented since EP-006)"
grep -q '^build: ok' "$progression"                       || fail "build sentinel missing from the verify transcript"
# RESTATED after EP-006/EP-009/EP-010. The assertion below used to expect the run to stop
# at security-check with the loud-fail placeholder signature. That was correct while
# security-check was unimplemented and is now obsolete: EP-006 implemented it as a real
# gate, and every stage after build (artifact-identity, smoke, e2e, live-fire) is
# implemented too. Keeping the old assertion would fail this gate for real progress, and
# deleting it without replacement would silently drop the property it protected. The
# property is kept, restated against what the run can actually complete: it must advance
# through every stage that can complete in this environment, stop at the FIRST stage it
# cannot, fail LOUDLY with that stage's named reason (never silently, never with a
# placeholder signature for a stage that exists), and must still never print `verify: ok`.
# In a fresh checkout the first uncompletable stage is artifact-identity: the recorded
# identity cannot validate a tree it was not recorded for, and the distribution
# artifacts are git-ignored so a fresh clone has none. In the recorded tree with its
# artifacts present, the run advances further and stops loudly at smoke, e2e, or
# live-fire instead. The assertion accepts any of those loud failures, because the
# property is the loud stop, not which stage stops it.
grep -q 'verify: running stage artifact-identity' "$progression" \
  || fail "verify.sh did not advance past build to the artifact-identity stage"
grep -qE '(artifact identity|smoke test|end-to-end tests|live-fire): FAIL' "$progression" \
  || fail "the first uncompletable stage did not fail loudly with its named reason"
if grep -qx 'verify: ok' "$progression"; then
  fail "verify.sh printed its success sentinel while stages remain uncompletable (DOD-024)"
fi
echo "gate-foundation: verify.sh progression ok (stages through build green, first uncompletable stage loud-fails, no verify: ok)"

echo "gate-foundation: ok"
