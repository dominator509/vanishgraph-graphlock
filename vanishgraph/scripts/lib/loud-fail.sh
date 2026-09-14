#!/usr/bin/env sh
# Shared loud-fail helper for pre-discovery placeholder gates.
#
# SPEC BASIS: GRAPHLOCK_v3_1_FAILURE_PROOF/6Layer-MasterPrompt-v3.1-GRAPHLOCK-FAILURE-PROOF.md
# Section 10 "Scripts", line 1357:
#
#   "For an existing/unknown repo where a real command is genuinely unknowable
#    pre-discovery, the script fails loudly ("ERROR: replaced during EP-000 discovery
#    milestone M<k>; see .agent/execplans/EP-000..." >&2; exit 1) and EP-000 contains
#    the exact milestone that replaces it with evidence -- placeholder scripts never
#    pass silently, and for greenfield there are no placeholders at all."
#
# This file implements the loud-fail half of that contract. It exists so that all
# placeholder gates fail with one identical, greppable, spec-mandated signature.
#
# This helper NEVER prints a success sentinel. It has no success path.

# vg_loud_fail <script-path> <unblock-node>
vg_loud_fail() {
  _vg_stage=$1
  _vg_unblock=$2
  echo "ERROR: ${_vg_stage} is an unimplemented placeholder; replaced during EP-000 discovery milestone M1; see .agent/execplans/EP-000-node.md; unblocked by ${_vg_unblock}" >&2
  exit 1
}

# vg_require_env <VAR> <unblock-node>
# Fails loudly when a PREFLIGHT-declared credential is absent. Never invents a value.
vg_require_env() {
  _vg_var=$1
  _vg_unblock=$2
  eval "_vg_val=\${${_vg_var}:-}"
  if [ -z "${_vg_val}" ]; then
    echo "ERROR: ${_vg_var} is unset; see PREFLIGHT.md and .env.example; provision it then re-run; unblocked by ${_vg_unblock}" >&2
    exit 1
  fi
}

# vg_require_file <path> <unblock-node>
vg_require_file() {
  _vg_path=$1
  _vg_unblock=$2
  if [ ! -s "${_vg_path}" ]; then
    echo "ERROR: required file ${_vg_path} is missing or empty; unblocked by ${_vg_unblock}" >&2
    exit 1
  fi
}
