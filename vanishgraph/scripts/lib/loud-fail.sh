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
# THE LOUD-FAIL HALF NEVER PRINTS A SUCCESS SENTINEL, AND THE PROBE HALF BELOW DELIBERATELY DOES (EP-010 M20). That
# correction is recorded here because the sentence that used to stand alone in this header - "This helper NEVER prints
# a success sentinel. It has no success path." - was read as a statement about ALL probes, and it was the reason the ten
# readiness probes under scripts/probes/ could not clear a credential blocker: a probe that can never pass makes
# readiness permanently unready, which is as much a defect as a probe that can never fail (SPEC-007 section 7.2 rule 3).

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

# ---------------------------------------------------------------------------------------------------------------
# THE READINESS PROBE CONTRACT (EP-010 M20). PREFLIGHT.md declares one probe per credential; this is what a probe
# means, so that the harness can tell three different situations apart WITHOUT parsing prose.
#
#   0  REACHABLE       vg_probe_ok <NAME> <detail>          prints `<NAME>: ok - <detail>`
#   1  UNPROVISIONED   vg_require_env <VAR> <node>          the existing helper above: the declared variable is unset
#   2  CANNOT PROBE    vg_probe_cannot <NAME> <why>          this environment cannot host the check at all
#
# OUTCOME 1 REUSES `vg_require_env` RATHER THAN A SECOND FUNCTION THAT PRINTS THE SAME SENTENCE. Two copies of one
# message is how a message drifts, and this repository has spent a whole node correcting exactly that.
#
# TWO RULES BIND EVERY PROBE, AND BOTH ARE CHECKED BY THE STAGE THAT RUNS IT:
#   1. IT NEVER PRINTS A VALUE - not the credential, not a connection string, not a token. Only the key's NAME, a
#      reason code and a measured fact. A probe that echoes what it read has leaked it into a log.
#   2. IT IS DISCRIMINATING (SPEC-007 section 7.2 rule 3): it passes with the dependency healthy and fails with it
#      unavailable, on the same code path. A probe that cannot fail is a defect, and so is one that cannot pass.
#
# A PROBE MAY USE OUTCOME 2 ONLY FOR A CHECK THIS ENVIRONMENT CANNOT HOST - a cloud metadata endpoint that does not
# exist here, for instance. "I did not implement the check" is NOT outcome 2; it is a defect, and the honest place for
# it is the ledger as a blocker rather than a probe that reports an environment problem.
# ---------------------------------------------------------------------------------------------------------------

# vg_probe_ok <NAME> <detail>
vg_probe_ok() {
  echo "${1}: ok - ${2}"
  exit 0
}

# vg_probe_cannot <NAME> <why>
vg_probe_cannot() {
  echo "ERROR: the ${1} probe cannot run in this environment: ${2}" >&2
  exit 2
}
