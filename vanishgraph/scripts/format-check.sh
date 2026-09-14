#!/usr/bin/env sh
# Format check stage. Sentinel: `format-check: ok`
#
# Replaces the pre-discovery loud-fail placeholder (EP-001 milestone M2).
#
# Scope: files this project authors plus the root JSON configuration. Pack-authored
# narrative documents and the vendored verification source library are out of scope,
# and the scope is computed rather than listed, so the exclusion set cannot grow
# silently.
#
# The check is deliberately dependency-free: the repository's only devDependencies are
# typescript and @types/node, and adding a formatter would add supply-chain surface for
# a property that is checkable with POSIX tools. It fails on: CRLF line endings, a
# UTF-8 BOM, trailing whitespace, tab characters, a missing final newline, and JSON
# files that do not parse.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "format-check: FAIL - $1" >&2; exit 1; }

[ -d src ] || fail "src/ is missing"
[ -d tests ] || fail "tests/ is missing"
[ -d scripts ] || fail "scripts/ is missing"

# Files in scope: everything this project authors, plus the root JSON configuration.
files=$(find src tests scripts -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.sh' -o -name '*.py' \) -print | sort)
for j in *.json; do
  [ -f "$j" ] && files="${files}
${j}"
done

# A check that matched nothing would pass vacuously. Refuse to be vacuous.
[ -n "$files" ] || fail "the format scope matched no files; the check would be vacuous"

cr=$(printf '\r')
tab=$(printf '\t')
violations=""

for f in $files; do
  [ -f "$f" ] || continue
  case "$f" in
    node_modules/*|dist/*) continue ;;
  esac
  if [ "$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')" = "efbbbf" ]; then
    violations="${violations}  - ${f}: UTF-8 BOM present
"
  fi
  if grep -q "$cr" "$f" 2>/dev/null; then
    violations="${violations}  - ${f}: CRLF line ending (normalize to LF)
"
  fi
  if grep -q '[[:space:]]$' "$f" 2>/dev/null; then
    violations="${violations}  - ${f}: trailing whitespace
"
  fi
  if grep -q "$tab" "$f" 2>/dev/null; then
    violations="${violations}  - ${f}: tab character (this project indents with spaces)
"
  fi
  if [ -n "$(tail -c 1 "$f")" ]; then
    violations="${violations}  - ${f}: missing final newline
"
  fi
done

if [ -n "$violations" ]; then
  echo "format-check: FAIL - formatting violations:" >&2
  printf '%s' "$violations" >&2
  echo "Fix the files listed above. Do not add them to an exemption list to obtain a pass (DOD-027)." >&2
  exit 1
fi

# JSON configuration must parse. This catches a truncated or hand-edited lockfile,
# which would otherwise fail much later inside npm with a confusing message.
for j in *.json; do
  [ -f "$j" ] || continue
  node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "$j" \
    || fail "${j} is not valid JSON"
done

echo "format-check: ok"
