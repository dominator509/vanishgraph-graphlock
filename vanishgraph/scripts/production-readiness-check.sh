#!/usr/bin/env sh
# production-readiness-check.sh -- PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# Implemented command (declared in COMMANDS.md):
#   sh scripts/production-readiness-check.sh
# Governing sentinel: production-readiness: accounted
#
# SPEC BASIS: 6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md, Section 10
# "Scripts", line 1357:
#
#   "production-readiness-check.sh initializes/resumes the Section 16 verification
#    subgraph, runs harness-validate, runs dod-gate, and emits a release verdict.
#    ... A verification stage command exits successfully when accounting completed,
#    even if candidate tests recorded FAIL; the final release gate exits nonzero for
#    NO_GO/INCONCLUSIVE."
#
# ORIGINAL DEFECT (corrected here): this script printed
# "production-readiness: accounted" unconditionally, with no check of any kind.
# It asserted that production readiness had been "accounted" while performing no
# accounting whatsoever, and exited 0.
#
# SEMANTIC TRAP THIS GUARD AVOIDS: per the spec line above, the real script is
# allowed to exit 0 *when accounting completed* -- even if candidate tests FAIL.
# A naive implementation could print the success sentinel here and look correct.
# That is exactly the false green being removed. This placeholder must NOT exit 0
# until the Section 16 subgraph (V-000..V-021), harness-validate and dod-gate are
# genuinely implemented and the release verdict is real.
#
# DO NOT replace this with an echo of the sentinel. The real implementation binds
# to the verification subgraph materialized in EP-000 milestone M1 and completed
# in EP-010.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
. "$(dirname "$0")/lib/loud-fail.sh"
vg_loud_fail 'production-readiness check' 'EP-010'
