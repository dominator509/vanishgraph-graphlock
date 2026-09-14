#!/usr/bin/env sh
# Toolchain gate for EP-000. Sentinel: `gate-toolchain: ok`
#
# This gate asserts the things EP-000 is actually responsible for: that the
# toolchain is present and locked, that the code is well-formed, and — most
# importantly — that no script in this repository can print a success sentinel from
# a path that performs no check.
#
# That last assertion is the one that matters. Before EP-000, 35 scripts printed
# unconditional success sentinels, so every gate reported green against an empty
# repository. AGENTS.md names this condition directly: "Software that appears to
# work is a failure state."
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "gate-toolchain: FAIL - $1" >&2; exit 1; }

# 1. Node major version.
command -v node >/dev/null 2>&1 || fail "node not found"
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || fail "node >= 24 required, found $(node --version)"

# 2. Locked dependency state.
[ -f package-lock.json ] || fail "package-lock.json missing; dependencies are not locked"
[ -d node_modules ] || fail "node_modules missing; run npm ci"

# 3. The code type-checks under the strict configuration.
npx --no-install tsc --noEmit || fail "tsc --noEmit reported errors"

# 4. Every shell script is POSIX-parseable (sh -n). A script that cannot parse
#    cannot fail honestly; it may also fail to run at all in CI.
syntax_failures=""
for f in $(find scripts -type f -name '*.sh' | sort); do
  if ! sh -n "$f" 2>/dev/null; then
    syntax_failures="${syntax_failures}  - ${f}
"
  fi
done
[ -z "$syntax_failures" ] || {
  echo "gate-toolchain: FAIL - shell scripts failing 'sh -n':" >&2
  printf '%s' "$syntax_failures" >&2
  exit 1
}

# 5. No hollow success sentinel. A script is hollow when the only executable
#    statements it contains are echo/printf — i.e. it prints something and does no
#    work. That is exactly the fabrication pattern this gate exists to catch.
#
#    The detector is deliberately precise rather than a keyword heuristic: an
#    earlier version flagged real scripts such as preflight.sh (which assigns
#    `node_major=$(node -p ...)` and runs `command -v`) and materialize-atomic-
#    sources.sh (which runs base64/tar/sha256sum). A gate that accuses correct
#    scripts of being fake is itself broken, so this version classifies every
#    non-comment line and only reports a script when nothing is left but printing.
hollow=""
for f in $(find scripts -type f -name '*.sh' | sort); do
  case "$f" in
    */lib/*) continue ;;   # helper libraries intentionally contain no sentinel
  esac
  # Only scripts that actually print a success sentinel are in scope.
  if ! grep -qE "^[[:space:]]*echo[[:space:]]+\"[^\"]*: (ok|accounted)\"" "$f"; then
    continue
  fi

  # Strip shebang, comments, blank lines, and lines that are pure scaffolding.
  # What remains is the set of "statements" the script executes.
  statements=$(grep -vE "^[[:space:]]*(#|$)" "$f" \
    | grep -vE "^#!" \
    | grep -vE "^[[:space:]]*set[[:space:]]" \
    | grep -vE "^[[:space:]]*export[[:space:]]" \
    | grep -vE "^[[:space:]]*cd[[:space:]]" \
    | grep -vE "^[[:space:]]*(echo|printf)[[:space:]]" \
    | grep -vE "^[[:space:]]*(fi|done|esac|else|\}|then|do)[[:space:]]*$" \
    || true)

  if [ -z "$statements" ]; then
    hollow="${hollow}  - ${f}
"
  fi
done
[ -z "$hollow" ] || {
  echo "gate-toolchain: FAIL - the following scripts print a success sentinel but perform no check:" >&2
  printf '%s' "$hollow" >&2
  echo "A gate that cannot fail is a fabrication defect (DOD-024, DOD-027)." >&2
  exit 1
}

# 6. The domain layer imports only the standard library (ARCHITECTURE.md code law).
sh scripts/import-boundary.sh >/dev/null 2>&1 || fail "domain import boundary violated; run sh scripts/import-boundary.sh"

echo "gate-toolchain: ok"
