#!/usr/bin/env sh
# GITHUB_APP_ID readiness probe -- PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# SPEC BASIS: PREFLIGHT.md declares this probe for the named credential.
# 6Layer-MasterPrompt line 882 requires readiness probes to be real:
#   "Any started service is probed, never assumed: loop up to N times ...
#    against an exact readiness command".
#
# ORIGINAL DEFECT (corrected here): this probe printed 'probe ok' without
# reading the credential, contacting the service, or verifying anything. It
# reported readiness for a dependency that may not exist.
#
# This guard checks only that GITHUB_APP_ID is present, then fails loudly. It does
# NOT assert reachability -- that is the EP-000 M1 discovery implementation.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'GITHUB_APP_ID' 'EP-013'
vg_loud_fail 'GITHUB_APP_ID probe' 'EP-013'
