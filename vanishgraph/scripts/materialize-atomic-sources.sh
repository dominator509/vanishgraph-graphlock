#!/usr/bin/env sh
# Materialize and verify the immutable atomic security source archive.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
ROOT=.agent/verification
B64="$ROOT/atomic-security-sources.tar.gz.b64"
OUT="$ROOT/source-library/security"
[ -s "$B64" ] || { echo "atomic source library: FAIL - missing archive" >&2; exit 1; }
command -v base64 >/dev/null 2>&1 || { echo "atomic source library: FAIL - base64 is required" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "atomic source library: FAIL - tar is required" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "atomic source library: FAIL - sha256sum is required" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Strip CR before decoding.
#
# DEFECT FIXED HERE: this archive was committed with CRLF line endings, so
# `base64 -d "$B64"` failed with "base64: invalid input" on every platform (the
# committed git blob itself carried CR, not merely a Windows checkout). The payload
# was never corrupt: with CR stripped it decodes to a valid gzip stream and all three
# SHA-256 sums below verify.
#
# Two independent guards now prevent a recurrence:
#   1. `.gitattributes` marks *.b64 as binary (-text) so git never converts it, and
#      the committed file has been normalised to LF.
#   2. This `tr -d '\r'` makes the script correct even if a CRLF copy appears again
#      (a zip download, a Windows editor, an aggressive checkout hook).
# Keeping both is deliberate: the .gitattributes fixes the cause, this fixes the effect.
tr -d '\r' < "$B64" | base64 -d > "$tmp/sources.tar.gz"
tar -tzf "$tmp/sources.tar.gz" >/dev/null
rm -rf "$tmp/unpacked"
mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/sources.tar.gz" -C "$tmp/unpacked"
for name in general-dev-security-testing-prompts.md hipaa-software-dev-security-testing-prompts.md blockchain-security-testing-prompts.md; do
  src="$tmp/unpacked/security/$name"
  [ -s "$src" ] || { echo "atomic source library: FAIL - missing $name" >&2; exit 1; }
done
cat > "$tmp/SHA256SUMS" <<'EOF'
3666d59dd36d3457b802f04ce340d50306925bc4a9d46e2a33fb4ed825df2bc2  security/blockchain-security-testing-prompts.md
559cadaf736319a4f422ade27287407c42d36910d04fb6a0b7031e9c5d40bfde  security/general-dev-security-testing-prompts.md
4b6aa580fd715d6f140d606d491c3e2f0e777fac78a72068b58e3bb269c5043d  security/hipaa-software-dev-security-testing-prompts.md
EOF
(cd "$tmp/unpacked" && sha256sum -c "$tmp/SHA256SUMS") >/dev/null
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$tmp/unpacked/security/"*.md "$OUT/"
for name in general-dev-security-testing-prompts.md hipaa-software-dev-security-testing-prompts.md blockchain-security-testing-prompts.md; do
  test -s "$OUT/$name" || { echo "atomic source library: FAIL - materialization missing $name" >&2; exit 1; }
done
echo "atomic source library: ok"
