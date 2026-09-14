#!/usr/bin/env sh
# STRIPE_SECRET_KEY readiness probe -- PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
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
# This guard checks only that STRIPE_SECRET_KEY is present, then fails loudly. It does
# NOT assert reachability -- that is the EP-000 M1 discovery implementation.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'STRIPE_SECRET_KEY' 'EP-013'
vg_loud_fail 'STRIPE_SECRET_KEY probe' 'EP-013'
