#!/usr/bin/env sh
# Postal provider readiness probe (LOB_API_KEY | CLICK2MAIL_API_KEY | POSTGRID_API_KEY).
#
# SPEC BASIS. PREFLIGHT.md declares this probe for the postal credentials and 6Layer-MasterPrompt line 882 requires
# readiness probes to be real ("Any started service is probed, never assumed"). The contract - three outcomes, never
# print a value, be discriminating - is declared in scripts/lib/loud-fail.sh and COMMANDS.md (EP-010 M20/M23).
#
# WHICH PROVIDER IS PROBED, AND WHY THAT IS A DECISION RATHER THAN A GUESS. This one probe serves THREE declared
# credentials, and the executor maps a postal id onto whichever is present, so the dispatch has to be stated:
#
#   * LOB        -> https://api.lob.com/v1/us_verifications is RECORDED in this repository
#                   (.agent/evidence/EP-008/induced-failure/provider-transport-attempt.txt line 2), so the transport is
#                   declared and can be tested.
#   * CLICK2MAIL -> NO endpoint is declared anywhere in this repository.
#   * POSTGRID   -> NO endpoint is declared anywhere in this repository.
#
# FOR THE TWO PROVIDERS WITH NO DECLARED TRANSPORT THIS PROBE REPORTS OUTCOME 2 (CANNOT PROBE) AND NAMES THE MISSING
# DECLARATION. An invented host would be a fabricated dependency, and a silent exit 1 would blame the credential for a
# documentation gap. THAT IS THE HONEST ANSWER FOR THE TWO IDS BLOCKED ON CLICK2MAIL_API_KEY: obtaining the key is NOT
# SUFFICIENT until the transport is declared, and this probe says so instead of leaving that to be discovered later.
#
# AND A METHOD DIFFERENCE, STATED RATHER THAN HIDDEN: this probe issues a GET, so a provider that only serves POST on
# the recorded path answers 405. A 405 is reported as REACHABLE-WITHOUT-AN-ENDPOINT-RESULT rather than as a pass on the
# endpoint, which is the same distinction the TypeScript provider-transport probe draws (its declared reachability check
# accepts 405 and refuses 401/403 and 5xx).
set -eu
. "$(dirname "$0")/../lib/loud-fail.sh"

PRESENT=""
EMPTY=""
for NAME in LOB_API_KEY CLICK2MAIL_API_KEY POSTGRID_API_KEY; do
  eval "VALUE=\${${NAME}:-}"
  if [ -n "${VALUE}" ]; then PRESENT="${PRESENT} ${NAME}"; else
    # PRESENT-BUT-EMPTY IS ITS OWN STATE AND IS NOT THE SAME AS UNSET (EP-010 M33, MEASURED). The operator's declared
    # provider file carries CLICK2MAIL_API_KEY with an EMPTY value, and the first version of this dispatch treated that
    # exactly like an unset variable and reported `LOB_API_KEY is unset` - naming a DIFFERENT credential than the one the
    # environment actually declares, which sends the reader to provision something they already have. An empty value is
    # not a credential (config-validate.sh refuses EMPTY_VALUE for the same reason), so this is still outcome 1, and it
    # now says which declared key is EMPTY. Only the NAME is tested, never the value.
    eval "DECLARED=\${${NAME}+set}"
    if [ -n "${DECLARED}" ]; then EMPTY="${EMPTY} ${NAME}"; fi
  fi
done
# Outcome 1 names the FIRST declared credential, so the message is stable and matches PREFLIGHT.md's naming - unless a
# postal credential is present and EMPTY, which is the more specific and more actionable fact.
if [ -z "${PRESENT}" ] && [ -n "${EMPTY}" ]; then
  echo "ERROR: the declared postal credential(s)${EMPTY} are present in the environment with an EMPTY value; an empty value is not a credential, so this probe has nothing to test. NOTE: CLICK2MAIL and POSTGRID additionally have NO transport endpoint declared anywhere in this repository, so obtaining a key is NOT sufficient for them; see PREFLIGHT.md; unblocked by EP-013" >&2
  exit 1
fi
[ -n "${PRESENT}" ] || vg_require_env 'LOB_API_KEY' 'EP-013'

if [ -n "${LOB_API_KEY:-}" ]; then
  # The credential is read INSIDE node and never passed as an argument, so it cannot appear in a process listing, and
  # only the HTTP status crosses back out.
  STATUS=$(node -e '
  (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch("https://api.lob.com/v1/us_verifications", {
        method: "GET",
        headers: { authorization: "Basic " + Buffer.from(String(process.env.LOB_API_KEY ?? "") + ":").toString("base64") },
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
    200|201|204)
      vg_probe_ok 'LOB_API_KEY' "the provider accepted a read-only request to its recorded transport (HTTP ${STATUS})"
      ;;
    405)
      vg_probe_ok 'LOB_API_KEY' 'the recorded transport is reachable and did not refuse the credential (HTTP 405: the path serves another method); this proves reachability, NOT an endpoint-specific result'
      ;;
    401|403)
      echo "ERROR: LOB_API_KEY is present and the provider REFUSED it (HTTP ${STATUS}); provision a key this account accepts, then re-run; see PREFLIGHT.md" >&2
      exit 1
      ;;
    404)
      vg_probe_cannot 'LOB_API_KEY' 'the recorded transport path answered HTTP 404, so this repository records a path the provider does not serve; correct the endpoint before this credential can be tested'
      ;;
    TIMEOUT|UNREACHABLE)
      vg_probe_cannot 'LOB_API_KEY' 'api.lob.com could not be reached from this environment, so the credential could not be tested'
      ;;
    *)
      echo "ERROR: the provider answered HTTP ${STATUS} to a read-only request, which is neither acceptance nor a declared refusal" >&2
      exit 1
      ;;
  esac
fi

for NAME in CLICK2MAIL_API_KEY POSTGRID_API_KEY; do
  eval "VALUE=\${${NAME}:-}"
  if [ -n "${VALUE}" ]; then
    vg_probe_cannot "${NAME}" "the credential is present, but no transport endpoint for this provider is declared anywhere in this repository, so nothing can be reached; declare the endpoint (PREFLIGHT.md, or the provider's own documentation) before this probe can succeed"
  fi
done
