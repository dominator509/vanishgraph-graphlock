#!/usr/bin/env sh
set -eu
[ -s .agent/verification/atomic-security-sources.tar.gz.b64 ]
mkdir -p .agent/verification/source-library/security
echo "atomic source library: ok"
