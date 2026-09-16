#!/usr/bin/env sh
# Secret-scanning gate. Sentinel: `secret scan: ok`
#
# WHAT IT SCANS AND WHY THOSE PLACES. A committed credential is the one defect that cannot be fixed by a later commit:
# it is in the history, in every clone, and in whatever mirrored the repository. So the scan covers the whole tracked
# tree rather than the source directories — an `.env` file, a CI workflow, a fixture and a documentation example are all
# places a credential has actually been committed in real projects — and it excludes only the lockfile, where hashes are
# not credentials, and this script, which necessarily contains the patterns it looks for.
#
# IT FAILS CLOSED. A finding exits non-zero with the file and line, and prints no sentinel. A scan that read no files is
# also a failure: "no findings" and "nothing scanned" must not look the same (DOD-024).
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
cd "$(dirname "$0")/.."

fail() { echo "secret scan: FAIL - $1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required to enumerate the tracked tree"

files=$(git ls-files | grep -vE '^(package-lock\.json|pnpm-lock\.yaml|scripts/secret-scan\.sh)$' || true)
[ -n "$files" ] || fail "no tracked files were enumerated, so the scan would prove nothing"

count=0
for f in $files; do
  [ -f "$f" ] || continue
  count=$((count + 1))
done
[ "$count" -gt 50 ] || fail "only $count files were readable; refusing to report a clean scan over a tree this small"

# The patterns. Each is a shape that is a credential rather than a hash or an example:
#   * a private key header;
#   * an AWS access key id;
#   * a JSON Web Token (three base64url segments) — a real token, not a placeholder;
#   * an assignment of a non-empty, non-placeholder value to a name that says secret/password/token/key.
# TWO QUOTING NOTES, BOTH MEASURED. The pattern is in DOUBLE quotes so that a single quote inside the character class
# (`[\"']?`, for an assignment whose value is quoted either way) does not terminate the string — MEASURED: the first
# version used single quotes with a shell dance around that character, and a reader (the self-test in
# `tests/security/secret-scan-self-test.test.ts`) could not extract the pattern without truncating it. And the whitespace
# class is the POSIX spelling because `grep -E` needs it; the self-test translates that ONE construct for JavaScript and
# asserts no other POSIX class appears.
PATTERNS="-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|CLIENT_SECRET)[[:space:]]*[:=][[:space:]]*[\"']?[A-Za-z0-9/+_-]{12,}"

hits=$(grep -nIE "$PATTERNS" $files 2>/dev/null | grep -vE '(example|EXAMPLE|placeholder|PLACEHOLDER|SENTINEL|sentinel|redacted|REDACTED|<[A-Z_]+>|\$\{|\$\(|xxx|XXX|your-|YOUR_)' || true)

if [ -n "$hits" ]; then
  echo "secret scan: FAIL - a credential-shaped value is committed:" >&2
  echo "$hits" | head -n 20 >&2
  echo "" >&2
  echo "SPEC-006 §8 and SECURITY.md: a committed credential is in the history, every clone and every mirror." >&2
  echo "Remove the value, rotate it, and add the file to .gitignore if it should never have been tracked." >&2
  exit 1
fi

echo "secret scan: $count file(s) scanned, 0 findings"
echo "secret scan: ok"
