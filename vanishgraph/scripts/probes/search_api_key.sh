#!/usr/bin/env sh
# SEARCH_API_KEY readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS. PREFLIGHT.md declares this probe for SEARCH_API_KEY and classifies the key OPTIONAL; the schema carries the
# same lane. An OPTIONAL key that is unset is therefore a lane fact and is reported as unprovisioned rather than as a
# defect.
#
# WHY THIS PROBE DOES NOT CONTACT A PROVIDER, AND WHY THAT IS THE HONEST ANSWER RATHER THAN AN UNIMPLEMENTED CHECK. A
# search-provider readiness check needs a READ-ONLY endpoint to call, and this repository declares NO endpoint for
# SEARCH_API_KEY anywhere: PREFLIGHT.md declares the key and nothing else, config/environment/required.json names the key
# without one, and no source file reads it. A probe that guessed "https://api.some-provider.com/search" would be testing
# an INVENTED URL and would report a result about a service this deployment never declared - which is exactly the
# fabrication VG-API-059 and DOD-037 forbid, in the same shape the CLICK2MAIL dispatcher already refuses
# (scripts/probes/postal_api.sh: a key with no declared endpoint is outcome 2, not a guessed request).
#
# SO THE OUTCOME IS OUTCOME 2 WHEN THE KEY IS SET: CANNOT PROBE, because this environment cannot host the check at all
# until an endpoint is declared. THE DECLARATION IS THE MISSING ARTEFACT, NOT THE CHECK: when an endpoint is declared for
# this key, this probe becomes a read-only request against it and the change is one case arm.
#
# WHEN THE KEY IS UNSET IT IS OUTCOME 1 (UNPROVISIONED), which is the state this environment is in and which the harness
# can act on: PREFLIGHT.md names the key, so provisioning it is a known action.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'SEARCH_API_KEY' 'EP-013'

vg_probe_cannot 'SEARCH_API_KEY' 'no search-provider endpoint is declared anywhere in this repository (PREFLIGHT.md declares the key alone and no source file reads it), and a probe against a guessed URL would report a result about a service this deployment never declared; declare the endpoint and this probe becomes a read-only request against it'
