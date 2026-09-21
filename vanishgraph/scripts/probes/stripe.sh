#!/usr/bin/env sh
# STRIPE_SECRET_KEY readiness probe. Sentinel: `<NAME>: ok - <detail>`; contract in scripts/lib/loud-fail.sh.
#
# SPEC BASIS. PREFLIGHT.md declares this probe for this credential, and 6Layer-MasterPrompt line 882 requires readiness
# probes to be real: "Any started service is probed, never assumed: loop up to N times ... against an exact readiness
# command". The probe contract (three outcomes, never print a value, be discriminating) is declared in
# scripts/lib/loud-fail.sh and COMMANDS.md (EP-010 M20).
#
# THE ENDPOINT IS THE ONE THIS REPOSITORY ALREADY ATTEMPTED, NOT AN INVENTED ONE:
# .agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt line 1 records `https://api.stripe.com/v1/balance`,
# which answered HTTP 401 without a credential - that is the induced state SPEC-007 section 7.4 describes. A read-only
# GET of that path is the declared action: it reads a balance, writes nothing, and never touches a form
# (SPEC-000 section 6.7, VG-SCOPE-004).
#
# WHAT EXIT 0 PROVES, AND WHAT IT DOES NOT. It proves the provider ACCEPTED this credential for a read-only call. It does
# NOT prove that any payment flow works, and it is NOT a live-fire proof (SPEC-008 section 7): the entitlement half is
# what is tested here, and the outcome half remains the live-fire stage's.
#
# EXIT 1 COVERS BOTH "UNSET" AND "PRESENT BUT REFUSED", because the harness treats both as one blocker class - blocked on
# this credential - and the two messages tell them apart instead of hiding the difference behind a single code.
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"
vg_require_env 'STRIPE_SECRET_KEY' 'EP-013'

# The credential is read from the environment INSIDE node and never passed as an argument, so it cannot appear in a
# process listing, and only the HTTP status crosses back out.
STATUS=$(node -e '
(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://api.stripe.com/v1/balance", {
      method: "GET",
      headers: { authorization: "Bearer " + String(process.env.STRIPE_SECRET_KEY ?? "") },
      signal: controller.signal,
    });
    process.stdout.write(String(response.status));
  } catch (error) {
    process.stdout.write(error.name === "AbortError" ? "TIMEOUT" : "UNREACHABLE");
  } finally {
    clearTimeout(timer);
  }
})();
' 2>/dev/null || printf 'UNREACHABLE')

case "$STATUS" in
  200)
    vg_probe_ok 'STRIPE_SECRET_KEY' 'the provider accepted a read-only GET /v1/balance (HTTP 200)'
    ;;
  401|403)
    echo "ERROR: STRIPE_SECRET_KEY is present and the provider REFUSED it (HTTP ${STATUS}); provision a key this account accepts, then re-run; see PREFLIGHT.md" >&2
    exit 1
    ;;
  TIMEOUT)
    vg_probe_cannot 'STRIPE_SECRET_KEY' 'the provider did not answer within 8000 ms, so the credential could not be tested; a slow or blocked network is not a refused credential'
    ;;
  UNREACHABLE)
    vg_probe_cannot 'STRIPE_SECRET_KEY' 'api.stripe.com is unreachable from this environment (DNS or egress), so the credential could not be tested'
    ;;
  *)
    echo "ERROR: the provider answered HTTP ${STATUS} to a read-only GET /v1/balance, which is neither acceptance nor a declared refusal" >&2
    exit 1
    ;;
esac
