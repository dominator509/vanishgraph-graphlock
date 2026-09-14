#!/usr/bin/env sh
# installation -- PRE-DISCOVERY LOUD-FAIL PLACEHOLDER.
#
# Implemented command (declared in COMMANDS.md): sh scripts/install.sh
#
# SPEC BASIS: 6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md, Section 10
# "Scripts", line 1357: placeholder scripts never pass silently. A script that
# prints a success sentinel without running the real check is a fabrication
# defect under DOD-024 (failure masking) and DOD-027 (fabricated success).
#
# ORIGINAL DEFECT (corrected here): this script previously printed a success
# sentinel unconditionally, with no check of any kind. It is replaced by this
# loud-fail guard so the gate can no longer report a false green.
#
# DO NOT replace this with an echo of the sentinel. The real implementation
# binds to the toolchain chosen in EP-000 milestone M1.
set -eu
export CI=true GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat PAGER=cat DEBIAN_FRONTEND=noninteractive
. "$(dirname "$0")/lib/loud-fail.sh"
vg_loud_fail 'installation' 'EP-009'
