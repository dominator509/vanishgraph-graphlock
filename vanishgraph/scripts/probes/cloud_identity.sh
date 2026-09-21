#!/usr/bin/env sh
# CLOUD_WORKLOAD_IDENTITY readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS. PREFLIGHT.md declares this probe for CLOUD_WORKLOAD_IDENTITY and classifies the key OPTIONAL;
# config/environment/schema.json gives it the CLOUD_IDENTITY format and the note that a deployment which resolves
# outbound credentials by workload identity instead of a static secret requires it, and that the guard reports it missing
# rather than substituting a static credential (SPEC-006 section 7.1 item 16).
#
# WHY THIS PROBE IS OUTCOME 2 RATHER THAN A REQUEST. A workload identity is RESOLVED BY THE RUNTIME, not by the process
# that holds the reference: on a cloud host the platform exposes a metadata service on a link-local address, and the
# identity is exchanged there for a short-lived credential. THIS HOST HAS NO SUCH SERVICE - it is a Windows workstation
# running Docker Desktop, and no cloud metadata endpoint exists on it - so the only request this probe could make would
# be to an address that does not exist here. That is precisely the case the contract reserves outcome 2 for: "a cloud
# metadata endpoint that does not exist here".
#
# IT DELIBERATELY DOES NOT GUESS AN ENDPOINT. The link-local metadata addresses differ per provider
# (169.254.169.254 for several, a provider-specific one for others), so a probe that picked one would report a result
# about a provider this deployment never declared - the same defect scripts/probes/postal_api.sh refuses for a key with
# no declared endpoint. Declaring the provider and its metadata endpoint is the missing artefact, and it is recorded as
# open work rather than hidden behind a probe that reports an environment problem as a credential problem.
#
# WHEN THE KEY IS UNSET IT IS OUTCOME 1 (UNPROVISIONED), which is the state this environment is in and which the harness
# can act on.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'CLOUD_WORKLOAD_IDENTITY' 'EP-009'

vg_probe_cannot 'CLOUD_WORKLOAD_IDENTITY' 'a workload identity is resolved by the cloud runtime and this host has no metadata service, and the link-local address differs per provider, so there is no declared endpoint for this probe to call; declare the provider and its metadata endpoint and this probe becomes a read-only identity-document request against it'
